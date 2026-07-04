export type ChatServer = 'twitch' | 'vkvideo' | 'kick'
export type ChannelName = string & { readonly __brand: unique symbol }

export type ChatConnection = {
  server: ChatServer
  channel: ChannelName
}
