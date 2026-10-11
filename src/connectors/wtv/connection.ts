import { LogLevel } from '../../config.ts'
import { ChannelName, ChatMessage, MessageId, UserId } from '../types.ts'
import { myLog } from '../../utils.ts'
import { WsChatMsgData } from './schema.ts'
import { type } from 'arktype'

export const WTV_USER_AGENT =
  'Mozilla/5.0 (X11; Linux x86_64; rv:153.0) Gecko/20100101 Firefox/153.0'

const WTV_WS_URL = 'wss://edge.ivschat.eu-central-1.amazonaws.com/'

export const WTV_SILENCE_TIMEOUT_MS = 30_000
const CONNECT_TIMEOUT_MS = 10_000

type MessageHandler = (msg: ChatMessage) => void
type OpenHandler = () => void
type CloseHandler = () => void
type SilenceHandler = () => void

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

export function wtvChatMessage(
  channel: ChannelName,
  data: typeof WsChatMsgData.infer,
): ChatMessage {
  return {
    id: data.messageId as MessageId,
    user: {
      id: data.sender.userId as UserId,
      displayName: data.sender.nickname,
      wtvFields: {
        nicknameColor: data.sender.nicknameColor ?? '',
        tags: data.sender.tags ?? [],
      },
    },
    timestampMs: new Date(data.createdAt).getTime(),
    text: data.content,
    server: 'wtv',
    channel,
  }
}

export class WtvChatConnection {
  websocket: WebSocket | null = null

  channel: ChannelName
  private onMessage: MessageHandler
  private onOpen: OpenHandler
  private onClose: CloseHandler
  private onSilence: SilenceHandler
  private silenceTimeoutMs: number

  private silenceTimer: ReturnType<typeof setTimeout> | null = null
  private connectTimer: ReturnType<typeof setTimeout> | null = null
  private notifiedClose = false
  lastInboundAt = 0

  constructor(
    channel: ChannelName,
    onMessage: MessageHandler,
    onOpen: OpenHandler,
    onClose: CloseHandler,
    onSilence: SilenceHandler,
    silenceTimeoutMs = WTV_SILENCE_TIMEOUT_MS,
  ) {
    this.channel = channel
    this.onMessage = onMessage
    this.onOpen = onOpen
    this.onClose = onClose
    this.onSilence = onSilence
    this.silenceTimeoutMs = silenceTimeoutMs
  }

  log(level: LogLevel, ...msgs: unknown[]) {
    myLog(level, '[wtv]', ...msgs)
  }

  get readyState(): number {
    return this.websocket?.readyState ?? WebSocket.CLOSED
  }

  isClosed(): boolean {
    return this.websocket === null
  }

  isSilent(now = Date.now()): boolean {
    return this.readyState === WebSocket.OPEN &&
      now - this.lastInboundAt >= this.silenceTimeoutMs
  }

  noteActivity(now = Date.now()) {
    this.lastInboundAt = now
    this.armSilenceTimer()
  }

  async connect(token: string): Promise<boolean> {
    const ws = new WebSocket(WTV_WS_URL, token)
    this.websocket = ws

    return await new Promise((resolve) => {
      let settled = false
      const finish = (ok: boolean) => {
        if (settled) return
        settled = true
        if (this.connectTimer !== null) {
          clearTimeout(this.connectTimer)
          this.connectTimer = null
        }
        resolve(ok)
      }

      this.connectTimer = setTimeout(() => {
        this.log(
          LogLevel.DEBUG,
          `Connection to ${this.channel} timed out`,
        )
        finish(false)
        this.close()
      }, CONNECT_TIMEOUT_MS)

      ws.onopen = () => {
        if (this.websocket !== ws) return
        this.log(LogLevel.DEBUG, `Connection opened for ${this.channel}`)
        this.noteActivity()
        this.onOpen()
        finish(true)
      }
      ws.onmessage = (event) => {
        if (this.websocket !== ws) return
        this.noteActivity()
        this.handleMessage(event)
      }
      ws.onclose = () => {
        if (this.notifiedClose) return
        this.notifyClose()
        finish(false)
      }
      ws.onerror = (error) => {
        this.log(
          LogLevel.DEBUG,
          `Connection error for ${this.channel}: ${JSON.stringify(error)}`,
        )
      }
    })
  }

  private armSilenceTimer() {
    if (this.silenceTimer !== null) {
      clearTimeout(this.silenceTimer)
    }
    this.silenceTimer = setTimeout(() => {
      this.silenceTimer = null
      if (this.notifiedClose) return
      this.log(
        LogLevel.DEBUG,
        `No websocket frames for ${this.channel} in ${this.silenceTimeoutMs}ms, reconnecting`,
      )
      this.onSilence()
    }, this.silenceTimeoutMs)
  }

  private clearSilenceTimer() {
    if (this.silenceTimer !== null) {
      clearTimeout(this.silenceTimer)
      this.silenceTimer = null
    }
  }

