import {
  ChatId,
  ChatMessage,
  ChatPin,
  ChatPoll,
  ChatPrediction,
  MessageId,
} from './types.ts'

export type ChatEvent =
  | { type: 'message'; message: ChatMessage }
  | { type: 'delete'; messageIds: MessageId[] }
  | { type: 'clear' }
  | { type: 'pin'; pin: ChatPin | null }
  | { type: 'poll'; poll: ChatPoll | null }
  | { type: 'prediction'; prediction: ChatPrediction | null }

// An ended poll or a resolved prediction stays this long, so a client that connects right after still sees the results
const ENDED_POLL_KEPT_MS = 60_000

type Listener = (event: ChatEvent) => void

// Live subscribers per chat (server/channel), used by the SSE stream
const listeners: Map<ChatId, Set<Listener>> = new Map()

export function subscribe(chatId: ChatId, listener: Listener): () => void {
  let set = listeners.get(chatId)
  if (!set) {
    set = new Set()
    listeners.set(chatId, set)
  }
  set.add(listener)
  return () => {
    set.delete(listener)
    if (set.size === 0 && listeners.get(chatId) === set) {
      listeners.delete(chatId)
    }
  }
}

export function emit(chatId: ChatId, event: ChatEvent) {
  for (const listener of listeners.get(chatId) ?? []) {
    listener(event)
  }
}

// Pinned message and running poll per chat: state rather than lines, sent to a stream when it opens
const pins: Map<ChatId, ChatPin> = new Map()
const polls: Map<ChatId, ChatPoll> = new Map()
const predictions: Map<ChatId, ChatPrediction> = new Map()

export function setPin(chatId: ChatId, pin: ChatPin | null) {
  if (!pin && !pins.has(chatId)) return
  if (pin) pins.set(chatId, pin)
  else pins.delete(chatId)
  emit(chatId, { type: 'pin', pin })
}

export function setPoll(chatId: ChatId, poll: ChatPoll | null) {
  if (!poll && !polls.has(chatId)) return
  if (poll) polls.set(chatId, poll)
  else polls.delete(chatId)
  emit(chatId, { type: 'poll', poll })
  if (poll?.ended) {
    setTimeout(() => {
      if (polls.get(chatId) === poll) polls.delete(chatId)
    }, ENDED_POLL_KEPT_MS)
  }
}

export function setPrediction(
  chatId: ChatId,
  prediction: ChatPrediction | null,
) {
  if (!prediction && !predictions.has(chatId)) return
  if (prediction) predictions.set(chatId, prediction)
  else predictions.delete(chatId)
  emit(chatId, { type: 'prediction', prediction })
  if (prediction?.state === 'resolved') {
    setTimeout(() => {
      if (predictions.get(chatId) === prediction) predictions.delete(chatId)
    }, ENDED_POLL_KEPT_MS)
  }
}

export function currentPin(chatId: ChatId): ChatPin | undefined {
  return pins.get(chatId)
}

// All three, null for what is not up: a client that reconnects drops what ended while it was away
export function chatState(chatId: ChatId): ChatEvent[] {
  const pin = pins.get(chatId)
  return [
    {
      type: 'pin',
      pin: pin && (!pin.endsAtMs || pin.endsAtMs > Date.now()) ? pin : null,
    },
    { type: 'poll', poll: polls.get(chatId) ?? null },
    { type: 'prediction', prediction: predictions.get(chatId) ?? null },
  ]
}

// A channel the aggregator left: its pin and poll would be stale when it joins again
export function forgetState(chatId: ChatId) {
  pins.delete(chatId)
  polls.delete(chatId)
  predictions.delete(chatId)
}
