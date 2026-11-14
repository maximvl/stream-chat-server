import {
  ChannelName,
  ChannelStatus,
  ChatConnector,
  ChatEmote,
  ChatMessage,
  ChatPin,
  ChatPoll,
  ChatUser,
  ConnectorStatus,
  MessageId,
  UserId,
  VkMessageFields,
} from '../types.ts'
import * as cheerio from 'cheerio'
import {
  AppConfig,
  ChannelInfoResponse,
  ContentData,
  PinnedMessage,
  PinnedMessageResponse,
  PollResponse,
  StreamPoll,
  VkColorsMap,
  WsChatMessage,
  WsErrorMessage,
  WsPush,
  WsSubscribeMessage,
} from './schemas.ts'
import { type } from 'arktype'
import { CHANNEL_INACTIVITY_TIMEOUT_MINUTES, LogLevel } from '../../config.ts'
import { myLog, sleep } from '../../utils.ts'
import { MessageStorage } from '../messageStorage.ts'
import { normalizeChannel, toChatId } from '../utils.ts'
import { forgetState, setPin, setPoll } from '../chatEvents.ts'
import { httpsOnly } from '../avatars.ts'

type InternalChannelId = string & { readonly __brand: unique symbol }

export class VkVideoConnector implements ChatConnector {
  server: 'vkvideo' = 'vkvideo'
  websocketToken: string | null = null
  websocketHost: string | null = null

  websocket: WebSocket | null = null
  startedAtMs: number = 0

  // Shared by concurrent connect() calls so they don't send before the socket is open
  opening: Promise<void> | null = null

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

    const ws = new WebSocket(this.websocketHost, {
      headers: {
        Origin: 'https://live.vkvideo.ru',
      },
    })
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

    this.messageCounter++
    const loginMessage = {
      id: this.messageCounter,
      connect: {
        token: this.websocketToken,
        name: 'js',
      },
    }
    this.send(loginMessage)
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

