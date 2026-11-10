import {
  CHANNEL_INACTIVITY_TIMEOUT_MINUTES,
  LogLevel,
  TWITCH_CLIENT_ID,
} from '../../config.ts'
import { TwitchTokenManager } from './token_manager.ts'
import { myLog, sleep } from '../../utils.ts'
import { MessageStorage } from '../messageStorage.ts'
import {
  ChannelName,
  ChannelStatus,
  ChatConnector,
  ChatEmote,
  ChatMessage,
  ChatNotice,
  ChatServer,
  ChatUser,
  ConnectorStatus,
  MessageId,
  TwitchBadge,
  TwitchUserFields,
  UserId,
} from '../types.ts'
import {
  BadgeResponseSchema,
  BadgeVersion,
  CheermotesResponseSchema,
  RewardsResponseSchema,
  UserResponseSchema,
} from './schemas.ts'

// Client id of twitch.tv itself; its public GQL answers channel info without user auth
const TWITCH_WEB_CLIENT_ID = 'kimne78kx3ncx6brgo4mv6wki5h1ko'
const BADGE_RETRY_MS = 60_000
const GIANT_REWARDS_RETRY_MS = 60_000
const ROOM_MODES = ['emote-only', 'followers-only', 'r9k', 'slow', 'subs-only']

// IRCv3 tag value escapes: \s space, \: semicolon, \\ backslash, \r \n
function unescapeTag(value: string): string {
  const escapes: Record<string, string> = { s: ' ', ':': ';', r: '\r', n: '\n' }
  return value.replace(/\\(.)/g, (_, c: string) => escapes[c] ?? c)
}

// Cheermote prefix (lower case) -> tiers sorted by min_bits
type CheerTier = { minBits: number; color: string; imageUrl: string }
type Cheermotes = Map<string, CheerTier[]>
import { type } from 'arktype'
import { normalizeChannel, toChatId } from '../utils.ts'
import { emit } from '../chatEvents.ts'

type InternalChannelId = string & { readonly __brand: unique symbol }

type RawMsg = {
  userPart: string | null
  attrsPart: string
  channelPart: string | null
  message: string | null
}

type BoardcasterId = string & { readonly __brand: unique symbol }

class BroadcasterFetchError extends Error {
  constructor(channel: string) {
    super(`Channel ${channel} not found or banned`)
    this.name = 'BroadcasterFetchError'
  }
}

export class TwitchConnector implements ChatConnector {
  server: ChatServer = 'twitch'
  websocket: WebSocket | null = null

  // Shared by concurrent connect() calls so they don't send before the socket is open
  opening: Promise<void> | null = null

  channelsMap: Map<ChannelName, InternalChannelId> = new Map()
  reverseChannelsMap: Map<InternalChannelId, ChannelName> = new Map()

  broadcasterByChannel: Map<ChannelName, BoardcasterId> = new Map()

  globalBadges: Map<string, Map<string, BadgeVersion>> = new Map()
  badgesByChannel: Map<ChannelName, Map<string, Map<string, BadgeVersion>>> =
    new Map()
  // When each failed badge fetch may be retried; '' is the global set
  badgesRetryAt: Map<string, number> = new Map()
  cheermotesByChannel: Map<ChannelName, Cheermotes> = new Map()
  // Channel points rewards whose title or prompt carries FFZ:GE (FrankerFaceZ giant emote convention)
  giantRewardsByChannel: Map<ChannelName, Set<string>> = new Map()
  // When each channel's rewards may be asked again
  giantRewardsRetryAt: Map<ChannelName, number> = new Map()

  messages: Map<ChannelName, MessageStorage> = new Map()
  // Last known ROOMSTATE of each channel, to tell mode changes from the snapshot on join
  roomModes: Map<ChannelName, Map<string, string>> = new Map()
  usersById: Map<UserId, ChatUser> = new Map()

  channelStatus: Map<ChannelName, ChannelStatus> = new Map()

  tokenManager = new TwitchTokenManager()

  startedAtMs: number = 0

