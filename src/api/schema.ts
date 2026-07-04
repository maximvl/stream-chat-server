import { type } from 'arktype'

export const ChatServer = type('"twitch" | "vkvideo" | "kick"')
export type ChatServer = typeof ChatServer.infer

export const ConnectRequest = type({
  server: ChatServer,
  channel: 'string',
})

export const ChatStatusRequest = type({
  server: ChatServer,
  channel: 'string',
})
