import { LogLevel } from '../../config.ts'
import {
  ChannelName,
  ChannelStatus,
  ChatConnector,
  ChatMessage,
  ChatUser,
  ConnectorStatus,
  KickBadge,
  MessageId,
  UserId,
} from '../types.ts'
import { myLog, sleep } from '../../utils.ts'
import {
  ChannelInfoResponse,
  WsChatMsg,
  WsChatMsgData,
  WsPong,
  WsSubscribed,
} from './schema.ts'
import { type } from 'arktype'
import { MessageStorage } from '../messageStorage.ts'

type InternalChannelId = string & { readonly __brand: unique symbol }

export class KickConnector implements ChatConnector {
  websocket: WebSocket | null = null

  startedAtMs: number = 0

  channelsMap: Map<ChannelName, InternalChannelId> = new Map()
  reverseChannelsMap: Map<InternalChannelId, ChannelName> = new Map()

  messages: Map<ChannelName, MessageStorage> = new Map()

  channelStatus: Map<ChannelName, ChannelStatus> = new Map()

  log(level: LogLevel, ...msgs: unknown[]) {
    myLog(level, '[kick]', ...msgs)
  }

  async initWebsocket() {
    this.websocket = new WebSocket(
      'wss://ws-us2.pusher.com/app/32cbd69e4b950bf97679?protocol=7&client=js&version=8.5.0&flash=false',
    )

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

    let jsonData: unknown
    try {
      jsonData = JSON.parse(event.data)
    } catch (error) {
      this.log(LogLevel.DEBUG, `Failed to parse msg as json: ${error}`)
      return
    }

    const pongMsg = WsPong(jsonData)
    if (!(pongMsg instanceof type.errors)) {
      return
    }

    const subscribed = WsSubscribed(jsonData)
    if (!(subscribed instanceof type.errors)) {
      const channel = this.reverseChannelsMap.get(
        subscribed.channel as InternalChannelId,
      )
      if (channel) {
        this.log(LogLevel.DEBUG, `Subscribed to channel: ${channel}`)
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
      }
      return
    }

    const chatMsg = WsChatMsg(jsonData)
    if (chatMsg instanceof type.errors) {
      return
    }

    try {
      jsonData = JSON.parse(chatMsg.data)
    } catch (error) {
      this.log(
        LogLevel.DEBUG,
        `Failed to parse chat msg data as json: ${error}`,
      )
      return
    }

    const chatMsgData = WsChatMsgData(jsonData)
    if (chatMsgData instanceof type.errors) {
      this.log(
        LogLevel.DEBUG,
        `Failed to parse chat msg data: ${chatMsgData.summary}`,
      )
      return
    }

    const channel = this.reverseChannelsMap.get(
      chatMsg.channel as InternalChannelId,
    )
    if (!channel) {
      return
    }

    const badges: KickBadge[] = []
    for (const badge of chatMsgData.sender.identity.badges_v2) {
      badges.push({
        name: badge.name,
        badgeType: badge.badge_type,
        imageUrl: badge.image_url,
        selected: badge.selected,
      })
    }

    for (const badge of chatMsgData.sender.identity.badges) {
      badges.push({
        name: badge.text,
        badgeType: badge.type,
        imageUrl: undefined,
        selected: false,
      })
    }

    const user: ChatUser = {
      id: chatMsgData.sender.id.toString() as UserId,
      displayName: chatMsgData.sender.username,
      kickFields: {
        color: chatMsgData.sender.identity.color,
        badges,
      },
    }

    const msg: ChatMessage = {
      id: chatMsgData.id as MessageId,
      user,
      timestampMs: new Date(chatMsgData.created_at).getTime(),
      text: chatMsgData.content,
      server: 'kick',
      channel,
    }

    this.log(LogLevel.VERBOSE, `Parsed message: ${JSON.stringify(msg)}`)

    let storage = this.messages.get(channel)
    if (!storage) {
      storage = new MessageStorage()
      this.messages.set(channel, storage)
    }

    storage.addMessage(msg)
  }

  sendPing() {
    this.websocket?.send(JSON.stringify({
      event: 'pusher:ping',
      data: {},
    }))
  }

  async connect(channel: ChannelName): Promise<void> {
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

    this.websocket.send(JSON.stringify({
      event: 'pusher:subscribe',
      data: {
        auth: '',
        channel: channelId,
      },
    }))
  }

  async fetchChannelId(
    channel: ChannelName,
  ): Promise<InternalChannelId | null> {
    const url = `https://kick.com/api/v2/channels/${channel}`
    const response = await fetch(url)
    const data = await response.json()
    const channelInfo = ChannelInfoResponse(data)
    if (channelInfo instanceof type.errors) {
      console.error(
        'Failed to parse Kick channel info:',
        channelInfo.issues,
      )
      return null
    }
    const id = channelInfo.chatroom.id
    return `chatrooms.${id}.v2` as InternalChannelId
  }

  disconnect(channel: ChannelName): void {
    this.channelStatus.delete(channel)
    this.messages.delete(channel)

    const channelId = this.channelsMap.get(channel)
    if (!channelId) {
      return
    }

    this.websocket?.send(JSON.stringify({
      event: 'pusher:unsubscribe',
      data: {
        channel: channelId,
      },
    }))
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

  maybeRefreshToken(): Promise<void> {
    return Promise.resolve()
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
      server: 'kick',
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
