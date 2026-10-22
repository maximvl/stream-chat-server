import { CHANNEL_INACTIVITY_TIMEOUT_MINUTES, LogLevel } from '../../config.ts'
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
  RealtimeConnectionResponse,
  WsChatMsg,
  WsChatMsgData,
  WsPong,
  WsSubscribed,
} from './schema.ts'
import { type } from 'arktype'
import { MessageStorage } from '../messageStorage.ts'
import { normalizeChannel } from '../utils.ts'

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

  // Shared by concurrent connect() calls so they don't send before the socket is open
  opening: Promise<void> | null = null

  // Kick rotates its Pusher app key, so ask Kick for the current one
  async fetchPusherAppKey(): Promise<{ appKey: string; cluster: string }> {
    const fallback = { appKey: '34bf7a0ff419a2a775b9', cluster: 'us2' }
    try {
      const response = await fetch(
        'https://web.kick.com/api/v1/realtime/connection',
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            client: { id: crypto.randomUUID(), type: 'web' },
            capabilities: { accepted_providers: [{ provider: 'pusher' }] },
          }),
        },
      )
      const data = RealtimeConnectionResponse(await response.json())
      if (data instanceof type.errors) {
        this.log(LogLevel.DEBUG, `Bad realtime config: ${data.summary}`)
        return fallback
      }
      const pusher = data.data.connections.find((c) => c.provider === 'pusher')
      const { app_key, cluster } = pusher?.credentials ?? {}
      return app_key && cluster ? { appKey: app_key, cluster } : fallback
    } catch (error) {
      this.log(LogLevel.DEBUG, `Failed to fetch realtime config: ${error}`)
      return fallback
    }
  }

  async initWebsocket() {
    const { appKey, cluster } = await this.fetchPusherAppKey()
    const ws = new WebSocket(
      `wss://ws-${cluster}.pusher.com/app/${appKey}?protocol=7&client=js&version=8.5.0&flash=false`,
    )
    this.websocket = ws

    ws.onopen = () => {
      this.log(LogLevel.DEBUG, 'Connection opened')
      this.startedAtMs = Temporal.Now.instant().epochMilliseconds
    }
    ws.onmessage = (event) => {
      this.handleMessage(event)
    }
    ws.onclose = (event) => {
      this.log(LogLevel.DEBUG, `Close code: ${event.code} ${event.reason}`)
      // A late close event of an old socket must not kill the current one
      if (this.websocket === ws) this.handleClose()
    }
    ws.onerror = (error) => {
      this.log(LogLevel.DEBUG, `Connection error: ${JSON.stringify(error)}`)
    }

    while (ws.readyState === WebSocket.CONNECTING) {
      this.log(LogLevel.DEBUG, 'Waiting for connection to open...')
      // Small delay to avoid busy waiting
      await sleep(200)
    }
  }

  send(data: unknown): boolean {
    if (this.websocket?.readyState !== WebSocket.OPEN) {
      this.log(LogLevel.DEBUG, 'Websocket not open, dropping send')
      return false
    }
    this.websocket.send(JSON.stringify(data))
    return true
  }

  handleClose() {
    this.log(LogLevel.DEBUG, 'Connection closed')
    this.websocket?.close()
    this.websocket = null
    this.startedAtMs = 0
    for (const [channel, status] of this.channelStatus.entries()) {
      this.channelStatus.set(channel, {
        ...status,
        status: 'disconnected',
        uptimeMs: 0,
      })
    }
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
      // No matching known message type; only log if we can identify it as chat-related
      // to avoid spamming for expected Pusher control messages already handled above
      return
    }

    try {
      jsonData = JSON.parse(chatMsg.data)
    } catch (error) {
      this.log(
        LogLevel.DEBUG,
        `Failed to parse chat msg data as json: ${error} raw: ${chatMsg.data}`,
      )
      return
    }

    const chatMsgData = WsChatMsgData(jsonData)
    if (chatMsgData instanceof type.errors) {
      this.log(
        LogLevel.DEBUG,
        `Failed to parse chat msg data: ${chatMsgData.summary} raw: ${chatMsg.data}`,
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
        type: badge.badge_type,
        imageUrl: badge.image_url,
        selected: badge.selected,
      })
    }

    for (const badge of chatMsgData.sender.identity.badges) {
      badges.push({
        name: badge.text,
        type: badge.type,
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

    if (msg.text.trim()) {
      this.log(LogLevel.VERBOSE, `Parsed message: ${JSON.stringify(msg)}`)
    }

    let storage = this.messages.get(channel)
    if (!storage) {
      storage = new MessageStorage()
      this.messages.set(channel, storage)
    }

    storage.addMessage(msg)
  }

  sendPing(): Promise<void> {
    if (this.websocket) {
      this.send({ event: 'pusher:ping', data: {} })
    }
    return Promise.resolve()
  }

  async connect(channelOrig: string): Promise<void> {
    const channel = normalizeChannel(channelOrig)

    if (!this.websocket && !this.opening) {
      this.opening = this.initWebsocket().finally(() => {
        this.opening = null
      })
    }
    await this.opening
    if (this.websocket?.readyState !== WebSocket.OPEN) {
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

    // Socket may have closed while fetching; status is then 'disconnected' and the next connect retries
    this.send({
      event: 'pusher:subscribe',
      data: {
        auth: '',
        channel: channelId,
      },
    })
  }

  async fetchChannelId(
    channel: ChannelName,
  ): Promise<InternalChannelId | null> {
    const url = `https://kick.com/api/v2/channels/${channel}`
    let data: unknown
    try {
      const response = await fetch(url)
      data = await response.json()
    } catch (error) {
      this.log(LogLevel.DEBUG, `Failed to fetch channel info: ${error}`)
      return null
    }
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

  disconnect(channelOrig: string): void {
    const channel = normalizeChannel(channelOrig)
    this.channelStatus.delete(channel)
    this.messages.delete(channel)

    const channelId = this.channelsMap.get(channel)
    if (!channelId) {
      return
    }

    this.send({
      event: 'pusher:unsubscribe',
      data: {
        channel: channelId,
      },
    })
  }

  cleanup(): void {
    if (!this.websocket) {
      return
    }

    const now = Temporal.Now.instant()
    const disconnectCutoff = now.subtract(
      Temporal.Duration.from({ minutes: CHANNEL_INACTIVITY_TIMEOUT_MINUTES }),
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

  getChannelStatus(channelOrig: string): ChannelStatus | null {
    const channel = normalizeChannel(channelOrig)
    const status = this.channelStatus.get(channel)
    if (status) {
      status.messagesCount = this.messages.get(channel)?.count() || 0
      status.uptimeMs = status.status === 'connected'
        ? Temporal.Now.instant().epochMilliseconds - status.joinedAtMs
        : 0
    }
    return status || null
  }

  getMessages(channelOrig: string, tsFrom: number): ChatMessage[] {
    const channel = normalizeChannel(channelOrig)
    const storage = this.messages.get(channel)
    if (!storage) {
      return []
    }
    return storage.getMessagesAfter(tsFrom)
  }

  getLastMessages(channelOrig: string, limit: number): ChatMessage[] {
    const channel = normalizeChannel(channelOrig)
    const storage = this.messages.get(channel)
    if (!storage) {
      return []
    }
    return storage.getLastMessages(limit)
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
