import { type ChatServer } from '../api/schema.ts'
export type { ChatServer }

export type ChannelName = string & { readonly __brand: unique symbol }

export type ChatId = string & { readonly __brand: unique symbol }

export interface ChatConnector {
  connect(channel: ChannelName): Promise<void>
  disconnect(channel: ChannelName): void
  cleanup(): void
  getChannelStatus(
    channel: ChannelName,
  ): 'connected' | 'disconnected' | 'connecting'
}

export type MessageId = string & { readonly __brand: unique symbol }
export type UserId = string & { readonly __brand: unique symbol }

export type TwitchFields = {
  badges: Record<string, string>
  attrs: Record<string, string>
}

export type ChatMessage = {
  id: MessageId
  userId: UserId
  timestamp: number
  text: string
  server: ChatServer
  channel: ChannelName
}

export type ChatUser = {
  id: UserId
  displayName: string
  twitch_fields?: TwitchFields
}
