import { CHANNEL_INACTIVITY_TIMEOUT_MINUTES, LogLevel } from '../../config.ts'
import {
  ChannelName,
  ChannelStatus,
  ChatConnector,
  ChatEmote,
  ChatMessage,
  ConnectionStatus,
  ConnectorStatus,
  MessageId,
  UserId,
} from '../types.ts'
import { myLog, sleep } from '../../utils.ts'
import {
  ChannelInfoResponse,
  JoinData,
  MessageData,
  RemoveMessageData,
  Smile,
  UserBanData,
  UserResponse,
  WsEvent,
} from './schema.ts'
import { type } from 'arktype'
import { MessageStorage } from '../messageStorage.ts'
import { normalizeChannel, toChatId } from '../utils.ts'
import { emit } from '../chatEvents.ts'
import { AvatarCache, lookupEach } from '../avatars.ts'

const WS_URL = 'wss://chat-1.goodgame.ru/chat2/'
const SMILES_URL = 'https://goodgame.ru/api/4/smiles'
const SMILES_TTL_MS = 6 * 60 * 60 * 1000

// Nick colors of the GoodGame chat (.chat-container .nick.<color>); gradients use their first color
export const GOODGAME_COLORS: Record<string, string> = {
  simple: '#73adff',
  bronze: '#e7820a',
  silver: '#b4b4b4',
  gold: '#eefc08',
  diamond: '#8781bd',
  king: '#30d5c8',
  'top-one': '#3bcbff',
  undead: '#ab4873',
  premium: '#bd70d7',
  'premium-personal': '#31a93a',
  moderator: '#ec4058',
  newguy: '#ffffff',
  streamer: '#e8bb00',
  'streamer-helper': '#e8bb00',
  'gradient-fire': '#ec8c24',
  'gradient-cherry': '#ea455c',
  'gradient-mushroom': '#bababa',
}

// Smile codes look like :name: and may be glued to words
const SMILE_CODE = /:([\w-]+):/g

// GoodGame's numeric chat room id
type InternalChannelId = string & { readonly __brand: unique symbol }

export class GoodgameConnector implements ChatConnector {
  websocket: WebSocket | null = null

  startedAtMs: number = 0

  channelsMap: Map<ChannelName, InternalChannelId> = new Map()
  // shortcut: one name per room, so a chat opened by both nick and channel key feeds only the last one; make it a set if that shows up
  reverseChannelsMap: Map<InternalChannelId, ChannelName> = new Map()
  // Streamer's user id per room, from success_join
  streamerIds: Map<InternalChannelId, number> = new Map()

  messages: Map<ChannelName, MessageStorage> = new Map()

  channelStatus: Map<ChannelName, ChannelStatus> = new Map()

  // Smile code -> emote; one list holds global and all channel smiles
  smiles: Map<string, ChatEmote> = new Map()

  avatars = new AvatarCache()
  smilesLoadedAtMs = 0
  smilesLoading: Promise<void> | null = null

  // Shared by concurrent connect() calls so they don't send before the socket is open
  opening: Promise<void> | null = null

  log(level: LogLevel, ...msgs: unknown[]) {
    myLog(level, '[goodgame]', ...msgs)
  }

  loadSmiles(): Promise<void> {
    if (
      this.smilesLoading ||
      Date.now() - this.smilesLoadedAtMs < SMILES_TTL_MS
    ) {
      return this.smilesLoading ?? Promise.resolve()
    }
    this.smilesLoading = (async () => {
      try {
        const response = await fetch(SMILES_URL, {
          headers: { accept: 'application/json' },
        })
        const list = await response.json()
        if (!Array.isArray(list)) throw new Error('not a list')
        const smiles = new Map<string, ChatEmote>()
        for (const item of list) {
          const smile = Smile(item)
          if (smile instanceof type.errors) continue
          const name = `:${smile.key}:`
          smiles.set(name, {
            id: String(smile.id),
            name,
            imageUrl: (smile.animated && smile.images.gif) || smile.images.big,
          })
        }
        this.smiles = smiles
        this.smilesLoadedAtMs = Date.now()
        this.log(LogLevel.DEBUG, `Loaded ${smiles.size} smiles`)
      } catch (error) {
        this.log(LogLevel.DEBUG, `Failed to load smiles: ${error}`)
      } finally {
        this.smilesLoading = null
      }
    })()
    return this.smilesLoading
  }