  constructor() {
    this.fetch_badges().then((badges) => {
      if (badges) this.globalBadges = badges
    }).catch((error) => {
      this.log(LogLevel.DEBUG, `Failed to fetch global badges: ${error}`)
    })
  }

  log(level: LogLevel, ...msgs: unknown[]) {
    myLog(level, `[${this.server}]`, ...msgs)
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
    if (
      status?.status === 'connecting' || status?.status === 'connected'
    ) {
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

    if (!this.messages.has(channel)) {
      this.messages.set(channel, new MessageStorage())
    }

    // Badges are supplementary metadata - if Helix is flaky we still want to
    // join the channel and read messages instead of getting stuck forever in
    // the 'connecting' state.
    this.refreshGiantRewards(channel)
    try {
      const channelBadges = await this.fetch_badges(channel)
      if (channelBadges) this.badgesByChannel.set(channel, channelBadges)
      // Cheer images are as optional as badges: a failure only costs the pictures
      this.fetch_cheermotes(channel)
        .then((cheermotes) => this.cheermotesByChannel.set(channel, cheermotes))
        .catch((error) =>
          this.log(LogLevel.DEBUG, `Failed to fetch cheermotes: ${error}`)
        )
    } catch (error) {
      this.log(
        LogLevel.DEBUG,
        `Failed to fetch badges for channel ${channel}: ${error}`,
      )
      // If the channel doesn't exist or is banned, disconnect it
      if (error instanceof BroadcasterFetchError) {
        this.disconnect(channel)
      }
    }

    const channelLower = channel.toLowerCase() as ChannelName
    const channelId = `#${channelLower}` as InternalChannelId

    this.channelsMap.set(channelLower, channelId)
    this.reverseChannelsMap.set(channelId, channelLower)

    this.websocketSend(`JOIN ${channelId}`)
  }

  disconnect(channelOrig: string): void {
    const channel = normalizeChannel(channelOrig)
    this.log(LogLevel.DEBUG, `Disconnecting from channel: ${channel}`)
    const channelId = this.channelsMap.get(channel)
    if (channelId) {
      this.websocketSend(`PART ${channelId}`)
    }
    this.channelStatus.delete(channel)
    this.messages.delete(channel)
  }

  websocketSend(message: string) {
    if (this.websocket?.readyState !== WebSocket.OPEN) {
      this.log(
        LogLevel.DEBUG,
        `Failed to send message, websocket not open: [${message}]`,
      )
      return
    }
    // this.log(`Sending: [${message}]`)
    this.websocket.send(`${message}\r\n`)
  }

  async initWebsocket() {
    const ws = new WebSocket('wss://irc-ws.chat.twitch.tv:443', {
      headers: {
        Origin: 'https://www.twitch.tv',
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

    this.log(
      LogLevel.DEBUG,
      `ws state: ${ws.readyState} (expected: ${WebSocket.OPEN})`,
    )
    if (ws.readyState !== WebSocket.OPEN) return

    // Anonymous read-only login: we never send chat messages, so there's no
    // need for a real Twitch account/OAuth token to join channels and read
    // messages (badges/attrs arrive via IRC tags regardless of auth).
    const anonymousNick = `justinfan${Math.floor(Math.random() * 100000)}`
    this.websocketSend('PASS just_a_password')
    this.websocketSend(`NICK ${anonymousNick}`)
    // commands: CLEARMSG/CLEARCHAT, so deleted messages leave overlays
    this.websocketSend('CAP REQ :twitch.tv/tags twitch.tv/commands')
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
    const frames = event.data.split('\r\n')
    for (const frame of frames) {
      const trimmed = frame.trim()
      if (!trimmed) {
        continue
      }

      if (trimmed === 'PING :tmi.twitch.tv') {
        this.websocketSend('PONG :tmi.twitch.tv')
        continue
      }
      if (this.handleModeration(trimmed) || this.handleRoomState(trimmed)) {
        continue
      }
      const msg = this.parseMessage(trimmed)
      if (msg) {
        this.storageFor(msg.channel).addMessage(msg)
      }
    }
  }

  storageFor(channel: ChannelName): MessageStorage {
    let storage = this.messages.get(channel)
    if (!storage) {
      storage = new MessageStorage()
      this.messages.set(channel, storage)
    }
    return storage
  }

  // A system line Twitch sends no message for: timeouts, bans, chat clears, mode changes
  addNotice(
    channel: ChannelName,
    login: string,
    notice: ChatNotice,
    timestampMs = Temporal.Now.instant().epochMilliseconds,
  ) {
    this.storageFor(channel).addMessage({
      id: crypto.randomUUID() as MessageId,
      timestampMs,
      user: { id: login as UserId, displayName: login },
      server: 'twitch',
      channel,
      text: '',
      notice,
    })
  }

  // ROOMSTATE carries every mode on join and only the changed one after;
  // a mode becomes a notice when it differs from what we already knew
  handleRoomState(msg: string): boolean {
    const parts = msg.split(' ')
    if (parts[2] !== 'ROOMSTATE') {
      return false
    }
    const channel = this.reverseChannelsMap.get(
      parts[3]?.toLowerCase() as InternalChannelId,
    )
    if (!channel) {
      return true
    }
    const attrs = this.parseAttrs(parts[0])
    const known = this.roomModes.get(channel)
    const modes = known ?? new Map<string, string>()
    this.roomModes.set(channel, modes)
    for (const mode of ROOM_MODES) {
      const value = attrs[mode]
      if (value === undefined || modes.get(mode) === value) {
        continue
      }
      if (known) {
        this.addNotice(channel, '', {
          kind: 'roomstate',
          params: { mode, value },
          systemText: '',
        })
      }
      modes.set(mode, value)
    }
    return true
  }

  // CLEARMSG: one message deleted; CLEARCHAT: user banned/timed out, or whole chat cleared.
  // Only live subscribers are told: polled history stays as is for existing API clients
  handleModeration(msg: string): boolean {
    const parts = msg.split(' ')
    const command = parts[2]
    if (command !== 'CLEARMSG' && command !== 'CLEARCHAT') {
      return false
    }
    const channel = this.reverseChannelsMap.get(
      parts[3]?.toLowerCase() as InternalChannelId,
    )
    if (!channel) {
      return true
    }
    const attrs = this.parseAttrs(parts[0])
    const storage = this.messages.get(channel)
    const chatId = toChatId(this.server, channel)
    const timestampMs = attrs['tmi-sent-ts']
      ? Number(attrs['tmi-sent-ts'])
      : undefined

    if (command === 'CLEARMSG') {
      const messageId = attrs['target-msg-id'] as MessageId | undefined
      if (messageId) {
        emit(chatId, { type: 'delete', messageIds: [messageId] })
      }
    } else if (attrs['target-user-id']) {
      const userId = attrs['target-user-id']
      const messageIds = (storage?.messages ?? [])
        .filter((m) => m.user.twitchFields?.userId === userId)
        .map((m) => m.id)
      if (messageIds.length) {
        emit(chatId, { type: 'delete', messageIds })
      }
      // Timeout when ban-duration (seconds) is there, permanent ban otherwise; the login is the trailing param
      const duration = attrs['ban-duration']
      this.addNotice(channel, parts[4]?.slice(1) ?? '', {
        kind: duration ? 'timeout' : 'ban',
        params: duration ? { duration } : {},
        systemText: '',
      }, timestampMs)
    } else {
      emit(chatId, { type: 'clear' })
      this.addNotice(
        channel,
        '',
        { kind: 'clear', params: {}, systemText: '' },
        timestampMs,
      )
    }
    return true
  }

  // Twitch emote positions are code point ranges: "25:0-4,12-16/1902:6-10"
  parseEmotes(emotesTag: string | undefined, text: string): ChatEmote[] {
    if (!emotesTag) {
      return []
    }
    const chars = Array.from(text)
    const result: ChatEmote[] = []
    for (const emote of emotesTag.split('/')) {
      const [id, ranges] = emote.split(':')
      const [start, end] = (ranges ?? '').split(',')[0].split('-').map(Number)
      if (!id || !Number.isInteger(start) || !Number.isInteger(end)) {
        continue
      }
      result.push({
        id,
        name: chars.slice(start, end + 1).join(''),
        imageUrl:
          `https://static-cdn.jtvnw.net/emoticons/v2/${id}/default/dark/3.0`,
      })
    }
    return result
  }

  // GIF keyboard: "start-end|id|url,..." over code point ranges of the text
  parseGifs(gifsTag: string | undefined, text: string): ChatEmote[] {
    if (!gifsTag) {
      return []
    }
    const chars = Array.from(text)
    const result: ChatEmote[] = []
    for (const entry of gifsTag.split(',')) {
      const parts = entry.split('|')
      // A URL may itself contain "|", so everything past the id belongs to it
      const url = parts.slice(2).join('|')
      const [start, end] = (parts[0] ?? '').split('-').map(Number)
      if (
        !Number.isInteger(start) || !Number.isInteger(end) || start < 0 ||
        end < start || !/^https:\/\//i.test(url)
      ) {
        continue
      }
      result.push({
        id: parts[1] ?? '',
        name: chars.slice(start, end + 1).join(''),
        imageUrl: url,
        kind: 'gif',
      })
    }
    return result
  }

  // "Cheer100 nice Kappa50" in a message with bits: each cheer word becomes its tier image
  parseCheers(
    channel: ChannelName,
    bitsTag: string | undefined,
    text: string,
  ): ChatEmote[] {
    const cheermotes = this.cheermotesByChannel.get(channel)
    if (!cheermotes || !(Number(bitsTag) > 0)) {
      return []
    }
    const result: ChatEmote[] = []
    for (const word of text.split(/\s+/)) {
      const match = /^([a-z]+)(\d+)$/i.exec(word)
      const tiers = match && cheermotes.get(match[1].toLowerCase())
      if (!match || !tiers) {
        continue
      }
      const bits = Number(match[2])
      const tier = tiers.filter((t) => t.minBits <= bits).at(-1) ?? tiers[0]
      result.push({
        id: match[1].toLowerCase(),
        name: word,
        imageUrl: tier.imageUrl,
        kind: 'cheer',
        bits,
        color: tier.color,
      })
    }
    return result
  }

  parseMessage(msg: string): ChatMessage | null {
    const parts = msg.split(' ')

    if (parts.length === 3 && parts[1] === 'JOIN') {
      const channel = this.reverseChannelsMap.get(
        parts[2].toLowerCase() as InternalChannelId,
      )
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
      }
      return null
    }

    // Handle NOTICE messages for errors (e.g., banned/suspended channels)
    if (parts.length >= 4 && parts[1] === 'NOTICE') {
      const channelId = parts[3].toLowerCase() as InternalChannelId
      const channel = this.reverseChannelsMap.get(channelId)
      if (channel) {
        const message = parts.slice(4).join(' ').slice(1)
        this.log(LogLevel.DEBUG, `NOTICE for ${channel}: ${message}`)

        // Check for ban/suspend errors
        if (
          message.includes('suspended') ||
          message.includes('banned') ||
          message.includes('does not exist')
        ) {
          this.log(
            LogLevel.DEBUG,
            `Channel ${channel} is banned/suspended, disconnecting`,
          )
          this.disconnect(channel)
        }
      }
      return null
    }

    // USERNOTICE: subs, gifts, raids, watch streaks...; the user's own message is optional
    const commandIndex = [1, 2].find((i) =>
      parts[i] === 'PRIVMSG' || parts[i] === 'USERNOTICE'
    )
    if (commandIndex === undefined) {
      return null
    }
    const isNotice = parts[commandIndex] === 'USERNOTICE'

    const rawMsg: RawMsg = {
      userPart: null,
      attrsPart: '',
      message: null,
      channelPart: null,
    }

    if (commandIndex === 1) {
      rawMsg.userPart = parts[0]
      rawMsg.channelPart = parts[2].toLowerCase()
      rawMsg.message = parts.slice(3).join(' ')
    } else {
      rawMsg.attrsPart = parts[0]
      rawMsg.userPart = parts[1]
      rawMsg.channelPart = parts[3].toLowerCase()
      rawMsg.message = parts.slice(4).join(' ')
    }

    if (
      !rawMsg.userPart || !rawMsg.channelPart || rawMsg.message === null ||
      (!isNotice && !rawMsg.message)
    ) {
      this.log(
        LogLevel.DEBUG,
        `Failed to parse PRIVMSG: missing parts raw: ${msg}`,
      )
      return null
    }

    const channelId = rawMsg.channelPart as InternalChannelId
    const channel = this.reverseChannelsMap.get(channelId)
    if (!channel) {
      this.log(LogLevel.DEBUG, `Unknown channel: ${channelId} raw: ${msg}`)
      return null
    }

    const attrs = this.parseAttrs(rawMsg.attrsPart)

    const badgeStr = attrs['badges'] ?? ''
    delete attrs['badges']
    const badges = this.parseBadges(channel, badgeStr)

    // USERNOTICE comes from :tmi.twitch.tv; the user is in the login tag
    const username =
      (isNotice
        ? attrs['login'] ?? ''
        : rawMsg.userPart.split('!')[0].slice(1)) as UserId

    const noticeKind = attrs['msg-id'] ?? ''
    // Shared Chat copies of other channels' subs, raids... are not about this channel
    if (isNotice && noticeKind === 'sharedchatnotice') {
      return null
    }
    // A mass gift sends its summary (submysterygift), then one subgift per recipient; those are left out.
    // msg-param-community-gift-id is not in the docs, but Twitch sends it on exactly these subgifts
    if (
      isNotice && noticeKind === 'subgift' &&
      attrs['msg-param-community-gift-id']
    ) {
      return null
    }

    // A reward we don't know: created or renamed to FFZ:GE after the join, or the first fetch failed
    const rewardId = attrs['custom-reward-id']
    if (rewardId && !this.giantRewardsByChannel.get(channel)?.has(rewardId)) {
      this.refreshGiantRewards(channel)
    }

    const twitchFields: TwitchUserFields = {
      userId: attrs['user-id'] ?? '',
      color: attrs['color'] ?? '',
      mod: attrs['mod'] === '1',
      subscriber: attrs['subscriber'] === '1',
      turbo: attrs['turbo'] === '1',
      highlighted: attrs['msg-id'] === 'highlighted-message',
      giantEmote: attrs['msg-id'] === 'gigantified-emote-message' ||
        (this.giantRewardsByChannel.get(channel)?.has(
          attrs['custom-reward-id'] ?? '',
        ) ?? false),
      firstMessage: attrs['first-msg'] === '1',
      badges,
    }

    if (!this.usersById.has(username)) {
      this.usersById.set(username, {
        id: username,
        displayName: username,
        twitchFields,
      })
    }

    const messageUser: ChatUser = {
      id: username,
      displayName: attrs['display-name'] ?? username,
      twitchFields,
    }

    const timestampMs = attrs['tmi-sent-ts']
      ? Number(attrs['tmi-sent-ts'])
      : Temporal.Now.instant().epochMilliseconds

    const text = rawMsg.message.slice(1)
    const message: ChatMessage = {
      id: (attrs['id'] ?? crypto.randomUUID()) as MessageId,
      timestampMs,
      user: messageUser,
      server: 'twitch',
      channel,
      text,
      emotes: [
        ...this.parseEmotes(attrs['emotes'], text),
        ...this.parseGifs(attrs['gifs'], text),
        ...this.parseCheers(channel, attrs['bits'], text),
      ],
    }
    if (isNotice) {
      const params: Record<string, string> = {}
      for (const [key, value] of Object.entries(attrs)) {
        if (key.startsWith('msg-param-')) {
          params[key.slice('msg-param-'.length)] = unescapeTag(value)
        }
      }
      message.notice = {
        kind: noticeKind,
        params,
        systemText: unescapeTag(attrs['system-msg'] ?? ''),
      }
    }
    if (message.text.trim()) {
      this.log(LogLevel.VERBOSE, `Parsed message: ${JSON.stringify(message)}`)
    }
    return message
  }

  parseAttrs(attrsStr: string): Record<string, string> {
    const parts = attrsStr.replace(/^@/, '').split(';')
    const keys = new Set([
      'user-id',
      'emotes',
      'target-msg-id',
      'target-user-id',
      'bits',
      'gifs',
      'custom-reward-id',
      'color',
      'badges',
      'display-name',
      'id',
      'tmi-sent-ts',
      'subscriber',
      'vip',
      'mod',
      'turbo',
      'msg-id',
      'first-msg',
      'login',
      'system-msg',
      'ban-duration',
      ...ROOM_MODES,
    ])
    const attrs: Record<string, string> = {}
    for (const part of parts) {
      // Split at the first "=" only: system-msg and plan names may contain more
      const eq = part.indexOf('=')
      const key = part.slice(0, eq)
      if (eq > 0 && (keys.has(key) || key.startsWith('msg-param-'))) {
        attrs[key] = part.slice(eq + 1)
      }
    }

    return attrs
  }

  // A badge fetch that failed (Helix hiccup, expired token) is retried at most once a minute;
  // a channel without badges of its own has an empty set and is not asked again
  retryMissingBadges(channel: ChannelName) {
    const missing: (ChannelName | undefined)[] = []
    if (!this.globalBadges.size) missing.push(undefined)
    if (!this.badgesByChannel.has(channel)) missing.push(channel)
    const now = Date.now()
    for (const target of missing) {
      const key = target ?? ''
      if ((this.badgesRetryAt.get(key) ?? 0) > now) continue
      this.badgesRetryAt.set(key, now + BADGE_RETRY_MS)
      this.fetch_badges(target).then((badges) => {
        if (!badges) return
        if (target) this.badgesByChannel.set(target, badges)
        else this.globalBadges = badges
      }).catch((error) =>
        this.log(LogLevel.DEBUG, `Badge retry for ${key} failed: ${error}`)
      )
    }
  }

  parseBadges(channel: ChannelName, badgeValue: string): TwitchBadge[] {
    this.retryMissingBadges(channel)
    const parts = badgeValue.split(',')
    const result: TwitchBadge[] = []
    for (const badge of parts) {
      const split = badge.split('/')
      if (split.length !== 2) {
        continue
      }
      const badgeObj = this.getBadge({
        channel,
        setId: split[0],
        versionId: split[1],
      })
      if (badgeObj) {
        result.push({
          id: badgeObj.id,
          title: badgeObj.title,
          imageUrl: badgeObj.image_url_4x,
        })
      }
    }
    return result
  }

  async web_auth_headers() {
    const accessToken = await this.tokenManager.getAccessToken()
    return {
      Authorization: `Bearer ${accessToken}`,
      'Client-Id': TWITCH_CLIENT_ID,
    }
  }

  async fetch_broadcaster_id(channel: ChannelName): Promise<BoardcasterId> {
    const existingId = this.broadcasterByChannel.get(channel)
    if (existingId) {
      return existingId
    }

    const response = await fetch(
      `https://api.twitch.tv/helix/users?login=${channel}`,
      {
        headers: await this.web_auth_headers(),
      },
    )
    const data = await response.json()
    const parsed = UserResponseSchema.assert(data)
    if (!parsed.data[0]) {
      throw new BroadcasterFetchError(channel)
    }
    const id = parsed.data[0].id as BoardcasterId
    this.broadcasterByChannel.set(channel, id)
    return id
  }

  // null when Twitch did not answer, so the caller can try again later
  async fetch_badges(
    channel?: ChannelName,
  ): Promise<Map<string, Map<string, BadgeVersion>> | null> {
    const broadcasterId = channel
      ? await this.fetch_broadcaster_id(channel)
      : undefined
    const url = broadcasterId
      ? `https://api.twitch.tv/helix/chat/badges?broadcaster_id=${broadcasterId}`
      : 'https://api.twitch.tv/helix/chat/badges/global'

    const response = await fetch(
      url,
      {
        headers: await this.web_auth_headers(),
      },
    )

    if (!response.ok) {
      this.log(
        LogLevel.DEBUG,
        'Failed to fetch badges, probably invalid auth token:',
        response.status,
        response.statusText,
      )
      return null
    }

    const data = await response.json()

    const badgesResponse = BadgeResponseSchema(data)
    if (badgesResponse instanceof type.errors) {
      this.log(
        LogLevel.DEBUG,
        'Failed to parse badges response:' + badgesResponse.issues,
      )
      return null
    }
    const badgesDict: Map<string, Map<string, BadgeVersion>> = new Map()
    for (const badge of badgesResponse.data) {
      badgesDict.set(
        badge.set_id,
        new Map(badge.versions.map((v) => [v.id, v])),
      )
    }
    return badgesDict
  }

  // At most once a minute per channel
  refreshGiantRewards(channel: ChannelName) {
    const now = Date.now()
    if ((this.giantRewardsRetryAt.get(channel) ?? 0) > now) return
    this.giantRewardsRetryAt.set(channel, now + GIANT_REWARDS_RETRY_MS)
    this.fetch_giant_rewards(channel)
      .then((rewards) => this.giantRewardsByChannel.set(channel, rewards))
      .catch((error) =>
        this.log(LogLevel.DEBUG, `Failed to fetch rewards: ${error}`)
      )
  }

  // Reward titles aren't in IRC (only custom-reward-id); Twitch's public web GQL lists them without auth
  async fetch_giant_rewards(channel: ChannelName): Promise<Set<string>> {
    const response = await fetch('https://gql.twitch.tv/gql', {
      method: 'POST',
      headers: {
        'Client-Id': TWITCH_WEB_CLIENT_ID,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        query:
          'query($login: String!) { channel(name: $login) { communityPointsSettings { customRewards { id title prompt } } } }',
        variables: { login: channel },
      }),
    })
    if (!response.ok) {
      throw new Error(`rewards: ${response.status}`)
    }
    const parsed = RewardsResponseSchema(await response.json())
    if (parsed instanceof type.errors) {
      throw new Error(`rewards: ${parsed.summary}`)
    }
    const rewards =
      parsed.data.channel?.communityPointsSettings?.customRewards ?? []
    return new Set(
      rewards
        .filter((r) => `${r.title} ${r.prompt ?? ''}`.includes('FFZ:GE'))
        .map((r) => r.id),
    )
  }

  async fetch_cheermotes(channel: ChannelName): Promise<Cheermotes> {
    const broadcasterId = await this.fetch_broadcaster_id(channel)
    const response = await fetch(
      `https://api.twitch.tv/helix/bits/cheermotes?broadcaster_id=${broadcasterId}`,
      { headers: await this.web_auth_headers() },
    )
    if (!response.ok) {
      throw new Error(`cheermotes: ${response.status}`)
    }
    const parsed = CheermotesResponseSchema(await response.json())
    if (parsed instanceof type.errors) {
      throw new Error(`cheermotes: ${parsed.summary}`)
    }
    const cheermotes: Cheermotes = new Map()
    for (const cheer of parsed.data) {
      cheermotes.set(
        cheer.prefix.toLowerCase(),
        cheer.tiers
          .map((t) => ({
            minBits: t.min_bits,
            color: t.color,
            imageUrl: t.images.dark.animated['4'],
          }))
          .sort((a, b) => a.minBits - b.minBits),
      )
    }
    return cheermotes
  }

  getBadge(params: {
    channel: ChannelName
    setId: string
    versionId: string
  }): BadgeVersion | undefined {
    // The channel's own subscriber and bits badges replace Twitch's default ones
    return this.badgesByChannel.get(params.channel)?.get(params.setId)?.get(
      params.versionId,
    ) ?? this.globalBadges.get(params.setId)?.get(params.versionId)
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

  async refreshToken(): Promise<void> {
    await this.tokenManager.maybeRefreshToken()
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
      server: 'twitch',
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
