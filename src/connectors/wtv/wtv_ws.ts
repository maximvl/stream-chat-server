import { CHANNEL_INACTIVITY_TIMEOUT_MINUTES, LogLevel } from '../../config.ts'
import {
  ChannelName,
  ChannelStatus,
  ChatConnector,
  ChatMessage,
  ConnectorStatus,
} from '../types.ts'
import { myLog } from '../../utils.ts'
import {
  ChannelResponse,
  JoinChatResponse,
  ProfileByNicknameResponse,
} from './schema.ts'
import { AvatarCache, lookupEach } from '../avatars.ts'
import { type } from 'arktype'
import { MessageStorage } from '../messageStorage.ts'
import { normalizeChannel } from '../utils.ts'
import {
  missedMessages,
  WTV_USER_AGENT,
  WtvChatConnection,
} from './connection.ts'

const WTV_PROFILES_BY_NICKNAME_URL =
  'https://profiles-service.w.tv/api/v1/profiles/by-nickname'

const WTV_CHATS_URL = 'https://chats-service.w.tv/api/v1/chats'

const MAX_RECONNECT_ATTEMPTS = 10
// Every reader of a channel asks each minute; w.tv is asked at most this often per channel
const VIEWERS_CACHE_MS = 30_000
const VIEWERS_CACHE_LIMIT = 1000
const RECONNECT_BASE_MS = 1000
const RECONNECT_MAX_MS = 30_000
// After a reconnect the chat's history fills the gap: this many latest messages, from a little before the old
// socket last heard anything (w.tv's clock may run ahead of ours), never from further back than BACKFILL_MAX_MS
const BACKFILL_LIMIT = 50
const BACKFILL_SKEW_MS = 5_000
const BACKFILL_MAX_MS = 120_000

export class WtvConnector implements ChatConnector {
  startedAtMs: number = 0

  connections: Map<ChannelName, WtvChatConnection> = new Map()

  messages: Map<ChannelName, MessageStorage> = new Map()

  channelStatus: Map<ChannelName, ChannelStatus> = new Map()

  nicknameToUserId: Map<string, string> = new Map()
  userIdToNickname: Map<string, string> = new Map()

  avatars = new AvatarCache()
  viewers: Map<string, { at: number; value: Promise<number | null> }> =
    new Map()

  private stopped = new Set<ChannelName>()
  private opening = new Set<ChannelName>()
  private pendingOpen = new Set<ChannelName>()
  private missingProfiles = new Set<string>()
  private reconnectAttempts = new Map<ChannelName, number>()
  private reconnectTimers = new Map<
    ChannelName,
    ReturnType<typeof setTimeout>
  >()
  // When the channel's last socket last received a frame: messages after that are taken from the history
  private heardAt = new Map<ChannelName, number>()

  log(level: LogLevel, ...msgs: unknown[]) {
    myLog(level, '[wtv]', ...msgs)
  }

  private handleIncomingMessage(msg: ChatMessage) {
    const channel = msg.channel
    let storage = this.messages.get(channel)
    if (!storage) {
      storage = new MessageStorage()
      this.messages.set(channel, storage)
    }
    storage.addMessage(msg)
  }

