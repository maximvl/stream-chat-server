export type ChatServer = 'twitch' | 'vkvideo' | 'kick'
export type ChatChannel = string & { readonly __brand: unique symbol }

export type ChatConnection = {
  server: ChatServer
  channel: ChatChannel
}
