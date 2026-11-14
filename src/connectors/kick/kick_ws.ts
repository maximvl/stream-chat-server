import { CHANNEL_INACTIVITY_TIMEOUT_MINUTES, LogLevel } from '../../config.ts'
import {
  ChannelName,
  ChannelStatus,
  ChatConnector,
  ChatMessage,
  ChatPin,
  ChatPoll,
  ChatPrediction,
  ChatUser,
  ConnectorStatus,
  KickBadge,
  MessageId,
  UserId,
} from '../types.ts'
import { myLog, sleep } from '../../utils.ts'
import {
  ChannelInfoResponse,
  ChatroomResponse,
  MessageDeletedData,
  PinnedMessageData,
  PollData,
  PollResponse,
  PredictionData,
  RealtimeConnectionResponse,
  StreamHostData,
  UserBannedData,
  UserInChannelResponse,
  WsChatMsg,
  WsChatMsgData,
  WsHostEvent,
  WsModerationEvent,
  WsPinPollEvent,
  WsPong,
  WsPredictionEvent,
  WsSubscribed,
} from './schema.ts'
import { type } from 'arktype'
import { MessageStorage } from '../messageStorage.ts'
import { normalizeChannel, toChatId } from '../utils.ts'
import {
  emit,
  forgetState,
  setPin,
  setPoll,
  setPrediction,
} from '../chatEvents.ts'
import { AvatarCache, lookupEach } from '../avatars.ts'

type InternalChannelId = string & { readonly __brand: unique symbol }

const MAX_USERNAMES = 100_000

export class KickConnector implements ChatConnector {
  websocket: WebSocket | null = null

  startedAtMs: number = 0

  channelsMap: Map<ChannelName, InternalChannelId> = new Map()
  reverseChannelsMap: Map<InternalChannelId, ChannelName> = new Map()
  predictionChannels: Map<ChannelName, InternalChannelId> = new Map()

  messages: Map<ChannelName, MessageStorage> = new Map()

  channelStatus: Map<ChannelName, ChannelStatus> = new Map()

  avatars = new AvatarCache()
  // Username by user id, from chat messages: Kick's public profile lookup only takes usernames; oldest first
  usernames: Map<string, string> = new Map()

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

    const moderation = WsModerationEvent(jsonData)
    if (!(moderation instanceof type.errors)) {
      this.handleModeration(moderation)
      return
    }

    const prediction = WsPredictionEvent(jsonData)
    if (!(prediction instanceof type.errors)) {
      const channel = this.reverseChannelsMap.get(
        prediction.channel as InternalChannelId,
      )
      if (channel) {
        try {
          const data = JSON.parse(prediction.data) as { prediction?: unknown }
          setPrediction(
            toChatId('kick', channel),
            kickPrediction(data.prediction),
          )
        } catch {
          this.log(LogLevel.DEBUG, `Bad prediction data: ${prediction.data}`)
        }
      }
      return
    }

    const pinPoll = WsPinPollEvent(jsonData)
    if (!(pinPoll instanceof type.errors)) {
      this.handlePinPoll(pinPoll)
      return
    }

    const host = WsHostEvent(jsonData)
    if (!(host instanceof type.errors)) {
      this.handleHost(host)
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

    this.rememberUsername(
      chatMsgData.sender.id.toString(),
      chatMsgData.sender.username,
    )
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

    this.storageFor(channel).addMessage(msg)
  }

  storageFor(channel: ChannelName): MessageStorage {
    let storage = this.messages.get(channel)
    if (!storage) {
      storage = new MessageStorage()
      this.messages.set(channel, storage)
    }
    return storage
  }

  handlePinPoll(event: typeof WsPinPollEvent.infer) {
    const channel = this.reverseChannelsMap.get(
      event.channel as InternalChannelId,
    )
    if (!channel) {
      return
    }
    const chatId = toChatId('kick', channel)
    let data: unknown
    try {
      data = JSON.parse(event.data)
    } catch {
      this.log(LogLevel.DEBUG, `Bad pin/poll event data: ${event.data}`)
      return
    }
    switch (event.event) {
      case 'App\\Events\\PinnedMessageCreatedEvent':
        setPin(chatId, kickPin(data))
        break
      case 'App\\Events\\PinnedMessageDeletedEvent':
        setPin(chatId, null)
        break
      case 'App\\Events\\PollUpdateEvent':
        setPoll(chatId, kickPoll((data as { poll?: unknown })?.poll))
        break
      case 'App\\Events\\PollDeleteEvent':
        setPoll(chatId, null)
    }
  }

