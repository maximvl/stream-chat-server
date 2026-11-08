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
  YoutubeBadge,
} from '../types.ts'
import { myLog, sleep } from '../../utils.ts'
import {
  ChatAction,
  ChatPageData,
  LiveChatResponse,
  TextMessage,
} from './schema.ts'
import { type } from 'arktype'
import { MessageStorage } from '../messageStorage.ts'
import { normalizeChannel, toChatId } from '../utils.ts'
import { emit } from '../chatEvents.ts'

// The chat is read the way youtube.com/live_chat reads it, as a guest: no API key of ours, no quota
const HEADERS = {
  'user-agent':
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
  'accept-language': 'en-US,en;q=0.9',
  // "Reject all" on the EU consent page, otherwise pages from European servers redirect to consent.youtube.com
  cookie: 'SOCS=CAI',
}
// How often a channel without a live stream (or with its chat off) is checked again
const LIVE_RECHECK_MS = 60_000
const RETRY_MS = 5_000
// YouTube asks for 10 s between polls of the all-messages feed, which lags behind other platforms on an overlay
const MAX_POLL_MS = 5_000
const MIN_POLL_MS = 1_000

// Channel ids are case-sensitive, so the original spelling is kept for requests
const CHANNEL_ID = /^UC[\w-]{22}$/

export const ROLE_COLORS = {
  owner: '#ffd600',
  moderator: '#5e84f1',
  member: '#2ba640',
}

type ChatSession = {
  apiKey: string
  clientVersion: string
  continuation: string
}

type ChannelState = {
  source: string
  status: ConnectionStatus
  joinedAtMs: number
}

export function liveUrl(source: string): string {
  const name = source.trim()
  return CHANNEL_ID.test(name)
    ? `https://www.youtube.com/channel/${name}/live`
    : `https://www.youtube.com/@${
      encodeURIComponent(name.replace(/^@/, ''))
    }/live`
}

// youtube.com/@handle/live is the watch page of the current stream, or the channel page when there is none
export function parseLivePage(html: string): string | null {
  // videoDetails.isLive; the microformat's isLiveNow is missing on /channel/UC…/live
  if (!html.includes('"isLive":true')) return null
  return html.match(/"videoDetails":\{"videoId":"([\w-]{11})"/)?.[1] ?? null
}

export function parseChatPage(html: string): ChatSession | null {
  const apiKey = html.match(/"INNERTUBE_API_KEY":"([^"]+)"/)?.[1]
  const clientVersion = html.match(
    /"INNERTUBE_CONTEXT_CLIENT_VERSION":"([^"]+)"/,
  )?.[1]
  const json = html.match(
    /(?:window\["ytInitialData"\]|var ytInitialData)\s*=\s*(\{.+?\});\s*<\/script>/s,
  )?.[1]
  if (!apiKey || !clientVersion || !json) return null
  const data = ChatPageData(JSON.parse(json))
  if (data instanceof type.errors) return null
  const chat = data.contents.liveChatRenderer
  const items = chat?.header?.liveChatHeaderRenderer.viewSelector
    ?.sortFilterSubMenuRenderer.subMenuItems
  // The all-messages feed; the default "Top chat" hides some messages
  const first = chat?.continuations?.[0]
  const continuation =
    items?.[items.length - 1]?.continuation.reloadContinuationData
      .continuation ??
      (first?.invalidationContinuationData ?? first?.timedContinuationData)
        ?.continuation
  return continuation ? { apiKey, clientVersion, continuation } : null
}

// null when the stream is over: YouTube stops handing out continuations
export function parseChatResponse(
  raw: unknown,
): { actions: unknown[]; continuation: string; timeoutMs: number } | null {
  const data = LiveChatResponse(raw)
  if (data instanceof type.errors) return null
  const chat = data.continuationContents?.liveChatContinuation
  const c = chat?.continuations?.[0]
  const next = c?.invalidationContinuationData ?? c?.timedContinuationData ??
    c?.reloadContinuationData
  if (!next) return null
  return {
    actions: chat?.actions ?? [],
    continuation: next.continuation,
    timeoutMs: Math.min(
      MAX_POLL_MS,
      Math.max(MIN_POLL_MS, next.timeoutMs ?? MAX_POLL_MS),
    ),
  }
}

