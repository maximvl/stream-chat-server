import { LogLevel } from '../../config.ts'
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

const WTV_CHATS_JOIN_URL = 'https://chats-service.w.tv/api/v1/chats'

export class WtvConnector implements ChatConnector {
  startedAtMs: number = 0

  connections: Map<ChannelName, WtvChatConnection> = new Map()

  messages: Map<ChannelName, MessageStorage> = new Map()

  channelStatus: Map<ChannelName, ChannelStatus> = new Map()

  nicknameToUserId: Map<string, string> = new Map()
  userIdToNickname: Map<string, string> = new Map()

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
  }

  sendPing(): Promise<void> {
    for (const conn of this.connections.values()) {
      conn.sendPing()
    }
    return Promise.resolve()
  }

  async connect(channelOrig: string): Promise<void> {
    const channel = normalizeChannel(channelOrig)

    const status = this.channelStatus.get(channel)
    if (status?.status === 'connecting' || status?.status === 'connected') {
      return
    }

    this.channelStatus.set(channel, {
      channel,
      status: 'connecting',
      joinedAtMs: Temporal.Now.instant().epochMilliseconds,
      joinedAtStr: Temporal.Now.instant().toString({
        smallestUnit: 'seconds',
      }),
      uptimeMs: 0,
      messagesCount: 0,
    })

    const userId = await this.fetchUserIdByNickname(channel)
    if (!userId) {
      this.log(LogLevel.DEBUG, 'Failed to fetch user ID for channel')
      this.channelStatus.delete(channel)
      return
    }

    const token = await this.fetchWsToken(userId)
    if (!token) {
      this.log(LogLevel.DEBUG, 'Failed to fetch ws token')
      this.channelStatus.delete(channel)
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
    )
    this.connections.set(channel, conn)

    if (!this.startedAtMs) {
      this.startedAtMs = Temporal.Now.instant().epochMilliseconds
    }

    await conn.connect(token)

    if (!this.connections.has(channel)) {
      this.log(LogLevel.DEBUG, 'Failed to connect')
      this.channelStatus.delete(channel)
      return
    }
  }

  async fetchUserIdByNickname(nickname: string): Promise<string | null> {
    const cached = this.nicknameToUserId.get(nickname)
    if (cached) {
      return cached
    }

    const url = `${WTV_PROFILES_BY_NICKNAME_URL}/${
      encodeURIComponent(
        nickname,
      )
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
    const url = `${WTV_CHATS_JOIN_URL}/${encodeURIComponent(userId)}/join`

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
    this.channelStatus.delete(channel)
    this.messages.delete(channel)

    const conn = this.connections.get(channel)
    if (conn) {
      conn.close()
      this.connections.delete(channel)
    }
  }

  cleanup(): void {
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

    if (this.connections.size === 0) {
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
    } else if (anyConnecting) {
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
