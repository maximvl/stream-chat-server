import { type ChatServer } from '../api/schema.ts'
import { ChatBadge, ChatRole } from './vkvideo/schemas.ts'
export type { ChatServer }

export type ChannelName = string & { readonly __brand: unique symbol }

export type ChatId = string & { readonly __brand: unique symbol }

export type ConnectionStatus = 'connected' | 'disconnected' | 'connecting'

export type ChannelStatus = {
  channel: ChannelName
  status: ConnectionStatus
  joinedAtMs: number
  joinedAtStr: string
  uptimeMs: number
  messagesCount: number
}

export type ConnectorStatus = {
  server: ChatServer
  status: ConnectionStatus
  startedAtMs: number
  startedAtStr: string
  uptimeMs: number
  channels: ChannelStatus[]
}

export interface ChatConnector {
  connect(channel: ChannelName): Promise<void>
  disconnect(channel: ChannelName): void
  cleanup(): void
  getChannelStatus(channel: ChannelName): ChannelStatus | null
  getMessages(channel: ChannelName, tsFrom: number): ChatMessage[]
  getStatus(): ConnectorStatus
  refreshToken?(): Promise<void>
  sendPing?(): Promise<void>
}

export type MessageId = string & { readonly __brand: unique symbol }
export type UserId = string & { readonly __brand: unique symbol }

export type VkMessageFields = {
  mentions: string[]
}

export type ChatMessage = {
  id: MessageId
  user: ChatUser
  timestampMs: number
  text: string
  server: ChatServer
  channel: ChannelName
  vkFields?: VkMessageFields
}

export type TwitchBadge = {
  id: string
  title: string
  imageUrl: string
}

export type TwitchUserFields = {
  badges: TwitchBadge[]
  color: string
  mod: boolean
  subscriber: boolean
  turbo: boolean
  highlighted: boolean
}

export type KickBadge = {
  name: string
  type: string
  imageUrl?: string
  selected: boolean
}

export type KickUserFields = {
  color: string
  badges: KickBadge[]
}

export type VkUserFields = {
  nickColor: number
  color?: string
  isChatModerator: boolean
  isChannelModerator: boolean
  roles: ChatRole[]
  badges: ChatBadge[]
}

export type ChatUser = {
  id: UserId
  displayName: string
  twitchFields?: TwitchUserFields
  kickFields?: KickUserFields
  vkFields?: VkUserFields
}

export interface TokenManager {
  maybeRefreshToken(): Promise<void>
}