export function parseTextMessage(
  r: typeof TextMessage.infer,
  channel: ChannelName,
): ChatMessage {
  const emotes = new Map<string, ChatEmote>()
  let text = ''
  for (const run of r.message?.runs ?? []) {
    const emoji = run.emoji
    if (emoji?.isCustomEmoji) {
      const name = emoji.shortcuts?.[0] ?? `:${emoji.emojiId}:`
      const thumbnails = emoji.image.thumbnails
      text += name
      emotes.set(name, {
        id: emoji.emojiId,
        name,
        imageUrl: thumbnails[thumbnails.length - 1]?.url ?? '',
      })
    } else {
      text += run.text ?? emoji?.emojiId ?? ''
    }
  }
  // Super Chats are plain messages with the paid amount in front
  if (r.purchaseAmountText) {
    text = `${r.purchaseAmountText.simpleText} ${text}`.trim()
  }

  const icons = new Set<string>()
  const badges: YoutubeBadge[] = []
  for (const { liveChatAuthorBadgeRenderer: b } of r.authorBadges ?? []) {
    if (b.icon) icons.add(b.icon.iconType)
    const thumbnails = b.customThumbnail?.thumbnails ?? []
    const url = thumbnails[thumbnails.length - 1]?.url
    if (url) badges.push({ title: b.tooltip, imageUrl: url })
  }
  const isOwner = icons.has('OWNER')
  const isModerator = icons.has('MODERATOR')
  const isMember = badges.length > 0

  return {
    id: r.id as MessageId,
    user: {
      id: r.authorExternalChannelId as UserId,
      // Handles come as "@name"; other platforms show bare nicks
      displayName: r.authorName?.simpleText.replace(/^@/, '') ||
        r.authorExternalChannelId,
      youtubeFields: {
        // YouTube's own name colors of the roles; others get the overlay's colors
        color: isOwner
          ? ROLE_COLORS.owner
          : isModerator
          ? ROLE_COLORS.moderator
          : isMember
          ? ROLE_COLORS.member
          : '',
        isOwner,
        isModerator,
        isMember,
        isVerified: icons.has('VERIFIED'),
        badges,
      },
    },
    timestampMs: Math.floor(Number(r.timestampUsec) / 1000),
    text,
    server: 'youtube',
    channel,
    emotes: [...emotes.values()],
  }
}

export class YoutubeConnector implements ChatConnector {
  startedAtMs = Temporal.Now.instant().epochMilliseconds

  channels: Map<ChannelName, ChannelState> = new Map()

  messages: Map<ChannelName, MessageStorage> = new Map()

  log(level: LogLevel, ...msgs: unknown[]) {
    myLog(level, '[youtube]', ...msgs)
  }

  handleActions(channel: ChannelName, actions: unknown[]) {
    const storage = this.messages.get(channel)
    if (!storage) return
    for (const raw of actions) {
      const action = ChatAction(raw)
      if (action instanceof type.errors) {
        this.log(LogLevel.DEBUG, `Bad chat action: ${action.summary}`)
        continue
      }
      const item = action.addChatItemAction?.item
      const r = item?.liveChatTextMessageRenderer ??
        item?.liveChatPaidMessageRenderer
      // A reconnect starts from recent history, so known messages come again
      if (r && !storage.messages.some((m) => m.id === r.id)) {
        const msg = parseTextMessage(r, channel)
        this.log(LogLevel.VERBOSE, `Parsed message: ${JSON.stringify(msg)}`)
        storage.addMessage(msg)
      }

      // Polled history is left as is for existing API clients; only live subscribers are told.
      const removedId = (action.removeChatItemAction ??
        action.markChatItemAsDeletedAction)?.targetItemId
      if (removedId) {
        emit(toChatId('youtube', channel), {
          type: 'delete',
          messageIds: [removedId as MessageId],
        })
      }
      const bannedId = (action.removeChatItemByAuthorAction ??
        action.markChatItemsByAuthorAsDeletedAction)?.externalChannelId
      if (bannedId) {
        const messageIds = storage.messages
          .filter((m) => m.user.id === bannedId)
          .map((m) => m.id)
        if (messageIds.length) {
          emit(toChatId('youtube', channel), { type: 'delete', messageIds })
        }
      }
    }
  }

