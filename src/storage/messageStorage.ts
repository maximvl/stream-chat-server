import { ChannelName, ChatMessage, ChatServer } from '../connectors/types.ts'

class ChannelStorage {
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
}

class MessagesStorage {
  messagesPerServer: Map<ChatServer, Map<ChannelName, ChannelStorage>> =
    new Map()

  addMessage(message: ChatMessage) {
    let serverMap = this.messagesPerServer.get(message.server)
    if (!serverMap) {
      serverMap = new Map()
      this.messagesPerServer.set(message.server, serverMap)
    }

    let channelStorage = serverMap.get(message.channel)
    if (!channelStorage) {
      channelStorage = new ChannelStorage()
      serverMap.set(message.channel, channelStorage)
    }

    channelStorage.addMessage(message)
  }

  getMessagesAfter(
    server: ChatServer,
    channel: ChannelName,
    timestamp: number,
  ) {
    const serverMap = this.messagesPerServer.get(server)
    if (!serverMap) {
      return []
    }

    const channelStorage = serverMap.get(channel)
    if (!channelStorage) {
      return []
    }

    return channelStorage.getMessagesAfter(timestamp)
  }

  cleanupOldMessages() {
    // TODO: Implement cleanup logic
  }
}

export const messageStorage = new MessagesStorage()
