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

// When set, /api/admin/* (the RTE chats admin, through the RTE backend) wants "Authorization: Bearer <token>";
// unset, those routes don't exist
export const ADMIN_TOKEN = getEnv('ADMIN_TOKEN') || ''

// Proxies in front of this server (comma-separated addresses or CIDR ranges): only their X-Forwarded-For /
// X-Real-IP is believed for the client address
export const TRUSTED_PROXIES = getEnv('TRUSTED_PROXIES') || ''