  async fetchText(url: string): Promise<string | null> {
    const response = await fetch(url, { headers: HEADERS })
    if (response.status === 404) {
      await response.body?.cancel()
      return null
    }
    if (!response.ok) throw new Error(`${url}: ${response.status}`)
    return response.text()
  }

  // Reads the chat of the current stream until it ends or the channel is disconnected
  async readChat(channel: ChannelName, state: ChannelState): Promise<void> {
    const page = await this.fetchText(liveUrl(state.source))
    const videoId = page && parseLivePage(page)
    if (!videoId) return
    const chatPage = await this.fetchText(
      `https://www.youtube.com/live_chat?v=${videoId}`,
    )
    const session = chatPage && parseChatPage(chatPage)
    if (!session) {
      this.log(LogLevel.DEBUG, `No chat on ${videoId} of ${channel}`)
      return
    }

    this.log(LogLevel.DEBUG, `Reading ${videoId} of ${channel}`)
    state.status = 'connected'
    state.joinedAtMs = Temporal.Now.instant().epochMilliseconds
    let continuation = session.continuation
    while (this.channels.get(channel) === state) {
      const response = await fetch(
        `https://www.youtube.com/youtubei/v1/live_chat/get_live_chat?key=${session.apiKey}&prettyPrint=false`,
        {
          method: 'POST',
          headers: { ...HEADERS, 'content-type': 'application/json' },
          body: JSON.stringify({
            context: {
              client: {
                clientName: 'WEB',
                clientVersion: session.clientVersion,
                hl: 'en',
              },
            },
            continuation,
          }),
        },
      )
      if (!response.ok) throw new Error(`get_live_chat: ${response.status}`)
      const result = parseChatResponse(await response.json())
      if (!result) {
        this.log(LogLevel.DEBUG, `Stream ${videoId} of ${channel} ended`)
        return
      }
      this.handleActions(channel, result.actions)
      continuation = result.continuation
      await sleep(result.timeoutMs)
    }
  }

  async run(channel: ChannelName, state: ChannelState) {
    while (this.channels.get(channel) === state) {
      let wait = LIVE_RECHECK_MS
      try {
        await this.readChat(channel, state)
      } catch (error) {
        this.log(LogLevel.DEBUG, `Chat of ${channel} failed: ${error}`)
        // A dropped chat comes back quickly; history fills the gap
        if (state.status === 'connected') wait = RETRY_MS
      }
      state.status = 'connecting'
      if (this.channels.get(channel) === state) await sleep(wait)
    }
  }

  connect(channelOrig: string): Promise<void> {
    const channel = normalizeChannel(channelOrig.trim())
    if (this.channels.has(channel)) return Promise.resolve()
    const state: ChannelState = {
      source: channelOrig.trim(),
      status: 'connecting',
      joinedAtMs: Temporal.Now.instant().epochMilliseconds,
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
    this.channels.delete(channel)
    this.messages.delete(channel)
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
    const joinedAt = Temporal.Instant.fromEpochMilliseconds(state.joinedAtMs)
    return {
      channel,
      status: state.status,
      joinedAtMs: state.joinedAtMs,
      joinedAtStr: joinedAt.toString({ smallestUnit: 'seconds' }),
      uptimeMs: state.status === 'connected'
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
