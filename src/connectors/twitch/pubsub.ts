// Twitch PubSub (wss://pubsub-edge.twitch.tv) for what IRC doesn't carry: pinned messages, polls and
// predictions. pinned-chat-updates-v1.<id>, polls.<id> and predictions-channel-v1.<id> are listened to without a token, the way twitch.tv's own
// page does for viewers. Undocumented: payloads follow twitch4j's models (snake_case).
import { type } from 'arktype'
import { LogLevel } from '../../config.ts'
import { myLog } from '../../utils.ts'
import {
  ChatEmote,
  ChatPin,
  ChatPoll,
  ChatPrediction,
  UserId,
} from '../types.ts'

// Twitch's limit per connection
const TOPICS_PER_SOCKET = 50
const PING_MS = 4 * 60_000
const PONG_TIMEOUT_MS = 10_000
const RECONNECT_MS = 5_000

const log = (level: LogLevel, ...msgs: unknown[]) =>
  myLog(level, '[twitch-pubsub]', ...msgs)

type OnMessage = (topic: string, message: unknown) => void

class PubSubSocket {
  topics: Set<string> = new Set()
  ws: WebSocket | null = null
  pingTimer: ReturnType<typeof setInterval> | undefined
  pongTimer: ReturnType<typeof setTimeout> | undefined
  reconnectTimer: ReturnType<typeof setTimeout> | undefined

  constructor(private onMessage: OnMessage) {}

  open() {
    if (this.ws || this.reconnectTimer) return
    const ws = new WebSocket('wss://pubsub-edge.twitch.tv')
    this.ws = ws
    ws.onopen = () => {
      this.send('LISTEN', [...this.topics])
      this.pingTimer = setInterval(() => this.ping(), PING_MS)
    }
    ws.onmessage = (event) => this.handle(event.data)
    ws.onclose = () => this.reconnect()
    ws.onerror = () => ws.close()
  }

  close() {
    clearInterval(this.pingTimer)
    clearTimeout(this.pongTimer)
    clearTimeout(this.reconnectTimer)
    this.reconnectTimer = undefined
    const ws = this.ws
    this.ws = null
    if (ws) {
      ws.onclose = null
      ws.close()
    }
  }

  reconnect() {
    this.close()
    if (!this.topics.size) return
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined
      this.open()
    }, RECONNECT_MS)
  }

  ping() {
    this.ws?.send(JSON.stringify({ type: 'PING' }))
    this.pongTimer = setTimeout(() => this.reconnect(), PONG_TIMEOUT_MS)
  }

  send(type: 'LISTEN' | 'UNLISTEN', topics: string[]) {
    if (!topics.length || this.ws?.readyState !== WebSocket.OPEN) return
    this.ws.send(JSON.stringify({ type, data: { topics } }))
  }

  handle(raw: unknown) {
    let frame: {
      type?: string
      error?: string
      data?: { topic?: string; message?: string }
    }
    try {
      frame = JSON.parse(String(raw))
    } catch {
      return
    }
    switch (frame.type) {
      case 'PONG':
        clearTimeout(this.pongTimer)
        return
      case 'RECONNECT':
        this.reconnect()
        return
      case 'RESPONSE':
        if (frame.error) log(LogLevel.DEBUG, `LISTEN failed: ${frame.error}`)
        return
      case 'MESSAGE':
        if (!frame.data?.topic || !frame.data.message) return
        try {
          this.onMessage(frame.data.topic, JSON.parse(frame.data.message))
        } catch (error) {
          log(LogLevel.DEBUG, `Bad message on ${frame.data.topic}: ${error}`)
        }
    }
  }
}

export class TwitchPubSub {
  sockets: PubSubSocket[] = []

  constructor(private onMessage: OnMessage) {}

  listen(topics: string[]) {
    const fresh = topics.filter((t) =>
      !this.sockets.some((s) => s.topics.has(t))
    )
    if (!fresh.length) return
    let socket = this.sockets.find(
      (s) => s.topics.size + fresh.length <= TOPICS_PER_SOCKET,
    )
    if (!socket) {
      socket = new PubSubSocket(this.onMessage)
      this.sockets.push(socket)
    }
    for (const topic of fresh) socket.topics.add(topic)
    socket.send('LISTEN', fresh)
    socket.open()
  }

  unlisten(topics: string[]) {
    for (const socket of this.sockets) {
      const mine = topics.filter((t) => socket.topics.delete(t))
      socket.send('UNLISTEN', mine)
      if (!socket.topics.size) socket.close()
    }
    this.sockets = this.sockets.filter((s) => s.topics.size)
  }
}

// Seconds or an ISO date, depending on the payload
function toMs(value: number | string | null | undefined): number | undefined {
  if (value === null || value === undefined || value === '') return undefined
  if (typeof value === 'number') return value < 1e12 ? value * 1000 : value
  const ms = Date.parse(value)
  return Number.isNaN(ms) ? undefined : ms
}

