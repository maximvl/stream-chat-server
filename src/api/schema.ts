import { type } from 'arktype'

export const ChatServer = type('"twitch" | "vkvideo" | "kick" | "gosh"')
export type ChatServer = typeof ChatServer.infer

export const ConnectRequest = type({
  server: ChatServer,
  channel: 'string',
})

export const ChatStatusRequest = type({
  server: ChatServer,
  channel: 'string',
})

const Timestamp = type('string').pipe((value, ctx) => {
  const timestamp = parseInt(value)
  if (!isFinite(timestamp)) {
    return ctx.error('must be an integer')
  }
  return timestamp
}).to('number')

export const ChatMessagesRequest = type({
  server: ChatServer,
  channel: 'string',
  tsFrom: Timestamp,
})
