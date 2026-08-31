import { LogLevel } from '../../config.ts'
import { ChannelName, ChatMessage, MessageId, UserId } from '../types.ts'
import { myLog, sleep } from '../../utils.ts'
import { WsChatMsgData, WsEventEnvelope } from './schema.ts'
import { type } from 'arktype'

export const WTV_USER_AGENT =
  'Mozilla/5.0 (X11; Linux x86_64; rv:153.0) Gecko/20100101 Firefox/153.0'

const WTV_WS_URL = 'wss://edge.ivschat.eu-central-1.amazonaws.com/'

type MessageHandler = (msg: ChatMessage) => void
type OpenHandler = () => void
type CloseHandler = () => void

export class WtvChatConnection {
  websocket: WebSocket | null = null

  channel: ChannelName
  private onMessage: MessageHandler
  private onOpen: OpenHandler
  private onClose: CloseHandler

  constructor(
    channel: ChannelName,
    onMessage: MessageHandler,
    onOpen: OpenHandler,
    onClose: CloseHandler,
  ) {
    this.channel = channel
    this.onMessage = onMessage
    this.onOpen = onOpen
    this.onClose = onClose
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

  async connect(token: string) {
    this.websocket = new WebSocket(WTV_WS_URL, token)

    this.websocket.onopen = () => {
      this.log(LogLevel.DEBUG, `Connection opened for ${this.channel}`)
      this.onOpen()
    }
    this.websocket.onmessage = (event) => {
      this.handleMessage(event)
    }
    this.websocket.onclose = () => {
      this.handleClose()
    }
    this.websocket.onerror = (error) => {
      this.log(
        LogLevel.DEBUG,
        `Connection error for ${this.channel}: ${JSON.stringify(error)}`,
      )
    }

    while (this.websocket.readyState !== WebSocket.OPEN) {
      this.log(
        LogLevel.DEBUG,
        `Waiting for connection to ${this.channel} to open...`,
      )
      await sleep(200)
    }
  }

  handleClose() {
    this.log(LogLevel.DEBUG, `Connection closed for ${this.channel}`)
    this.websocket = null
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

    const envelope = WsEventEnvelope(jsonData)
    if (envelope instanceof type.errors) {
      this.log(
        LogLevel.DEBUG,
        `Failed to parse event envelope: ${envelope.summary} raw: ${event.data}`,
      )
      return
    }

    if (envelope.EventName === 'PING') {
      this.websocket?.send(
        JSON.stringify({
          Type: 'EVENT',
          EventName: 'PONG',
          Attributes: {},
        }),
      )
      return
    }

    if (envelope.EventName !== 'MESSAGE') {
      return
    }

    let data: unknown
    try {
      data = JSON.parse(envelope.Attributes.data)
    } catch (error) {
      this.log(
        LogLevel.DEBUG,
        `Failed to parse message data as json: ${error} raw: ${envelope.Attributes.data}`,
      )
      return
    }

    const chatMsgData = WsChatMsgData(data)
    if (chatMsgData instanceof type.errors) {
      this.log(
        LogLevel.DEBUG,
        `Failed to parse chat msg data: ${chatMsgData.summary} raw: ${envelope.Attributes.data}`,
      )
      return
    }

    const user = {
      id: chatMsgData.sender.userId as UserId,
      displayName: chatMsgData.sender.nickname,
      wtvFields: {
        nicknameColor: chatMsgData.sender.nicknameColor,
        tags: chatMsgData.sender.tags,
      },
    }

    const msg: ChatMessage = {
      id: chatMsgData.messageId as MessageId,
      user,
      timestampMs: new Date(chatMsgData.createdAt).getTime(),
      text: chatMsgData.content,
      server: 'wtv',
      channel: this.channel,
    }

    if (msg.text.trim()) {
      this.log(LogLevel.VERBOSE, `Parsed message: ${JSON.stringify(msg)}`)
    }

    this.onMessage(msg)
  }

  sendPing(): Promise<void> {
    this.websocket?.send(
      JSON.stringify({
        Type: 'EVENT',
        EventName: 'PING',
        Attributes: {},
      }),
    )
    return Promise.resolve()
  }

  close() {
    if (this.websocket) {
      this.websocket.close()
      this.websocket = null
    }
  }
}
