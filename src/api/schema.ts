import { type } from 'arktype'

export const ChatServer = type(
  '"twitch" | "vkvideo" | "kick" | "gosh" | "wtv" | "goodgame" | "youtube"',
)
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

export const MAX_AVATAR_IDS = 100

// What a user is looked up by: Twitch's numeric user id (twitchFields.userId), user.id elsewhere
const AVATAR_KEY = {
  twitch: /^\d{1,20}$/,
  goodgame: /^\d{1,20}$/,
  kick: /^\d{1,20}$/,
  wtv: /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
}

// Comma-separated keys, deduplicated and capped at one Twitch Helix call
export const AvatarsRequest = type({
  server: '"twitch" | "goodgame" | "kick" | "wtv"',
  ids: 'string',
}).pipe(({ server, ids }, ctx) => {
  const keys = [...new Set(ids.split(','))]
  if (!keys.every((key) => AVATAR_KEY[server].test(key))) {
    return ctx.error(`ids must be comma-separated ${server} user keys`)
  }
  return { server, ids: keys.slice(0, MAX_AVATAR_IDS) }
})

export const ChatLastMessagesRequest = type({
  server: ChatServer,
  channel: 'string',
  'limit?': LastMessagesLimit,
})