  private handleConnectionOpen(channel: ChannelName) {
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

  private handleConnectionClose(channel: ChannelName) {
    const heard = this.connections.get(channel)?.lastInboundAt
    if (heard) this.heardAt.set(channel, heard)
    const status = this.channelStatus.get(channel)
    if (status) {
      this.channelStatus.set(channel, {
        ...status,
        status: 'disconnected',
        uptimeMs: 0,
      })
    }
    if (this.connections.get(channel)?.isClosed()) {
      this.connections.delete(channel)
    }
    this.scheduleReconnect(channel)
  }

  private handleSilence(channel: ChannelName) {
    if (this.stopped.has(channel)) return
    const conn = this.connections.get(channel)
    if (!conn) return
    this.log(
      LogLevel.DEBUG,
      `Silence on ${channel}, closing socket to reconnect`,
    )
    conn.close()
  }

  private isHealthy(channel: ChannelName): boolean {
    const conn = this.connections.get(channel)
    if (!conn || conn.readyState !== WebSocket.OPEN) return false
    return !conn.isSilent()
  }

  private clearReconnectTimer(channel: ChannelName) {
    const timer = this.reconnectTimers.get(channel)
    if (timer !== undefined) {
      clearTimeout(timer)
      this.reconnectTimers.delete(channel)
    }
  }

  private scheduleReconnect(channel: ChannelName) {
    if (this.stopped.has(channel)) return
    if (!this.channelStatus.has(channel)) return
    if (this.reconnectTimers.has(channel)) return

    const attempt = (this.reconnectAttempts.get(channel) ?? 0) + 1
    this.reconnectAttempts.set(channel, attempt)

    const delay = attempt > MAX_RECONNECT_ATTEMPTS
      ? RECONNECT_MAX_MS
      : Math.min(RECONNECT_BASE_MS * 2 ** (attempt - 1), RECONNECT_MAX_MS)

    if (attempt > MAX_RECONNECT_ATTEMPTS) {
      this.reconnectAttempts.set(channel, 0)
    }

    this.log(
      LogLevel.DEBUG,
      `Reconnecting ${channel} in ${delay}ms (attempt ${attempt})`,
    )
    const timer = setTimeout(() => {
      this.reconnectTimers.delete(channel)
      void this.openChannel(channel)
    }, delay)
    this.reconnectTimers.set(channel, timer)
  }

  sendPing(): Promise<void> {
    const now = Date.now()
    for (const [channel, conn] of this.connections) {
      if (!conn.isSilent(now)) continue
      this.log(
        LogLevel.DEBUG,
        `Silence on ${channel}, closing socket to reconnect`,
      )
      conn.close()
    }
    return Promise.resolve()
  }

  async connect(channelOrig: string): Promise<void> {
    const channel = normalizeChannel(channelOrig)
    this.stopped.delete(channel)
    this.missingProfiles.delete(channel)

    const status = this.channelStatus.get(channel)
    if (status?.status === 'connecting' || status?.status === 'connected') {
      return
    }

    this.clearReconnectTimer(channel)
    await this.openChannel(channel)
  }

  private async openChannel(channel: ChannelName): Promise<void> {
    if (this.stopped.has(channel)) return
    if (this.opening.has(channel)) {
      this.pendingOpen.add(channel)
      return
    }
    this.opening.add(channel)
    this.pendingOpen.delete(channel)

    const now = Temporal.Now.instant()
    const prev = this.channelStatus.get(channel)
    this.channelStatus.set(channel, {
      channel,
      status: 'connecting',
      joinedAtMs: prev?.joinedAtMs ?? now.epochMilliseconds,
      joinedAtStr: prev?.joinedAtStr ??
        now.toString({ smallestUnit: 'seconds' }),
      uptimeMs: 0,
      messagesCount: 0,
    })

    try {
      const previous = this.connections.get(channel)
      if (previous) {
        if (previous.lastInboundAt) {
          this.heardAt.set(channel, previous.lastInboundAt)
        }
        this.connections.delete(channel)
        previous.close(true)
      }

      const userId = await this.fetchUserIdByNickname(channel)
      if (this.stopped.has(channel)) return
      if (!userId) {
        if (this.missingProfiles.has(channel)) {
          this.log(LogLevel.DEBUG, `Profile not found for ${channel}`)
          this.channelStatus.delete(channel)
          return
        }
        this.log(LogLevel.DEBUG, 'Failed to fetch user ID for channel')
        this.scheduleReconnect(channel)
        return
      }

      const token = await this.fetchWsToken(userId)
      if (this.stopped.has(channel)) return
      if (!token) {
        this.log(LogLevel.DEBUG, 'Failed to fetch ws token')
        this.scheduleReconnect(channel)
        return
      }

      if (!this.messages.has(channel)) {
        this.messages.set(channel, new MessageStorage())
      }

      const conn = new WtvChatConnection(
        channel,
        (msg) => this.handleIncomingMessage(msg),
        () => this.handleConnectionOpen(channel),
        () => this.handleConnectionClose(channel),
        () => this.handleSilence(channel),
      )
      this.connections.set(channel, conn)

      if (!this.startedAtMs) {
        this.startedAtMs = Temporal.Now.instant().epochMilliseconds
      }

      const ok = await conn.connect(token)
      if (this.stopped.has(channel)) return
      if (ok) {
        this.reconnectAttempts.set(channel, 0)
        void this.backfill(channel, userId)
      }
    } catch (error) {
      this.log(LogLevel.DEBUG, `Failed to open ${channel}: ${error}`)
      if (!this.stopped.has(channel)) {
        this.scheduleReconnect(channel)
      }
    } finally {
      this.opening.delete(channel)
    }

    if (
      this.pendingOpen.delete(channel) && !this.stopped.has(channel) &&
      !this.isHealthy(channel)
    ) {
      this.scheduleReconnect(channel)
    }
  }

  // The socket is quiet in a quiet chat, so it is reopened every WTV_SILENCE_TIMEOUT_MS, and IVS does not
  // replay what was sent in the second or two it was down. Only after a reconnect: on the first join the
  // history would bring back old `!chat` commands, which overlays would run again
  private async backfill(channel: ChannelName, userId: string) {
    const heard = this.heardAt.get(channel)
    if (heard === undefined) return
    const since = Math.max(
      heard - BACKFILL_SKEW_MS,
      Date.now() - BACKFILL_MAX_MS,
    )
    try {
      const response = await fetch(
        `${WTV_CHATS_URL}/${
          encodeURIComponent(userId)
        }/messages?limit=${BACKFILL_LIMIT}`,
        {
          signal: AbortSignal.timeout(10_000),
          headers: { 'User-Agent': WTV_USER_AGENT, Accept: 'application/json' },
        },
      )
      if (!response.ok) {
        this.log(
          LogLevel.DEBUG,
          `History of ${channel} not loaded: ${response.status}`,
        )
        return
      }
      const history = await response.json()
      if (this.stopped.has(channel)) return
      // Read after the answer: what the new socket brought meanwhile is known too
      const known = new Set(
        (this.messages.get(channel)?.messages ?? []).map((m) => m.id),
      )
      const missed = missedMessages(channel, history, since, known)
      if (missed.length) {
        this.log(
          LogLevel.DEBUG,
          `Recovered ${missed.length} message(s) of ${channel} from history`,
        )
      }
      for (const msg of missed) this.handleIncomingMessage(msg)
    } catch (error) {
      this.log(LogLevel.DEBUG, `History of ${channel} not loaded: ${error}`)
    }
  }

  async fetchUserIdByNickname(nickname: string): Promise<string | null> {
    const cached = this.nicknameToUserId.get(nickname)
    if (cached) {
      return cached
    }

    const url = `${WTV_PROFILES_BY_NICKNAME_URL}/${
      encodeURIComponent(nickname)
    }`

    let response: Response
    try {
      response = await fetch(url, {
        signal: AbortSignal.timeout(10_000),
        headers: {
          'User-Agent': WTV_USER_AGENT,
          Accept: 'application/json',
        },
      })
    } catch (error) {
      this.log(
        LogLevel.DEBUG,
        `Failed to fetch profile for ${nickname}: ${error}`,
      )
      return null
    }

    if (response.status === 404) {
      this.missingProfiles.add(nickname)
      this.log(
        LogLevel.DEBUG,
        `Failed to fetch profile for ${nickname}: ${response.status}`,
      )
      return null
    }

    if (!response.ok) {
      this.log(
        LogLevel.DEBUG,
        `Failed to fetch profile for ${nickname}: ${response.status}`,
      )
      return null
    }

    const data = await response.json()
    const parsed = ProfileByNicknameResponse(data)
    if (parsed instanceof type.errors) {
      this.log(
        LogLevel.DEBUG,
        `Failed to parse profile response: ${parsed.summary}`,
      )
      return null
    }

    const userId = parsed.profile.userId
    this.nicknameToUserId.set(nickname, userId)
    this.userIdToNickname.set(userId, nickname)
    return userId
  }

  getUserIdByNickname(nickname: string): string | undefined {
    return this.nicknameToUserId.get(nickname)
  }

  getNicknameByUserId(userId: string): string | undefined {
    return this.userIdToNickname.get(userId)
  }

  async fetchWsToken(userId: string): Promise<string | null> {
    const url = `${WTV_CHATS_URL}/${encodeURIComponent(userId)}/join`

    let response: Response
    try {
      response = await fetch(url, {
        signal: AbortSignal.timeout(10_000),
        method: 'POST',
        headers: {
          'User-Agent': WTV_USER_AGENT,
          Accept: 'application/json',
          'Content-Type': 'application/json',
        },
      })
    } catch (error) {
      this.log(LogLevel.DEBUG, `Failed to fetch ws token: ${error}`)
      return null
    }

    if (!response.ok) {
      this.log(LogLevel.DEBUG, `Failed to fetch ws token: ${response.status}`)
      return null
    }

    const data = await response.json()
    const parsed = JoinChatResponse(data)
    if (parsed instanceof type.errors) {
      this.log(
        LogLevel.DEBUG,
        `Failed to parse join chat response: ${parsed.summary}`,
      )
      return null
    }

    return parsed.token
  }

  disconnect(channelOrig: string): void {
    const channel = normalizeChannel(channelOrig)
    this.stopped.add(channel)
    this.clearReconnectTimer(channel)
    this.reconnectAttempts.delete(channel)
    this.heardAt.delete(channel)
    this.channelStatus.delete(channel)
    this.messages.delete(channel)

    const conn = this.connections.get(channel)
    this.connections.delete(channel)
    conn?.close(true)
  }

  // Keys are user ids (uuids); chat messages carry no picture, the user's channel does
  fetchAvatars(ids: string[]): Promise<Record<string, string>> {
    return this.avatars.get(
      ids,
      (missing) =>
        lookupEach(missing, async (id) => {
          const response = await fetch(
            `https://streams-search-service.w.tv/api/v1/channels/${id}`,
            {
              signal: AbortSignal.timeout(10_000),
              headers: {
                'User-Agent': WTV_USER_AGENT,
                Accept: 'application/json',
              },
            },
          )
          if (response.status === 404) return ''
          if (!response.ok) throw new Error(`w.tv answered ${response.status}`)
          return ChannelResponse.assert(await response.json()).channel
            .imageUrl ?? ''
        }),
    )
  }

  fetchViewers(channelOrig: string): Promise<number | null> {
    const nickname = normalizeChannel(channelOrig)
    const cached = this.viewers.get(nickname)
    if (cached && Date.now() - cached.at < VIEWERS_CACHE_MS) return cached.value
    const value = (async () => {
      const id = await this.fetchUserIdByNickname(nickname)
      if (!id) return null
      const response = await fetch(
        `https://streams-search-service.w.tv/api/v1/channels/${id}`,
        {
          headers: { 'User-Agent': WTV_USER_AGENT, Accept: 'application/json' },
          // A hung w.tv must not pile up a request per channel every half minute
          signal: AbortSignal.timeout(10_000),
        },
      )
      if (!response.ok) throw new Error(`w.tv answered ${response.status}`)
      const { channel } = ChannelResponse.assert(await response.json())
      return channel.live ? channel.liveStream?.viewers ?? 0 : null
    })()
    this.viewers.delete(nickname)
    // Names anyone may ask for: the oldest go first
    if (this.viewers.size >= VIEWERS_CACHE_LIMIT) {
      this.viewers.delete(this.viewers.keys().next().value!)
    }
    this.viewers.set(nickname, { at: Date.now(), value })
    // A failure is not kept: the next reader asks again
    value.catch(() => this.viewers.delete(nickname))
    return value
  }

  cleanup(): void {
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

    if (this.connections.size === 0 && this.channelStatus.size === 0) {
      this.startedAtMs = 0
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
      server: 'wtv',
      status: 'disconnected',
      startedAtMs: this.startedAtMs,
      startedAtStr,
      uptimeMs,
      channels: [],
    }

    let anyOpen = false
    let anyConnecting = false
    for (const conn of this.connections.values()) {
      const state = conn.readyState
      if (state === WebSocket.OPEN) {
        anyOpen = true
      } else if (state === WebSocket.CONNECTING) {
        anyConnecting = true
      }
    }
    if (anyOpen) {
      status.status = 'connected'
    } else if (anyConnecting || this.opening.size > 0) {
      status.status = 'connecting'
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
