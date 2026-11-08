import { CHANNEL_INACTIVITY_TIMEOUT_MINUTES, LogLevel } from '../../config.ts'
import {
  ChannelName,
  ChannelStatus,
  ChatConnector,
  ChatMessage,
  ConnectionStatus,
  ConnectorStatus,
} from '../types.ts'
import { myLog, sleep } from '../../utils.ts'
import { MessageStorage } from '../messageStorage.ts'
import { normalizeChannel, toChatId } from '../utils.ts'
import { ChatEvent, emit } from '../chatEvents.ts'

const RETRY_MS = 3_000
// The node pings every 20 s; a stream silent for longer is dead
const STALE_MS = 60_000
const HISTORY_LIMIT = 100

type ChannelState = {
  source: string
  status: ConnectionStatus
  joinedAtMs: number
  abort: () => void
}

/**
 * YouTube is unreachable from where this server runs, so another copy of it abroad
 * (YOUTUBE_NODE_URL) reads the chats, and this one follows that copy's chat_stream.
 * Messages land in the local storage, so history, chat_stream and command checks
 * work as for the other platforms.
 */
export class YoutubeRemoteConnector implements ChatConnector {
  startedAtMs = Temporal.Now.instant().epochMilliseconds

  channels: Map<ChannelName, ChannelState> = new Map()

  messages: Map<ChannelName, MessageStorage> = new Map()

  // Live or not, as the node sees it; refreshed by sendPing
  nodeStatuses: Map<ChannelName, ConnectionStatus> = new Map()

  headers: Record<string, string>

  constructor(public nodeUrl: string, token: string) {
    this.nodeUrl = nodeUrl.replace(/\/+$/, '')
    this.headers = token ? { authorization: `Bearer ${token}` } : {}
  }

  log(level: LogLevel, ...msgs: unknown[]) {
    myLog(level, '[youtube-remote]', ...msgs)
  }

  addMessage(channel: ChannelName, message: ChatMessage) {
    const storage = this.messages.get(channel)
    if (!storage || storage.messages.some((m) => m.id === message.id)) return
    storage.addMessage({ ...message, server: 'youtube', channel })
  }

  handleEvent(channel: ChannelName, event: ChatEvent) {
    if (event.type === 'message') {
      // A live message means the node reads the chat, before sendPing says so
      this.nodeStatuses.set(channel, 'connected')
      this.addMessage(channel, event.message)
    } else if (event.type === 'delete' || event.type === 'clear') {
      emit(toChatId('youtube', channel), event)
    }
  }

  // Messages the node got while we were away; the node returns them oldest first
  async backfill(channel: ChannelName, params: URLSearchParams) {
    try {
      const response = await fetch(
        `${this.nodeUrl}/api/chat_last_messages?${params}&limit=${HISTORY_LIMIT}`,
        { headers: this.headers, signal: AbortSignal.timeout(10_000) },
      )
      if (!response.ok) throw new Error(`status ${response.status}`)
      const data: {
        status: { status: ConnectionStatus } | null
        messages: ChatMessage[]
      } = await response.json()
      if (data.status) this.nodeStatuses.set(channel, data.status.status)
      for (const message of data.messages ?? []) {
        this.addMessage(channel, message)
      }
    } catch (error) {
      this.log(LogLevel.DEBUG, `History of ${channel} failed: ${error}`)
    }
  }

  async follow(channel: ChannelName, state: ChannelState) {
    const controller = new AbortController()
    state.abort = () => controller.abort()
    const params = new URLSearchParams({
      server: 'youtube',
      channel: state.source,
    })
    const response = await fetch(`${this.nodeUrl}/api/chat_stream?${params}`, {
      headers: this.headers,
      signal: controller.signal,
    })
    if (!response.ok || !response.body) {
      await response.body?.cancel()
      throw new Error(`chat_stream: ${response.status}`)
    }
    state.status = 'connected'
    state.joinedAtMs = Temporal.Now.instant().epochMilliseconds
    // The stream buffers meanwhile, so history goes in before newer live messages
    await this.backfill(channel, params)

    let lastSeenAt = Date.now()
    const watchdog = setInterval(() => {
      if (Date.now() - lastSeenAt > STALE_MS) controller.abort()
    }, 5_000)
    try {
      let buffer = ''
      for await (
        const chunk of response.body.pipeThrough(new TextDecoderStream())
      ) {
        lastSeenAt = Date.now()
        buffer += chunk
        const lines = buffer.split('\n')
        buffer = lines.pop() ?? ''
        for (const line of lines) {
          if (!line.startsWith('data: ')) continue
          try {
            this.handleEvent(channel, JSON.parse(line.slice(6)))
          } catch (error) {
            this.log(LogLevel.DEBUG, `Bad event from node: ${error}`)
          }
        }
      }
    } finally {
      clearInterval(watchdog)
    }
  }

