import { load } from '@std/dotenv'
import { LogLevel } from './utils.ts'

const env = await load({
  // optional: choose a specific path (defaults to ".env")
  envPath: '.env.local',
  // optional: also export to the process environment (so Deno.env can read it)
  export: true,
})

export const TWITCH_OAUTH_TOKEN = env.TWITCH_OAUTH_TOKEN || ''
export const TWITCH_USERNAME = env.TWITCH_USERNAME || ''

export const LOG_LEVEL = Number(env.LOG_LEVEL) || LogLevel.ALL