const PinnedMessage = type({
  id: 'string',
  message: {
    sender: {
      user_id: 'string',
      login: 'string',
      display_name: 'string',
      'chat_color?': 'string | null',
    },
    content: {
      text: 'string',
      'fragments?': type({
        text: 'string',
        'emoticon?': type({ emoticon_id: 'string' }).or('null'),
      }).array().or('null'),
    },
    'ends_at?': 'number | string | null',
  },
})

const twitchEmote = (id: string, name: string): ChatEmote => ({
  id,
  name,
  imageUrl: `https://static-cdn.jtvnw.net/emoticons/v2/${id}/default/dark/3.0`,
})

export function twitchPin(
  sender: {
    id: string
    login: string
    displayName: string
    color?: string | null
  },
  text: string,
  emotes: ChatEmote[],
  id: string,
  endsAt?: number | string | null,
): ChatPin {
  const endsAtMs = toMs(endsAt)
  return {
    id,
    user: {
      id: sender.login as UserId,
      displayName: sender.displayName,
      twitchFields: {
        userId: sender.id,
        badges: [],
        color: sender.color ?? '',
        mod: false,
        subscriber: false,
        turbo: false,
        highlighted: false,
        giantEmote: false,
        firstMessage: false,
      },
    },
    text,
    emotes,
    ...(endsAtMs && { endsAtMs }),
  }
}

// pin-message's data
export function pinFromPubSub(data: unknown): ChatPin | null {
  const pin = PinnedMessage(data)
  if (pin instanceof type.errors) return null
  const { sender, content } = pin.message
  const emotes = (content.fragments ?? []).flatMap((f) =>
    f.emoticon ? [twitchEmote(f.emoticon.emoticon_id, f.text)] : []
  )
  return twitchPin(
    {
      id: sender.user_id,
      login: sender.login,
      displayName: sender.display_name,
      color: sender.chat_color,
    },
    content.text,
    emotes,
    pin.id,
    pin.message.ends_at,
  )
}

export const PinUpdate = type({ 'ends_at?': 'number | string | null' })

export function endsAtMs(value: number | string | null | undefined) {
  return toMs(value)
}

const Poll = type({
  poll_id: 'string',
  title: 'string',
  status: 'string',
  choices: type({ title: 'string', votes: { total: 'number' } }).array(),
  'remaining_duration_milliseconds?': 'number | null',
})

// polls' data: {poll}. Archived and moderated polls are gone; completed and terminated show results
export function pollFromPubSub(data: unknown): ChatPoll | null {
  const poll = Poll((data as { poll?: unknown } | null)?.poll)
  if (poll instanceof type.errors) return null
  if (
    poll.status !== 'ACTIVE' && poll.status !== 'COMPLETED' &&
    poll.status !== 'TERMINATED'
  ) {
    return null
  }
  const ended = poll.status !== 'ACTIVE'
  const remaining = poll.remaining_duration_milliseconds ?? 0
  return {
    id: poll.poll_id,
    title: poll.title,
    choices: poll.choices.map((c) => ({
      title: c.title,
      votes: c.votes.total,
    })),
    ...(!ended && remaining > 0 && { endsAtMs: Date.now() + remaining }),
    ended,
  }
}

const Prediction = type({
  id: 'string',
  title: 'string',
  status: 'string',
  outcomes: type({
    id: 'string',
    title: 'string',
    total_points: 'number',
    total_users: 'number',
  }).array(),
  'prediction_window_seconds?': 'number',
  'created_at?': 'string',
  'winning_outcome_id?': 'string | null',
})

// predictions-channel-v1's data: {event}. Canceled ones are gone
export function predictionFromPubSub(data: unknown): ChatPrediction | null {
  const p = Prediction((data as { event?: unknown } | null)?.event)
  if (p instanceof type.errors) return null
  const state = p.status === 'ACTIVE'
    ? 'open'
    : p.status === 'RESOLVED'
    ? 'resolved'
    : p.status === 'LOCKED' || p.status === 'RESOLVE_PENDING'
    ? 'locked'
    : null
  if (!state) return null
  const winner = p.outcomes.findIndex((o) => o.id === p.winning_outcome_id)
  const created = toMs(p.created_at)
  return {
    id: p.id,
    title: p.title,
    outcomes: p.outcomes.map((o) => ({
      title: o.title,
      points: o.total_points,
      users: o.total_users,
    })),
    state,
    ...(state === 'resolved' && winner >= 0 && { winner }),
    ...(state === 'open' && created && p.prediction_window_seconds && {
      endsAtMs: created + p.prediction_window_seconds * 1000,
    }),
  }
}

export { twitchEmote }
