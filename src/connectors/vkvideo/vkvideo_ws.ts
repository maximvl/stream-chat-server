import {
  ChannelName,
  ChannelStatus,
  ChatConnector,
  ChatMessage,
  ChatUser,
  ConnectorStatus,
  MessageId,
  UserId,
} from '../types.ts'
import * as cheerio from 'cheerio'
import {
  AppConfig,
  ChannelInfoResponse,
  VkColorsMap,
  WsChatMessage,
  WsErrorMessage,
  WsSubscribeMessage,
} from './schemas.ts'
import { type } from 'arktype'
import { LogLevel } from '../../config.ts'
import { myLog, sleep } from '../../utils.ts'
import { MessageStorage } from '../messageStorage.ts'

type InternalChannelId = string & { readonly __brand: unique symbol }

export class VkVideoConnector implements ChatConnector {
  server: 'vkvideo' = 'vkvideo'
  websocketToken: string | null = null
  websocketHost: string | null = null

  websocket: WebSocket | null = null
  startedAtMs: number = 0

  messageCounter = 0

  channelStatus: Map<ChannelName, ChannelStatus> = new Map()

  channelsMap: Map<ChannelName, InternalChannelId> = new Map()
  reverseChannelsMap: Map<InternalChannelId, ChannelName> = new Map()

  subMsgChannelMap: Map<number, ChannelName> = new Map()

  messages: Map<ChannelName, MessageStorage> = new Map()

  constructor() {
    this.fetchAppConfig()
  }

  log(level: LogLevel, ...msgs: unknown[]) {
    myLog(level, '[vkvideo]', ...msgs)
  }

  async initWebsocket() {
    if (!this.websocketToken || !this.websocketHost) {
      await this.fetchAppConfig()
      if (!this.websocketToken || !this.websocketHost) {
        this.log(LogLevel.DEBUG, 'WebSocket token or host not loaded')
        return
      }
    }

    this.websocket = new WebSocket(this.websocketHost, {
      headers: {
        Origin: 'https://live.vkvideo.ru',
      },
    })

    this.websocket.onopen = () => {
      this.log(LogLevel.DEBUG, 'Connection opened')
      this.startedAtMs = Temporal.Now.instant().epochMilliseconds
    }
    this.websocket.onmessage = (event) => {
      this.handleMessage(event)
    }
    this.websocket.onclose = () => {
      this.handleClose()
    }
    this.websocket.onerror = (error) => {
      this.log(LogLevel.DEBUG, `Connection error: ${JSON.stringify(error)}`)
    }

    while (this.websocket.readyState !== WebSocket.OPEN) {
      this.log(LogLevel.DEBUG, 'Waiting for connection to open...')
      // Small delay to avoid busy waiting
      await sleep(200)
    }

    this.messageCounter++
    const loginMessage = {
      id: this.messageCounter,
      connect: {
        token: this.websocketToken,
        name: 'js',
      },
    }
    this.websocket.send(JSON.stringify(loginMessage))
  }

