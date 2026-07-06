import { MAX_MESSAGES_PER_CHANNEL } from '../config.ts'
import { ChatMessage } from './types.ts'

export class MessageStorage {
  messages: ChatMessage[] = []
  lastReadAt: Temporal.Instant = Temporal.Now.instant()

  addMessage(message: ChatMessage) {
    this.messages.push(message)
    if (this.messages.length > MAX_MESSAGES_PER_CHANNEL) {
      this.messages.shift()
    }
  }

  getMessagesAfter(timestamp: number) {
    this.lastReadAt = Temporal.Now.instant()
    return this.messages.filter((message) => message.timestampMs > timestamp)
  }

  clear() {
    this.messages = []
  }

  clearOldMessages() {
    const now = Temporal.Now.instant()
    const removeInteval = Temporal.Duration.from({ minutes: 30 })
    const cutoff = now.subtract(removeInteval)
    if (Temporal.Instant.compare(this.lastReadAt, cutoff) < 0) {
      this.clear()
    }
  }
}
