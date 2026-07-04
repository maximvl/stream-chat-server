import { load } from '@std/dotenv'

export type LogLevel = number & {
  readonly __logLevel: unique symbol
}

export const LogLevel = {
  DEBUG: 1 as LogLevel,
  VERBOSE: 2 as LogLevel,
  ALL: 3 as LogLevel,
} as const

const env = await load({
  // optional: choose a specific path (defaults to ".env")
  envPath: '.env.local',
  // optional: also export to the process environment (so Deno.env can read it)
  export: true,
})

export const TWITCH_OAUTH_TOKEN = env.TWITCH_OAUTH_TOKEN || ''
export const TWITCH_USERNAME = env.TWITCH_USERNAME || ''
export const TWITCH_CLIENT_ID = env.TWITCH_CLIENT_ID || ''

export const LOG_LEVEL = Number(env.LOG_LEVEL) || LogLevel.ALL