  handleClose() {
    this.log(LogLevel.DEBUG, 'Connection closed')
    this.websocket?.close()
    this.websocket = null
    this.startedAtMs = 0
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
    this.log(LogLevel.ALL, `Received: ${event.data}`)

    if (event.data === '{}') {
      this.websocket?.send('{}')
      return
    }

    let jsonData: unknown

    try {
      jsonData = JSON.parse(event.data)
    } catch (error) {
      this.log(LogLevel.DEBUG, `Failed to parse msg as json: ${error}`)
      return
    }

    const errorMsg = WsErrorMessage(jsonData)
    if (!(errorMsg instanceof type.errors)) {
      this.log(LogLevel.DEBUG, `Received error message: ${errorMsg}`)
      return
    }

    const subMsg = WsSubscribeMessage(jsonData)
    if (!(subMsg instanceof type.errors)) {
      const channel = this.subMsgChannelMap.get(subMsg.id)
      if (channel) {
        this.log(LogLevel.DEBUG, `Connected to channel: ${channel}`)
        this.channelStatus.set(channel, {
          channel,
          status: 'connected',
          joinedAtMs: Temporal.Now.instant().epochMilliseconds,
          joinedAtStr: Temporal.Now.instant().toString({
            smallestUnit: 'seconds',
          }),
          uptimeMs: 0,
          messagesCount: 0,
        })
        this.subMsgChannelMap.delete(subMsg.id)
      }
      return
    }

    const chatMsg = WsChatMessage(jsonData)
    if (chatMsg instanceof type.errors) {
      this.log(
        LogLevel.ALL,
        `Failed to parse chat message: ${JSON.stringify(chatMsg.issues)}`,
      )
      return
    }

    const data = chatMsg.push.pub.data.data
    if (data.data.length === 0) {
      return
    }

    const channel = this.reverseChannelsMap.get(
      chatMsg.push.channel as InternalChannelId,
    )
    if (!channel) {
      this.log(
        LogLevel.DEBUG,
        `Unknown channel message: ${chatMsg.push.channel}`,
      )
      return
    }

    const mentions: string[] = []
    const messageParts: string[] = []

    for (const content of data.data) {
      if (!('type' in content)) {
        continue
      }
      switch (content.type) {
        case 'mention':
          mentions.push(content.displayName)
          break
        case 'text':
          try {
            const parsed = JSON.parse(content.content)
            if (
              Array.isArray(parsed) && parsed.length > 0 &&
              typeof parsed[0] === 'string'
            ) {
              messageParts.push(parsed[0])
            }
          } catch {
            // Ignore non-JSON content
          }
      }
    }

    const msgUser: ChatUser = {
      id: data.author.id.toString() as UserId,
      displayName: data.author.displayName,
      vkFields: {
        nickColor: data.author.nickColor,
        isChatModerator: data.author.isChatModerator,
        isChannelModerator: data.author.isChannelModerator,
        roles: data.author.roles,
        badges: data.author.badges,
        color: VkColorsMap[data.author.nickColor],
      },
    }

    const msg: ChatMessage = {
      id: data.id.toString() as MessageId,
      user: msgUser,
      timestampMs: data.createdAt * 1000,
      text: messageParts.join(' '),
      server: 'vkvideo',
      channel,
      vkFields: {
        mentions,
      },
    }

    this.log(LogLevel.VERBOSE, `Parsed message: ${JSON.stringify(msg)}`)

    let storage = this.messages.get(channel)
    if (!storage) {
      storage = new MessageStorage()
      this.messages.set(channel, storage)
    }
    storage.addMessage(msg)
  }

  async connect(channel: ChannelName) {
    if (!this.websocket) {
      await this.initWebsocket()
    }
    if (!this.websocket) {
      this.log(LogLevel.DEBUG, 'Failed to connect')
      return
    }

    const status = this.channelStatus.get(channel)
    if (status?.status === 'connecting' || status?.status === 'connected') {
      return
    }

    const channelStatus: ChannelStatus = {
      channel,
      status: 'connecting',
      joinedAtMs: Temporal.Now.instant().epochMilliseconds,
      joinedAtStr: Temporal.Now.instant().toString({
        smallestUnit: 'seconds',
      }),
      uptimeMs: 0,
      messagesCount: 0,
    }

    this.channelStatus.set(channel, channelStatus)

    const channelId = await this.fetchChannelId(channel)
    if (!channelId) {
      this.log(LogLevel.DEBUG, 'Failed to fetch channel ID')
      this.channelStatus.delete(channel)
      return
    }

    if (!this.messages.has(channel)) {
      this.messages.set(channel, new MessageStorage())
    }

    this.channelsMap.set(channel, channelId)
    this.reverseChannelsMap.set(channelId, channel)

    const nextMessageId = this.messageCounter++
    this.subMsgChannelMap.set(nextMessageId, channel)

    this.websocket.send(
      JSON.stringify({
        id: nextMessageId,
        subscribe: {
          channel: channelId,
        },
      }),
    )
  }