  async initWebsocket() {
    const ws = new WebSocket(WS_URL)
    this.websocket = ws

    ws.onopen = () => {
      this.log(LogLevel.DEBUG, 'Connection opened')
      this.startedAtMs = Temporal.Now.instant().epochMilliseconds
      ws.send(JSON.stringify({ type: 'auth', data: { user_id: 0 } }))
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
    if (typeof event.data !== 'string') {
      return
    }
    let frame: typeof WsEvent.infer
    try {
      const parsed = WsEvent(JSON.parse(event.data))
      if (parsed instanceof type.errors) return
      frame = parsed
    } catch {
      this.log(LogLevel.DEBUG, `Failed to parse msg as json: ${event.data}`)
      return
    }

    switch (frame.type) {
      case 'success_join':
        this.handleJoin(frame.data)
        break
      case 'message':
        this.handleChatMessage(frame.data)
        break
      case 'remove_message':
        this.handleRemoveMessage(frame.data)
        break
      case 'user_ban':
        this.handleUserBan(frame.data)
        break
    }
  }

  handleJoin(raw: unknown) {
    const data = JoinData(raw)
    if (data instanceof type.errors) {
      this.log(LogLevel.DEBUG, `Bad join data: ${data.summary}`)
      return
    }
    const roomId = data.channel_id as InternalChannelId
    const channel = this.reverseChannelsMap.get(roomId)
    if (!channel) return
    this.streamerIds.set(roomId, data.channel_streamer.id)
    this.log(LogLevel.DEBUG, `Joined channel: ${channel}`)
    this.channelStatus.set(channel, {
      channel,
      status: 'connected',
      joinedAtMs: Temporal.Now.instant().epochMilliseconds,
      joinedAtStr: Temporal.Now.instant().toString({ smallestUnit: 'seconds' }),
      uptimeMs: 0,
      messagesCount: 0,
    })
  }

  handleChatMessage(raw: unknown) {
    const data = MessageData(raw)
    if (data instanceof type.errors) {
      this.log(LogLevel.DEBUG, `Bad message data: ${data.summary}`)
      return
    }
    const roomId = data.channel_id as InternalChannelId
    const channel = this.reverseChannelsMap.get(roomId)
    if (!channel) return

    const emotes = new Map<string, ChatEmote>()
    for (const [code] of data.text.matchAll(SMILE_CODE)) {
      const smile = this.smiles.get(code)
      if (smile) emotes.set(code, smile)
    }

    const rights = data.user_rights ?? 0
    const colorName = data.color ?? ''
    const msg: ChatMessage = {
      id: String(data.message_id) as MessageId,
      user: {
        id: String(data.user_id) as UserId,
        displayName: data.user_name,
        goodgameFields: {
          color: GOODGAME_COLORS[colorName] ?? GOODGAME_COLORS.simple,
          colorName,
          icon: data.icon ?? '',
          rights,
          isStreamer: this.streamerIds.get(roomId) === data.user_id,
          // 10 is a channel moderator, 20 the streamer, higher ones are site staff
          isModerator: rights >= 10,
          subscriber: data.premiums?.includes(roomId) ?? false,
        },
      },
      timestampMs: data.timestamp * 1000,
      text: data.text,
      server: 'goodgame',
      channel,
      emotes: [...emotes.values()],
    }

    this.log(LogLevel.VERBOSE, `Parsed message: ${JSON.stringify(msg)}`)

    let storage = this.messages.get(channel)
    if (!storage) {
      storage = new MessageStorage()
      this.messages.set(channel, storage)
    }
    storage.addMessage(msg)
  }

  // Polled history is left as is for existing API clients; only live subscribers are told.
  handleRemoveMessage(raw: unknown) {
    const data = RemoveMessageData(raw)
    if (data instanceof type.errors) return
    const channel = this.reverseChannelsMap.get(
      data.channel_id as InternalChannelId,
    )
    if (!channel) return
    emit(toChatId('goodgame', channel), {
      type: 'delete',
      messageIds: [String(data.message_id) as MessageId],
    })
  }

  handleUserBan(raw: unknown) {
    const data = UserBanData(raw)
    if (data instanceof type.errors) return
    if (!data.type && !data.duration) return // unban
    const channel = this.reverseChannelsMap.get(
      data.channel_id as InternalChannelId,
    )
    if (!channel) return
    const userId = String(data.user_id)
    const messageIds = (this.messages.get(channel)?.messages ?? [])
      .filter((m) => m.user.id === userId)
      .map((m) => m.id)
    if (messageIds.length) {
      emit(toChatId('goodgame', channel), { type: 'delete', messageIds })
    }
  }

  sendPing(): Promise<void> {
    if (this.websocket) {
      this.send({ type: 'ping', data: {} })
    }
    return Promise.resolve()
  }

  async connect(channelOrig: string): Promise<void> {
    const channel = normalizeChannel(channelOrig)
    void this.loadSmiles()

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

    this.channelStatus.set(channel, {
      channel,
      status: 'connecting',
      joinedAtMs: Temporal.Now.instant().epochMilliseconds,
      joinedAtStr: Temporal.Now.instant().toString({ smallestUnit: 'seconds' }),
      uptimeMs: 0,
      messagesCount: 0,
    })

    const roomId = this.channelsMap.get(channel) ??
      await this.fetchChannelId(channel)
    if (!roomId) {
      this.log(LogLevel.DEBUG, `Failed to fetch channel ID of ${channel}`)
      this.channelStatus.delete(channel)
      return
    }

    if (!this.messages.has(channel)) {
      this.messages.set(channel, new MessageStorage())
    }

    this.channelsMap.set(channel, roomId)
    this.reverseChannelsMap.set(roomId, channel)

    // Socket may have closed while fetching; status is then 'disconnected' and the next connect retries
    this.send({
      type: 'join',
      data: { channel_id: roomId, hidden: 0, reload: false },
    })
  }

  // Channel pages are goodgame.ru/<streamer nick>, older links use the channel key; both name one room
  async fetchChannelId(
    channel: ChannelName,
  ): Promise<InternalChannelId | null> {
    const name = encodeURIComponent(channel)
    for (
      const url of [
        `https://goodgame.ru/api/4/users/${name}/stream`,
        `https://goodgame.ru/api/4/streams/${name}`,
      ]
    ) {
      try {
        const response = await fetch(url, {
          headers: { accept: 'application/json' },
        })
        const info = ChannelInfoResponse(await response.json())
        if (!(info instanceof type.errors)) {
          return String(info.id) as InternalChannelId
        }
      } catch (error) {
        this.log(LogLevel.DEBUG, `Failed to fetch channel info: ${error}`)
      }
    }
    return null
  }

  // Keys are numeric user ids; GoodGame has no batch lookup, so each user is one request
  fetchAvatars(ids: string[]): Promise<Record<string, string>> {
    return this.avatars.get(
      ids,
      (missing) =>
        lookupEach(missing, async (id) => {
          const response = await fetch(
            `https://goodgame.ru/api/4/users/${id}`,
            {
              headers: { accept: 'application/json' },
            },
          )
          if (response.status === 404) return ''
          if (!response.ok) {
            throw new Error(`GoodGame answered ${response.status}`)
          }
          const { avatar } = UserResponse.assert(await response.json())
          return avatar ? `https://static.goodgame.ru${avatar}` : ''
        }),
    )
  }

  disconnect(channelOrig: string): void {
    const channel = normalizeChannel(channelOrig)
    this.channelStatus.delete(channel)
    this.messages.delete(channel)

    const roomId = this.channelsMap.get(channel)
    if (!roomId) {
      return
    }
    this.send({ type: 'unjoin', data: { channel_id: roomId } })
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
    const storage = this.messages.get(normalizeChannel(channelOrig))
    return storage ? storage.getMessagesAfter(tsFrom) : []
  }

  getLastMessages(channelOrig: string, limit: number): ChatMessage[] {
    const storage = this.messages.get(normalizeChannel(channelOrig))
    return storage ? storage.getLastMessages(limit) : []
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

    let status: ConnectionStatus = 'disconnected'
    if (this.websocket?.readyState === WebSocket.OPEN) status = 'connected'
    else if (this.websocket?.readyState === WebSocket.CONNECTING) {
      status = 'connecting'
    }

    const channels: ChannelStatus[] = []
    for (const channel of this.channelStatus.keys()) {
      const channelStatus = this.getChannelStatus(channel)
      if (channelStatus) channels.push(channelStatus)
    }

    return {
      server: 'goodgame',
      status,
      startedAtMs: this.startedAtMs,
      startedAtStr,
      uptimeMs,
      channels,
    }
  }
}
