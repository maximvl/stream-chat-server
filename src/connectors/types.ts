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
  connect(channel: string): Promise<void>
  disconnect(channel: string): void
  cleanup(): void
  getChannelStatus(channel: string): ChannelStatus | null
  getMessages(channel: string, tsFrom: number): ChatMessage[]
  getLastMessages(channel: string, limit: number): ChatMessage[]
  getStatus(): ConnectorStatus
  refreshToken?(): Promise<void>
  sendPing?(): Promise<void>
  pollMessages?(): Promise<void>
}

export type MessageId = string & { readonly __brand: unique symbol }
export type UserId = string & { readonly __brand: unique symbol }

export type VkMessageFields = {
  mentions: {
    id: number
    displayName: string
  }[]
}

// Native platform emote; `name` is the exact text it replaces in `text`.
// kind "gif": Twitch GIF keyboard; kind "cheer": a bits cheer, with its amount and tier color.
export type ChatEmote = {
  id: string
  name: string
  imageUrl: string
  kind?: 'gif' | 'cheer'
  bits?: number
  color?: string
}

export type ChatMessage = {
  id: MessageId
  user: ChatUser
  timestampMs: number
  text: string
  server: ChatServer
  channel: ChannelName
  emotes?: ChatEmote[]
  vkFields?: VkMessageFields
}

export type TwitchBadge = {
  id: string
  title: string
  imageUrl: string
}

export type TwitchUserFields = {
  // Numeric Twitch id; ChatUser.id is the login
  userId: string
  badges: TwitchBadge[]
  color: string
  mod: boolean
  subscriber: boolean
  turbo: boolean
  highlighted: boolean
  // Last emote should be shown huge: Twitch "Gigantify an Emote" or an FFZ:GE channel points reward
  giantEmote: boolean
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

export type WtvUserFields = {
  nicknameColor: string
  tags: string[]
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
  wtvFields?: WtvUserFields
}

export interface TokenManager {
  maybeRefreshToken(): Promise<void>
}