  disconnect(channel: ChannelName) {
    this.channelStatus.delete(channel)
    this.messages.delete(channel)

    const channelId = this.channelsMap.get(channel)
    if (!channelId) {
      return
    }
    this.websocket?.send(
      JSON.stringify({
        id: this.messageCounter++,
        unsubscribe: {
          channel: channelId,
        },
      }),
    )
  }

  cleanup(): void {
    if (!this.websocket) {
      return
    }

    const now = Temporal.Now.instant()
    const disconnectCutoff = now.subtract(
      Temporal.Duration.from({ minutes: 30 }),
    )
    this.log(LogLevel.VERBOSE, `Cleaning up channels`)
    for (const [channel, storage] of this.messages.entries()) {
      if (Temporal.Instant.compare(storage.lastReadAt, disconnectCutoff) < 0) {
        this.disconnect(channel)
      } else {
        storage.clearOldMessages()
      }
    }

    if (this.channelStatus.size === 0) {
      this.handleClose()
    }
  }

  getChannelStatus(channel: ChannelName): ChannelStatus | null {
    const status = this.channelStatus.get(channel)
    if (status) {
      status.messagesCount = this.messages.get(channel)?.count() || 0
      status.uptimeMs = Temporal.Now.instant().epochMilliseconds -
        status.joinedAtMs
    }
    return status || null
  }

  getMessages(channel: ChannelName, tsFrom: number): ChatMessage[] {
    const storage = this.messages.get(channel)
    if (!storage) {
      return []
    }
    return storage.getMessagesAfter(tsFrom)
  }

  async fetchAppConfig(): Promise<void> {
    const response = await fetch('https://live.vkvideo.ru/')
    const data = await response.text()

    try {
      const html = cheerio.load(data)
      const config = AppConfig(JSON.parse(html('script#app-config').text()))
      if (config instanceof type.errors) {
        console.error('Failed to parse VK Video app config:', config.summary)
        return
      }
      this.log(LogLevel.DEBUG, 'Fetched VK Video app config', {
        websocketToken: config.websocket.token,
        websocketHost: config.hosts.websocket,
      })
      this.websocketToken = config.websocket.token
      this.websocketHost = config.hosts.websocket
    } catch (error) {
      console.error('Failed to parse VK Video app config:', error)
    }
  }

  async fetchChannelId(
    channel: ChannelName,
  ): Promise<InternalChannelId | null> {
    const url =
      `https://api.live.vkvideo.ru/v1/blog/${channel}/public_video_stream/chat/user/`
    const response = await fetch(url)
    const data = await response.json()
    const channelInfo = ChannelInfoResponse(data)
    if (channelInfo instanceof type.errors) {
      console.error(
        'Failed to parse VK Video channel info:',
        channelInfo.issues,
      )
      return null
    }
    const id = channelInfo.data.owner.id
    return `channel-chat:${id}` as InternalChannelId
  }

  getStatus(): ConnectorStatus {
    const startedAtStr = this.startedAtMs > 0
      ? Temporal.Instant.fromEpochMilliseconds(this.startedAtMs).toString({
        smallestUnit: 'seconds',
      })
      : ''

    const uptimeMs = this.startedAtMs > 0
      ? Temporal.Now.instant().epochMilliseconds - this.startedAtMs
      : 0

    const status: ConnectorStatus = {
      server: 'vkvideo',
      status: 'disconnected',
      startedAtMs: this.startedAtMs,
      startedAtStr,
      uptimeMs,
      channels: [],
    }

    if (this.websocket) {
      const state = this.websocket.readyState
      switch (state) {
        case WebSocket.OPEN:
          status.status = 'connected'
          break
        case WebSocket.CONNECTING:
          status.status = 'connecting'
          break
        default:
          status.status = 'disconnected'
      }
    }

    for (const channel of this.channelStatus.keys()) {
      const channelStatus = this.getChannelStatus(channel)
      if (channelStatus) {
        status.channels.push(channelStatus)
      }
    }

    return status
  }
}
