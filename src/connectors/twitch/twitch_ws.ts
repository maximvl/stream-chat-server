import {
  TWITCH_CLIENT_ID,
  TWITCH_OAUTH_TOKEN,
  TWITCH_USERNAME,
} from '../../config.ts'
import { LogLevel, myLog, sleep } from '../../utils.ts'
import { ChannelName, ChatServer } from '../types.ts'
import {
  BadgeResponseSchema,
  BadgeVersion,
  UserResponseSchema,
} from './schemas.ts'

type ChannelId = string & { readonly __brand: unique symbol }

type RawMsg = {
  userPart: string | null
  attrsPart: string
  channelPart: string | null
  message: string | null
}

type ParsedMsg = {
  user: string
  badges: Record<string, string>
  attrs: Record<string, string>
  channel: string
  message: string
}

type BoardcasterId = string & { readonly __brand: unique symbol }

class TwitchConnector {
  server: ChatServer = 'twitch'
  websocket: WebSocket | null = null
  channelsMap: Map<ChannelName, ChannelId> = new Map()
  reverseChannelsMap: Map<ChannelId, ChannelName> = new Map()

  broadcastersMap: Map<ChannelName, BoardcasterId> = new Map()

  connectingChannels: Set<ChannelName> = new Set()

  globalBadges: Map<string, Map<string, BadgeVersion>> = new Map()
  badgesByChannel: Map<ChannelName, Map<string, Map<string, BadgeVersion>>> =
    new Map()

  constructor() {
    this.fetch_badges().then((badges) => {
      this.globalBadges = badges
    })
  }

  log(level: LogLevel, msg: string) {
    myLog(level, `[${this.server}] ${msg}`)
  }

  async connect(channel: ChannelName) {
    if (!this.websocket) {
      await this.initWebsocket()
    }
    if (!this.websocket) {
      this.log(LogLevel.DEBUG, 'Failed to connect')
      return
    }

    if (this.connectingChannels.has(channel)) {
      return
    }

    this.connectingChannels.add(channel)

    const channelBadges = await this.fetch_badges(channel)
    this.badgesByChannel.set(channel, channelBadges)

    const channelLower = channel.toLowerCase() as ChannelName
    const channelId = `#${channelLower}` as ChannelId

    this.channelsMap.set(channelLower, channelId)
    this.reverseChannelsMap.set(channelId, channelLower)

    this.websocketSend(`JOIN ${channelId}`)
  }

  websocketSend(message: string) {
    if (!this.websocket) {
      this.log(
        LogLevel.DEBUG,
        `Failed to send message, websocket not initialized: [${message}]`,
      )
      return
    }
    // this.log(`Sending: [${message}]`)
    this.websocket.send(`${message}\r\n`)
  }

  async initWebsocket() {
    this.websocket = new WebSocket('wss://irc-ws.chat.twitch.tv:443', {
      headers: {
        Origin: 'https://www.twitch.tv',
      },
    })
    this.websocket.onopen = () => {
      this.log(LogLevel.DEBUG, 'Connection opened')
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

    while (this.websocket?.readyState !== WebSocket.OPEN) {
      this.log(LogLevel.DEBUG, 'Waiting for connection to open...')
      // Small delay to avoid busy waiting
      await sleep(200)
    }

    this.log(
      LogLevel.DEBUG,
      `ws state: ${this.websocket?.readyState} (expected: ${WebSocket.OPEN})`,
    )

    this.websocketSend(`PASS oauth:${TWITCH_OAUTH_TOKEN}`)
    this.websocketSend(`NICK ${TWITCH_USERNAME}`)
    this.websocketSend('CAP REQ :twitch.tv/tags')
  }

  handleClose() {
    this.log(LogLevel.DEBUG, 'Connection closed')
    this.websocket?.close()
    this.websocket = null
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
      this.log(LogLevel.ALL, `Received frame: [${trimmed}]`)

      if (trimmed === 'PING :tmi.twitch.tv') {
        this.websocketSend('PONG :tmi.twitch.tv')
        continue
      }
      if (trimmed) {
        this.parseMessage(trimmed)
      }
    }
  }

