export type ChatServer = 'twitch' | 'vkvideo' | 'kick'
export type ChannelName = string & { readonly __brand: unique symbol }

export type ChatId = string & { readonly __brand: unique symbol }

export interface ChatConnector {
  connect(channel: ChannelName): void
}

export type MessageId = string & { readonly __brand: unique symbol }
export type UserId = string & { readonly __brand: unique symbol }

export type ChatMessage = {
  id: MessageId
  userId: UserId
  timestamp: number
  text: string
  server: ChatServer
  channel: ChannelName
}