  // The pin, poll and prediction up when the channel is (re)joined; later changes come from the socket.
  // What Kick reports replaces what we hold, none included: it may have ended while the socket was down
  async fetchPinPoll(channel: ChannelName) {
    const chatId = toChatId('kick', channel)
    const base = `https://kick.com/api/v2/channels/${channel}`
    try {
      const chatroom = ChatroomResponse(await kickRest(`${base}/chatroom`))
      if (!(chatroom instanceof type.errors)) {
        setPin(
          chatId,
          chatroom.pinned_message ? kickPin(chatroom.pinned_message) : null,
        )
      }
    } catch (error) {
      this.log(LogLevel.DEBUG, `Failed to fetch pinned message: ${error}`)
    }
    try {
      const polls = PollResponse(await kickRest(`${base}/polls`))
      if (!(polls instanceof type.errors)) {
        const data = polls.data as { poll?: unknown } | null | undefined
        const poll = data ? kickPoll(data.poll ?? data) : null
        // Like a resolved prediction: results of a poll that ended before we looked are no news
        setPoll(chatId, poll?.ended ? null : poll)
      }
    } catch (error) {
      this.log(LogLevel.DEBUG, `Failed to fetch poll: ${error}`)
    }
    try {
      const latest = PollResponse(await kickRest(`${base}/predictions/latest`))
      if (!(latest instanceof type.errors)) {
        const data = latest.data as { prediction?: unknown } | null | undefined
        const prediction = data ? kickPrediction(data.prediction ?? data) : null
        // The latest one may have been resolved long ago
        setPrediction(
          chatId,
          prediction?.state === 'resolved' ? null : prediction,
        )
      }
    } catch (error) {
      this.log(LogLevel.DEBUG, `Failed to fetch prediction: ${error}`)
    }
  }

  // Kick's raid, as a notice in Twitch's shape: kind "raid" with displayName and viewerCount
  handleHost(event: typeof WsHostEvent.infer) {
    const channel = this.reverseChannelsMap.get(
      event.channel as InternalChannelId,
    )
    if (!channel) {
      return
    }
    let data: unknown
    try {
      data = JSON.parse(event.data)
    } catch {
      this.log(LogLevel.DEBUG, `Bad host event data: ${event.data}`)
      return
    }
    const host = StreamHostData(data)
    if (host instanceof type.errors) {
      this.log(LogLevel.DEBUG, `Bad host event: ${host.summary}`)
      return
    }
    this.storageFor(channel).addMessage({
      id: crypto.randomUUID() as MessageId,
      timestampMs: Temporal.Now.instant().epochMilliseconds,
      user: {
        id: host.host_username as UserId,
        displayName: host.host_username,
      },
      server: 'kick',
      channel,
      text: host.optional_message ?? '',
      notice: {
        kind: 'raid',
        params: {
          displayName: host.host_username,
          viewerCount: String(host.number_viewers),
        },
        systemText:
          `${host.host_username} is raiding with a party of ${host.number_viewers}.`,
      },
    })
  }

  // Deleted message, banned or timed out user, cleared chat. Polled history is
  // left as is for existing API clients; only live subscribers are told.
  handleModeration(event: typeof WsModerationEvent.infer) {
    const channel = this.reverseChannelsMap.get(
      event.channel as InternalChannelId,
    )
    if (!channel) {
      return
    }
    let data: unknown
    try {
      data = JSON.parse(event.data)
    } catch {
      this.log(LogLevel.DEBUG, `Bad moderation event data: ${event.data}`)
      return
    }
    const chatId = toChatId('kick', channel)

    if (event.event === 'App\\Events\\MessageDeletedEvent') {
      const deleted = MessageDeletedData(data)
      if (!(deleted instanceof type.errors)) {
        emit(chatId, {
          type: 'delete',
          messageIds: [deleted.message.id as MessageId],
        })
      }
    } else if (event.event === 'App\\Events\\UserBannedEvent') {
      const banned = UserBannedData(data)
      if (banned instanceof type.errors) {
        return
      }
      const userId = String(banned.user.id)
      const messageIds = (this.messages.get(channel)?.messages ?? [])
        .filter((m) => m.user.id === userId)
        .map((m) => m.id)
      if (messageIds.length) {
        emit(chatId, { type: 'delete', messageIds })
      }
    } else {
      emit(chatId, { type: 'clear' })
    }
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
    this.fetchPinPoll(channel)
    const predictions = this.predictionChannels.get(channel)
    if (predictions) {
      this.reverseChannelsMap.set(predictions, channel)
      this.send({
        event: 'pusher:subscribe',
        data: { auth: '', channel: predictions },
      })
    }

    // Socket may have closed while fetching; status is then 'disconnected' and the next connect retries
    this.send({
      event: 'pusher:subscribe',
      data: {
        auth: '',
        channel: channelId,
      },
    })
  }