  async run(channel: ChannelName, state: ChannelState) {
    while (this.channels.get(channel) === state) {
      try {
        await this.follow(channel, state)
      } catch (error) {
        if (this.channels.get(channel) === state) {
          this.log(LogLevel.DEBUG, `Stream of ${channel} failed: ${error}`)
        }
      }
      state.status = 'connecting'
      if (this.channels.get(channel) === state) await sleep(RETRY_MS)
    }
  }

  connect(channelOrig: string): Promise<void> {
    const channel = normalizeChannel(channelOrig.trim())
    if (this.channels.has(channel)) return Promise.resolve()
    const state: ChannelState = {
      source: channelOrig.trim(),
      status: 'connecting',
      joinedAtMs: Temporal.Now.instant().epochMilliseconds,
      abort: () => {},
    }
    this.channels.set(channel, state)
    if (!this.messages.has(channel)) {
      this.messages.set(channel, new MessageStorage())
    }
    void this.run(channel, state)
    return Promise.resolve()
  }

  disconnect(channelOrig: string): void {
    const channel = normalizeChannel(channelOrig.trim())
    this.channels.get(channel)?.abort()
    this.channels.delete(channel)
    this.messages.delete(channel)
    this.nodeStatuses.delete(channel)
  }

  // Once a minute: whether the node actually reads each chat (a channel may be off the air)
  async sendPing(): Promise<void> {
    if (this.channels.size === 0) return
    const response = await fetch(`${this.nodeUrl}/api/status`, {
      headers: this.headers,
      signal: AbortSignal.timeout(10_000),
    })
    if (!response.ok) throw new Error(`status ${response.status}`)
    const data: { connectors: ConnectorStatus[] } = await response.json()
    const youtube = data.connectors.find((c) => c.server === 'youtube')
    this.nodeStatuses = new Map(
      (youtube?.channels ?? []).map((c) => [c.channel, c.status]),
    )
  }

  cleanup(): void {
    const now = Temporal.Now.instant()
    const disconnectCutoff = now.subtract(
      Temporal.Duration.from({ minutes: CHANNEL_INACTIVITY_TIMEOUT_MINUTES }),
    )
    for (const [channel, storage] of this.messages.entries()) {
      if (Temporal.Instant.compare(storage.lastReadAt, disconnectCutoff) < 0) {
        this.disconnect(channel)
      } else {
        storage.clearOldMessages()
      }
    }
  }

  getChannelStatus(channelOrig: string): ChannelStatus | null {
    const channel = normalizeChannel(channelOrig.trim())
    const state = this.channels.get(channel)
    if (!state) return null
    // Connected only when both our stream to the node and the node's chat are up
    const status = state.status === 'connected'
      ? this.nodeStatuses.get(channel) ?? 'connecting'
      : state.status
    return {
      channel,
      status,
      joinedAtMs: state.joinedAtMs,
      joinedAtStr: Temporal.Instant.fromEpochMilliseconds(state.joinedAtMs)
        .toString({ smallestUnit: 'seconds' }),
      uptimeMs: status === 'connected'
        ? Temporal.Now.instant().epochMilliseconds - state.joinedAtMs
        : 0,
      messagesCount: this.messages.get(channel)?.count() || 0,
    }
  }

  getMessages(channelOrig: string, tsFrom: number): ChatMessage[] {
    const storage = this.messages.get(normalizeChannel(channelOrig.trim()))
    return storage ? storage.getMessagesAfter(tsFrom) : []
  }

  getLastMessages(channelOrig: string, limit: number): ChatMessage[] {
    const storage = this.messages.get(normalizeChannel(channelOrig.trim()))
    return storage ? storage.getLastMessages(limit) : []
  }

  getStatus(): ConnectorStatus {
    const channels: ChannelStatus[] = []
    for (const channel of this.channels.keys()) {
      const status = this.getChannelStatus(channel)
      if (status) channels.push(status)
    }
    return {
      server: 'youtube',
      status: 'connected',
      startedAtMs: this.startedAtMs,
      startedAtStr: Temporal.Instant.fromEpochMilliseconds(this.startedAtMs)
        .toString({ smallestUnit: 'seconds' }),
      uptimeMs: Temporal.Now.instant().epochMilliseconds - this.startedAtMs,
      channels,
    }
  }
}