  parseMessage(msg: string) {
    const parts = msg.split(' ')

    if (parts.length === 3 && parts[1] === 'JOIN') {
      const channel = this.reverseChannelsMap.get(parts[2] as ChannelId)
      this.log(LogLevel.DEBUG, `Connected to channel: ${channel}`)
      this.connectingChannels.delete(channel!)
      return
    }

    const privMsgIndex = parts.indexOf('PRIVMSG')
    if (privMsgIndex === -1) {
      return
    }

    const rawMsg: RawMsg = {
      userPart: null,
      attrsPart: '',
      message: null,
      channelPart: null,
    }

    if (privMsgIndex === 1) {
      rawMsg.userPart = parts[0]
      rawMsg.channelPart = parts[2].toLowerCase()
      rawMsg.message = parts.slice(3).join(' ')
    } else if (privMsgIndex === 2) {
      rawMsg.attrsPart = parts[0]
      rawMsg.userPart = parts[1]
      rawMsg.channelPart = parts[3].toLowerCase()
      rawMsg.message = parts.slice(4).join(' ')
    }

    if (!rawMsg.userPart || !rawMsg.channelPart || !rawMsg.message) {
      return
    }

    const attrs = this.parseAttrs(rawMsg.attrsPart)

    const badgeStr = attrs['badges'] ?? ''
    delete attrs['badges']
    const badges = this.parseBadges(badgeStr)

    const parsed: ParsedMsg = {
      user: rawMsg.userPart.split('!')[0].slice(1),
      badges,
      attrs,
      channel: rawMsg.channelPart,
      message: rawMsg.message.slice(1),
    }
    this.log(LogLevel.VERBOSE, `Parsed message: ${JSON.stringify(parsed)}`)
  }

  parseAttrs(attrsStr: string): Record<string, string> {
    const parts = attrsStr.split(';')
    const filered = parts.filter(
      (p) =>
        p.startsWith('color=') ||
        p.startsWith('badges=') ||
        p.startsWith('display-name=') ||
        p.startsWith('msg-id=') ||
        p.startsWith('subscriber=') ||
        p.startsWith('vip=') ||
        p.startsWith('mod='),
    )

    const result: Record<string, string> = {}
    for (const badge of filered) {
      const split = badge.split('=')
      if (split.length !== 2) {
        continue
      }
      result[split[0]] = split[1]
    }
    return result
  }

  parseBadges(badgeValue: string): Record<string, string> {
    const parts = badgeValue.split(',')
    const result: Record<string, string> = {}
    for (const badge of parts) {
      const split = badge.split('/')
      if (split.length !== 2) {
        continue
      }
      result[split[0]] = split[1]
    }
    return result
  }

  web_auth_headers() {
    return {
      Authorization: `Bearer ${TWITCH_OAUTH_TOKEN}`,
      'Client-Id': TWITCH_CLIENT_ID,
    }
  }

  async fetch_broadcaster_id(channel: ChannelName): Promise<BoardcasterId> {
    const existingId = this.broadcastersMap.get(channel)
    if (existingId) {
      return existingId
    }

    const response = await fetch(
      `https://api.twitch.tv/helix/users?login=${channel}`,
      {
        headers: this.web_auth_headers(),
      },
    )
    const data = await response.json()
    const id = UserResponseSchema.assert(data).data[0].id as BoardcasterId
    this.broadcastersMap.set(channel, id)
    return id
  }

  async fetch_badges(channel?: ChannelName) {
    const broadcasterId = channel
      ? await this.fetch_broadcaster_id(channel)
      : undefined
    const url = broadcasterId
      ? `https://api.twitch.tv/helix/chat/badges?broadcaster_id=${broadcasterId}`
      : 'https://api.twitch.tv/helix/chat/badges/global'

    const response = await fetch(
      url,
      {
        headers: this.web_auth_headers(),
      },
    )
    const data = await response.json()
    const badgesData = BadgeResponseSchema.assert(data).data
    const badgesDict: Map<string, Map<string, BadgeVersion>> = new Map()
    for (const badge of badgesData) {
      badgesDict.set(
        badge.set_id,
        new Map(badge.versions.map((v) => [v.id, v])),
      )
    }
    return badgesDict
  }

  getBadge(params: {
    channel: ChannelName
    setId: string
    versionId: string
  }): BadgeVersion | undefined {
    const set = this.globalBadges.get(params.setId)
    if (set) {
      return set.get(params.versionId)
    }
    return this.badgesByChannel.get(params.channel)?.get(params.setId)?.get(
      params.versionId,
    )
  }
}

export const twitchConnector = new TwitchConnector()
