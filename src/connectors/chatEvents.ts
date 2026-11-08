import { ChatId, ChatMessage, MessageId } from './types.ts'

export type ChatEvent =
  | { type: 'message'; message: ChatMessage }
  | { type: 'delete'; messageIds: MessageId[] }
  | { type: 'clear' }

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