  // Keys are user ids (the chat sender has no picture); one profile request per user.
  // Any channel answers the profile, Kick's own one always exists.
  // Ids of users not seen in a joined chat yet are left out, without caching, until they write.
  async fetchAvatars(ids: string[]): Promise<Record<string, string>> {
    const known = ids.filter((id) => this.usernames.has(id))
    if (known.length === 0) return {}
    return await this.avatars.get(
      known,
      (missing) =>
        lookupEach(missing, async (id) => {
          const username = this.usernames.get(id)
          if (!username) throw new Error(`Unknown Kick user ${id}`)
          const response = await fetch(
            `https://kick.com/api/v2/channels/kick/users/${username}`,
          )
          if (response.status === 404) return ''
          if (!response.ok) throw new Error(`Kick answered ${response.status}`)
          return UserInChannelResponse.assert(await response.json())
            .profile_pic ?? ''
        }),
    )
  }

  rememberUsername(id: string, username: string) {
    this.usernames.delete(id)
    this.usernames.set(id, username)
    for (const oldest of this.usernames.keys()) {
      if (this.usernames.size <= MAX_USERNAMES) break
      this.usernames.delete(oldest)
    }
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
    // Predictions go by the channel's id, not the chatroom's
    this.predictionChannels.set(
      channel,
      `predictions-channel-${channelInfo.id}` as InternalChannelId,
    )
    const id = channelInfo.chatroom.id
    return `chatrooms.${id}.v2` as InternalChannelId
  }

  disconnect(channelOrig: string): void {
    const channel = normalizeChannel(channelOrig)
    this.channelStatus.delete(channel)
    this.messages.delete(channel)
    forgetState(toChatId('kick', channel))
    const predictions = this.predictionChannels.get(channel)
    if (predictions) {
      this.send({
        event: 'pusher:unsubscribe',
        data: { channel: predictions },
      })
    }

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

// 404 is "none up"; any other failure (429, Cloudflare's page) throws, so what we hold stays
async function kickRest(url: string): Promise<unknown> {
  const response = await fetch(url)
  if (response.status === 404) return {}
  if (!response.ok) throw new Error(`${url}: ${response.status}`)
  return await response.json()
}

function kickPin(raw: unknown): ChatPin | null {
  const pin = PinnedMessageData(raw)
  if (pin instanceof type.errors) return null
  const sender = pin.message.sender
  const duration = Number(pin.duration ?? 0)
  return {
    id: pin.message.id,
    user: {
      id: String(sender.id) as UserId,
      displayName: sender.username,
      kickFields: { color: sender.identity?.color ?? '', badges: [] },
    },
    text: pin.message.content,
    ...(duration > 0 && { endsAtMs: Date.now() + duration * 1000 }),
  }
}

function kickPoll(raw: unknown): ChatPoll | null {
  const poll = PollData(raw)
  if (poll instanceof type.errors) return null
  return {
    // Kick's poll has no id; one channel runs one poll at a time
    id: poll.created_at ?? poll.title,
    title: poll.title,
    choices: poll.options.map((o) => ({ title: o.label, votes: o.votes })),
    ...(poll.remaining > 0 && { endsAtMs: Date.now() + poll.remaining * 1000 }),
    ended: poll.remaining <= 0,
  }
}

function kickPrediction(raw: unknown): ChatPrediction | null {
  const p = PredictionData(raw)
  if (p instanceof type.errors) return null
  const state = p.state === 'ACTIVE'
    ? 'open'
    : p.state === 'LOCKED'
    ? 'locked'
    : p.state === 'RESOLVED'
    ? 'resolved'
    : null
  if (!state) return null
  const winner = p.outcomes.findIndex((o) => o.id === p.winning_outcome_id)
  const created = p.created_at ? Date.parse(p.created_at) : NaN
  return {
    id: p.id,
    title: p.title,
    outcomes: p.outcomes.map((o) => ({
      title: o.title,
      points: o.total_vote_amount ?? 0,
      users: o.vote_count ?? 0,
    })),
    state,
    ...(state === 'resolved' && winner >= 0 && { winner }),
    ...(state === 'open' && p.duration && !Number.isNaN(created) && {
      endsAtMs: created + p.duration * 1000,
    }),
  }
}
