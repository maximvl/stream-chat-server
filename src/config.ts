import { load } from '@std/dotenv'

export type LogLevel = number & {
  readonly __logLevel: unique symbol
}

export const LogLevel = {
  DEBUG: 1 as LogLevel,
  VERBOSE: 2 as LogLevel,
  ALL: 3 as LogLevel,
} as const

// `.env.local` is only present in local dev; in Docker/prod the values are
// passed directly as real process env vars, so we always fall back to those.
await load({
  envPath: '.env.local',
  export: true,
})

function getEnv(key: string): string | undefined {
  return Deno.env.get(key)
}

export const TWITCH_CLIENT_ID = getEnv('TWITCH_CLIENT_ID') || ''
export const TWITCH_CLIENT_SECRET = getEnv('TWITCH_CLIENT_SECRET') || ''

export const LOG_LEVEL = Number(getEnv('LOG_LEVEL')) || LogLevel.ALL

export const DB_FILE = getEnv('DB_FILE') || 'file:db.sqlite'

export const WEBSERVER_PORT = Number(getEnv('PORT')) || 8000
export const WEBSERVER_HOST = getEnv('IP') || '0.0.0.0'

export const DISABLED_CONNECTORS = getEnv('DISABLED_CONNECTORS')?.split(',') ||
  []

export const MAX_MESSAGES_PER_CHANNEL =
  Number(getEnv('MAX_MESSAGE_PER_CHANNEL')) || 3000
export const MAX_MESSAGES_RESPONSE = Number(getEnv('MAX_MESSAGES_RESPONSE')) ||
  300

export const DEFAULT_LAST_MESSAGES_LIMIT =
  Number(getEnv('DEFAULT_LAST_MESSAGES_LIMIT')) || 10

export const MAX_LAST_MESSAGES_LIMIT = Number(
  getEnv('MAX_LAST_MESSAGES_LIMIT') ?? getEnv('MAX_LAST_MESSAGES'),
) || 300

export const CHANNEL_INACTIVITY_TIMEOUT_MINUTES =
  Number(getEnv('CHANNEL_INACTIVITY_TIMEOUT_MINUTES')) || 60

export const CORS_HOSTS = getEnv('CORS_HOSTS')?.split(',') ||
  ['http://localhost:5173', 'https://mapcar.alwaysdata.net']

// Set on the server that cannot reach YouTube: it then follows the chats read by
// another copy of this server abroad instead of reading YouTube itself (YOUTUBE_NODE.md)
export const YOUTUBE_NODE_URL = getEnv('YOUTUBE_NODE_URL') || ''
// API_TOKEN of that node, if it has one
export const YOUTUBE_NODE_TOKEN = getEnv('YOUTUBE_NODE_TOKEN') || ''

// When set, the API (except /api/status, used by the healthcheck) wants "Authorization: Bearer <token>"
export const API_TOKEN = getEnv('API_TOKEN') || ''

// Abuse limits; requests with API_TOKEN, from private addresses or from RATE_LIMIT_ALLOWLIST are not limited.
// Channels one connector may have joined; a new channel past it gets 503
export const MAX_CHANNELS = Number(getEnv('MAX_CHANNELS') ?? 300)
// API requests per client IP per minute, 0 turns it off
export const RATE_LIMIT_PER_MINUTE = Number(
  getEnv('RATE_LIMIT_PER_MINUTE') ?? 600,
)
// Requests per client IP per 10 minutes that join a channel not joined yet, 0 turns it off
export const NEW_CHANNELS_PER_10_MINUTES = Number(
  getEnv('NEW_CHANNELS_PER_10_MINUTES') ?? 30,
)
// Comma-separated IPs/CIDRs whose X-Forwarded-For / X-Real-IP is believed, e.g. the
// docker bridge of nginx and the ranges of the DDoS protection in front of it.
// Without it every request comes from nginx's private address and is not limited per IP.
export const TRUSTED_PROXIES = getEnv('TRUSTED_PROXIES') ?? ''
// Comma-separated IPs/CIDRs never limited (e.g. the RTE backend server)
export const RATE_LIMIT_ALLOWLIST = getEnv('RATE_LIMIT_ALLOWLIST') ?? ''