  private notifyClose() {
    if (this.notifiedClose) return
    this.notifiedClose = true
    this.clearSilenceTimer()
    if (this.connectTimer !== null) {
      clearTimeout(this.connectTimer)
      this.connectTimer = null
    }
    this.websocket = null
    this.log(LogLevel.DEBUG, `Connection closed for ${this.channel}`)
    this.onClose()
  }

  handleMessage(event: MessageEvent) {
    if (!event.data) {
      return
    }
    if (typeof event.data !== 'string') {
      this.log(
        LogLevel.DEBUG,
        `Received non-string message: ${JSON.stringify(event.data)}`,
      )
      return
    }

    let jsonData: unknown
    try {
      jsonData = JSON.parse(event.data)
    } catch (error) {
      this.log(
        LogLevel.DEBUG,
        `Failed to parse msg as json: ${error} raw: ${event.data}`,
      )
      return
    }

    if (!isRecord(jsonData) || typeof jsonData.Type !== 'string') {
      this.log(
        LogLevel.DEBUG,
        `Unexpected websocket payload: ${event.data}`,
      )
      return
    }

    if (jsonData.Type === 'ERROR') {
      this.log(
        LogLevel.DEBUG,
        `Chat error ${jsonData.ErrorCode}: ${jsonData.ErrorMessage}`,
      )
      return
    }

    if (jsonData.Type === 'EVENT') {
      this.handleEvent(jsonData)
      return
    }

    if (jsonData.Type === 'MESSAGE') {
      this.handleNativeMessage(jsonData)
    }
  }

  private handleEvent(jsonData: Record<string, unknown>) {
    const eventName = typeof jsonData.EventName === 'string'
      ? jsonData.EventName
      : ''

    // IVS has no app-level PONG. Replying with { Type, EventName } is rejected
    // as `unrecognized action` because the frame has no Action field.
    if (eventName === 'PING' || eventName === 'aws:PING') {
      return
    }

    if (eventName !== 'MESSAGE') {
      return
    }

    const attributes = isRecord(jsonData.Attributes)
      ? jsonData.Attributes
      : null
    const raw = attributes?.data
    if (typeof raw !== 'string') {
      this.log(
        LogLevel.DEBUG,
        `MESSAGE event without Attributes.data: ${JSON.stringify(jsonData)}`,
      )
      return
    }

    let data: unknown
    try {
      data = JSON.parse(raw)
    } catch (error) {
      this.log(
        LogLevel.DEBUG,
        `Failed to parse message data as json: ${error} raw: ${raw}`,
      )
      return
    }

    const chatMsgData = WsChatMsgData(data)
    if (chatMsgData instanceof type.errors) {
      this.log(
        LogLevel.DEBUG,
        `Failed to parse chat msg data: ${chatMsgData.summary} raw: ${raw}`,
      )
      return
    }

    this.emit(wtvChatMessage(this.channel, chatMsgData))
  }

  private handleNativeMessage(jsonData: Record<string, unknown>) {
    const content = jsonData.Content
    const id = jsonData.Id
    if (typeof content !== 'string' || typeof id !== 'string') {
      this.log(
        LogLevel.DEBUG,
        `Native MESSAGE missing Content or Id: ${JSON.stringify(jsonData)}`,
      )
      return
    }

    const attributes = isRecord(jsonData.Attributes) ? jsonData.Attributes : {}
    const sender = isRecord(jsonData.Sender) ? jsonData.Sender : {}
    const userId = typeof sender.UserId === 'string' ? sender.UserId : ''
    const nickname = typeof attributes.nickname === 'string'
      ? attributes.nickname
      : userId
    if (!userId && !nickname) {
      return
    }

    const color = typeof attributes.nicknameColor === 'string'
      ? attributes.nicknameColor
      : ''
    const sendTime = typeof jsonData.SendTime === 'string'
      ? jsonData.SendTime
      : new Date().toISOString()

    this.emit(wtvChatMessage(this.channel, {
      messageId: id,
      content,
      createdAt: sendTime,
      sender: {
        userId: userId || nickname,
        nickname: nickname || userId,
        nicknameColor: color,
        tags: [],
      },
    }))
  }

  private emit(msg: ChatMessage) {
    if (msg.text.trim()) {
      this.log(LogLevel.VERBOSE, `Parsed message: ${JSON.stringify(msg)}`)
    }
    this.onMessage(msg)
  }

  // IVS Chat rejects client frames without an Action field
  // (`unrecognized action: ""`). There is no application-level PING;
  // the websocket stack answers protocol pings. Quiet sockets are
  // reconnected by the silence timer instead.
  sendPing(): Promise<void> {
    return Promise.resolve()
  }

  close(silent = false) {
    this.clearSilenceTimer()
    if (this.connectTimer !== null) {
      clearTimeout(this.connectTimer)
      this.connectTimer = null
    }
    const ws = this.websocket
    this.websocket = null
    if (!this.notifiedClose) {
      this.notifiedClose = true
      if (!silent) {
        this.log(LogLevel.DEBUG, `Connection closed for ${this.channel}`)
        this.onClose()
      }
    }
    try {
      ws?.close()
    } catch (error) {
      this.log(LogLevel.DEBUG, `Error while closing ${this.channel}: ${error}`)
    }
  }
}
