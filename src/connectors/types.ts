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
  // Profile pictures by user key (id or username, per platform); throws when the platform didn't answer
  fetchAvatars?(keys: string[]): Promise<Record<string, string>>
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
  // System event (Twitch notices, Kick raids); returned only to clients that ask for notices=1
  notice?: ChatNotice
}

// kind: USERNOTICE msg-id (sub, raid, viewermilestone...), or timeout | ban | clear | roomstate.
// params: the msg-param-* tags without the prefix (roomstate: mode, value; timeout: duration).
// systemText: Twitch's own English text for the notice, if any.
// Other platforms reuse Twitch's kinds and params: Kick's StreamHostEvent is a "raid" (displayName, viewerCount).
export type ChatNotice = {
  kind: string
  params: Record<string, string>
  systemText: string
}

export type TwitchBadge = {
  id: string
  // Badge set: "moderator", "vip", "subscriber"... (id is the version inside it)
  setId: string
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
  // The user's first message in this channel ever
  firstMessage: boolean
  // A channel points reward bought with this message; title is missing while the rewards still load
  reward?: { id: string; title?: string; cost?: number; color?: string }
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

export type GoodgameUserFields = {
  // Hex color of the nick; colorName is GoodGame's own color class (simple, premium, streamer...)
  color: string
  colorName: string
  // Status icon name (ggplus, star, top1...); GoodGame draws them as CSS masks, there is no image
  icon: string
  // Rights in this channel: 10 moderator, 20 streamer, higher ones are site staff
  rights: number
  isStreamer: boolean
  isModerator: boolean
  // Has a premium subscription to this channel
  subscriber: boolean
}

export type YoutubeBadge = {
  title: string
  imageUrl: string
}

export type YoutubeUserFields = {
  // YouTube's name color of the role (owner, moderator, member), empty for others
  color: string
  isOwner: boolean
  isModerator: boolean
  isMember: boolean
  isVerified: boolean
  // Membership badges with the channel's pictures; owner, moderator and verified are plain icons
  badges: YoutubeBadge[]
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
  // https profile picture, when the platform sends it with the message
  avatarUrl?: string
  twitchFields?: TwitchUserFields
  kickFields?: KickUserFields
  vkFields?: VkUserFields
  wtvFields?: WtvUserFields
  goodgameFields?: GoodgameUserFields
  // ChatUser.id is the author's YouTube channel id (UC…)
  youtubeFields?: YoutubeUserFields
}

export interface TokenManager {
  maybeRefreshToken(): Promise<void>
}
