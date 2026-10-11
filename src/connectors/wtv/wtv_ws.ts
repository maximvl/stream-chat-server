import { CHANNEL_INACTIVITY_TIMEOUT_MINUTES, LogLevel } from '../../config.ts'
import {
  ChannelName,
  ChannelStatus,
  ChatConnector,
  ChatMessage,
  ConnectorStatus,
} from '../types.ts'
import { myLog } from '../../utils.ts'
import { JoinChatResponse, ProfileByNicknameResponse } from './schema.ts'
import { type } from 'arktype'
import { MessageStorage } from '../messageStorage.ts'
import { normalizeChannel } from '../utils.ts'
import { WTV_USER_AGENT, WtvChatConnection } from './connection.ts'

const WTV_PROFILES_BY_NICKNAME_URL =
  'https://profiles-service.w.tv/api/v1/profiles/by-nickname'

const WTV_CHATS_URL = 'https://chats-service.w.tv/api/v1/chats'

const MAX_RECONNECT_ATTEMPTS = 10
const RECONNECT_BASE_MS = 1000
const RECONNECT_MAX_MS = 30_000

export class WtvConnector implements ChatConnector {
  startedAtMs: number = 0

  connections: Map<ChannelName, WtvChatConnection> = new Map()

  messages: Map<ChannelName, MessageStorage> = new Map()

  channelStatus: Map<ChannelName, ChannelStatus> = new Map()

  nicknameToUserId: Map<string, string> = new Map()
  userIdToNickname: Map<string, string> = new Map()

  private stopped = new Set<ChannelName>()
  private opening = new Set<ChannelName>()
  private pendingOpen = new Set<ChannelName>()
  private missingProfiles = new Set<string>()
  private reconnectAttempts = new Map<ChannelName, number>()
  private reconnectTimers = new Map<
    ChannelName,
    ReturnType<typeof setTimeout>
  >()

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
    this.channelStatus.delete(channel)
    this.messages.delete(channel)

    const conn = this.connections.get(channel)
    this.connections.delete(channel)
    conn?.close(true)
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
