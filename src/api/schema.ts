import { type } from 'arktype'

export const ChatServer = type('"twitch" | "vkvideo" | "kick" | "gosh" | "wtv"')
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

const LastMessagesLimit = type('string').pipe((value, ctx) => {
  const limit = parseInt(value)
  if (!isFinite(limit) || limit < 1) {
    return ctx.error('must be a positive integer')
  }
  return limit
}).to('number')

export const ChatLastMessagesRequest = type({
  server: ChatServer,
  channel: 'string',
  'limit?': LastMessagesLimit,
})
