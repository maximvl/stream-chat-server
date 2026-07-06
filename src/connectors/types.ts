import { type ChatServer } from '../api/schema.ts'
export type { ChatServer }

export type ChannelName = string & { readonly __brand: unique symbol }

export type ChatId = string & { readonly __brand: unique symbol }

export type ChannelStatus = 'connected' | 'disconnected' | 'connecting'

export interface ChatConnector {
  connect(channel: ChannelName): Promise<void>
  disconnect(channel: ChannelName): void
  cleanup(): void
  getChannelStatus(channel: ChannelName): ChannelStatus
  getMessages(channel: ChannelName, tsFrom: number): ChatMessage[]
  maybeRefreshToken(): Promise<void>
}

export type MessageId = string & { readonly __brand: unique symbol }
export type UserId = string & { readonly __brand: unique symbol }

export type VkMessageFields = {
  mentions: string[]
}

export type ChatMessage = {
  id: MessageId
  userId: UserId
  timestampMs: number
  text: string
  server: ChatServer
  channel: ChannelName
  vkFields?: VkMessageFields
}

export type UserTwitchFields = {
  badges: Record<string, string>
  attrs: Record<string, string>
}

export type ChatUser = {
  id: UserId
  displayName: string
  twitchFields?: UserTwitchFields
}

export interface TokenManager {
  maybeRefreshToken(): Promise<void>
}