    if (event.data === '{}') {
      this.send({})
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

    const errorMsg = WsErrorMessage(jsonData)
    if (!(errorMsg instanceof type.errors)) {
      this.log(
        LogLevel.DEBUG,
        `Received error message: ${
          JSON.stringify(errorMsg)
        } raw: ${event.data}`,
      )
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

    const push = WsPush(jsonData)
    if (
      !(push instanceof type.errors) && push.push.pub.data.type !== 'message'
    ) {
      this.handleStatePush(push)
      return
    }

    const chatMsg = WsChatMessage(jsonData)
    if (chatMsg instanceof type.errors) {
      this.log(
        LogLevel.DEBUG,
        `Failed to parse chat message: ${
          JSON.stringify(chatMsg.issues)
        } raw: ${event.data}`,
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

    const { text, emotes, mentions } = parseContent(data.data)

    // The picture by id answers VK's placeholder for users without an avatar
    const avatarUrl = httpsOnly(data.author.avatarUrl) ||
      `https://images.live.vkvideo.ru/user/${data.author.id}/avatar`
    const msgUser: ChatUser = {
      id: data.author.id.toString() as UserId,
      displayName: data.author.displayName,
      avatarUrl,
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
      text,
      server: 'vkvideo',
      channel,
      emotes,
      vkFields: {
        mentions,
      },
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

  async connect(channelOrig: string) {
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

    const nextMessageId = this.messageCounter++
    this.subMsgChannelMap.set(nextMessageId, channel)

    // Socket may have closed while fetching; status is then 'disconnected' and the next connect retries
    this.send({
      id: nextMessageId,
      subscribe: {
        channel: channelId,
      },
    })
    const infoId = infoChannel(channelId)
    this.reverseChannelsMap.set(infoId, channel)
    this.send({ id: this.messageCounter++, subscribe: { channel: infoId } })
    this.fetchPinPoll(channel)
  }

  disconnect(channelOrig: string) {
    const channel = normalizeChannel(channelOrig)
    this.channelStatus.delete(channel)
    this.messages.delete(channel)

    const channelId = this.channelsMap.get(channel)
    if (!channelId) {
      return
    }
    this.send({
      id: this.messageCounter++,
      unsubscribe: {
        channel: channelId,
      },
    })
    this.send({
      id: this.messageCounter++,
      unsubscribe: { channel: infoChannel(channelId) },
    })
    forgetState(toChatId('vkvideo', channel))
  }

  // Pinned message on the chat channel, the stream's poll on the info channel
  handleStatePush(push: typeof WsPush.infer) {
    const channel = this.reverseChannelsMap.get(
      push.push.channel as InternalChannelId,
    )
    if (!channel) return
    const chatId = toChatId('vkvideo', channel)
    const { type: kind, data } = push.push.pub.data
    switch (kind) {
      case 'chat_pinned_message_pin':
      case 'chat_pinned_message_edit':
        setPin(chatId, vkPin(data))
        break
      case 'chat_pinned_message_unpin':
        setPin(chatId, null)
        break
      case 'poll':
        setPoll(chatId, vkPoll(data))
    }
  }

  // The pin and poll already up when the channel is joined; later changes come from the socket
  async fetchPinPoll(channel: ChannelName) {
    const chatId = toChatId('vkvideo', channel)
    const base =
      `https://api.live.vkvideo.ru/v1/channel/${channel}/stream/slot/default`
    try {
      const response = await fetch(`${base}/chat/pinned_message`)
      const pinned = PinnedMessageResponse(await response.json())
      if (!(pinned instanceof type.errors)) {
        setPin(chatId, vkPin(pinned.data.pinnedMessage))
      }
    } catch (error) {
      this.log(LogLevel.DEBUG, `Failed to fetch pinned message: ${error}`)
    }
    try {
      const response = await fetch(`${base}/poll`)
      const poll = PollResponse(await response.json())
      if (!(poll instanceof type.errors)) {
        setPoll(chatId, vkPoll(poll.data.poll))
      }
    } catch (error) {
      this.log(LogLevel.DEBUG, `Failed to fetch poll: ${error}`)
    }
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

const infoChannel = (chatChannel: InternalChannelId) =>
  chatChannel.replace('channel-chat:', 'channel-info:') as InternalChannelId

// Text with mentions and smiles put back in place, smiles also listed as emotes
function parseContent(parts: (typeof ContentData.infer)[]) {
  const mentions: VkMessageFields['mentions'] = []
  const messageParts: string[] = []
  const emotes: ChatEmote[] = []

  for (const content of parts) {
    if (!('type' in content)) {
      continue
    }
    switch (content.type) {
      case 'mention':
        mentions.push({
          id: content.id,
          displayName: content.displayName,
        })
        // VK sends the mentioned nick only as this part, so put it back into the text
        messageParts.push(`@${content.displayName}`)
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
        break
      case 'smile':
        // Kept as its name in the text, like Twitch emotes, so clients can swap it for the image
        messageParts.push(content.name)
        emotes.push({
          id: content.id,
          name: content.name,
          imageUrl: content.largeUrl,
        })
    }
  }
  return { text: messageParts.join(' '), emotes, mentions }
}

// The WebSocket sends the message itself, the REST API wraps it as pinnedMessage
function vkPin(raw: unknown): ChatPin | null {
  const pin = PinnedMessage(
    (raw as { pinnedMessage?: unknown } | null)?.pinnedMessage ?? raw,
  )
  if (pin instanceof type.errors) return null
  const { text, emotes } = parseContent(pin.data)
  const author = pin.author
  return {
    id: String(pin.id),
    user: {
      id: String(author.id) as UserId,
      displayName: author.displayName,
      avatarUrl: httpsOnly(author.avatarUrl) ||
        `https://images.live.vkvideo.ru/user/${author.id}/avatar`,
      vkFields: {
        nickColor: author.nickColor,
        isChatModerator: false,
        isChannelModerator: false,
        roles: [],
        badges: [],
        color: VkColorsMap[author.nickColor],
      },
    },
    text,
    emotes,
  }
}

function vkPoll(raw: unknown): ChatPoll | null {
  const poll = StreamPoll(raw)
  if (poll instanceof type.errors || poll.state === 'canceled') return null
  const ended = poll.state === 'ended'
  return {
    id: String(poll.id),
    title: poll.title,
    choices: poll.decisions.map((d) => ({
      title: d.name,
      votes: d.votesCount,
    })),
    ...(!ended && poll.createdAt && poll.duration && {
      endsAtMs: (poll.createdAt + poll.duration) * 1000,
    }),
    ended,
  }
}
