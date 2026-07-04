import { ChatMessage } from './types.ts'

export class MessageStorage {
  messages: ChatMessage[] = []
  lastReadAt: Temporal.Instant = Temporal.Now.instant()

  maxMessages: number = 5000

  addMessage(message: ChatMessage) {
    this.messages.push(message)
    if (this.messages.length > this.maxMessages) {
      this.messages.shift()
    }
  }

  getMessagesAfter(timestamp: number) {
    this.lastReadAt = Temporal.Now.instant()
    return this.messages.filter((message) => message.timestamp > timestamp)
  }

  clear() {
    this.messages = []
  }

  clearOldMessages() {
    const now = Temporal.Now.instant()
    const removeInteval = Temporal.Duration.from({ minutes: 30 })
    const cutoff = now.subtract(removeInteval)
    if (this.lastReadAt < cutoff) {
      this.clear()
    }
  }
}
