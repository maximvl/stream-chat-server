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

export const CORS_HOSTS = getEnv('CORS_HOSTS')?.split(',') ||
  ['http://localhost:5173', 'https://mapcar.alwaysdata.net']
