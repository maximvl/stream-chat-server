import {
  LogLevel,
  TWITCH_CLIENT_ID,
  TWITCH_OAUTH_TOKEN,
  TWITCH_REFRESH_TOKEN,
} from '../../config.ts'
import { type } from 'arktype'
import { db } from '../../db/db.ts'
import { tokensTable } from '../../db/schema.ts'
import { eq } from 'drizzle-orm'
import { myLog } from '../../utils.ts'
import { TokenManager } from '../types.ts'

export class TwitchTokenManager implements TokenManager {
  accessToken: string | null = null
  refreshToken: string | null = null
  expiresAt: Temporal.Instant | null = null

  log(level: LogLevel, message: string) {
    myLog(level, `[TwitchTokenManager] ${message}`)
  }

  constructor() {
    this.accessToken = TWITCH_OAUTH_TOKEN
    this.refreshToken = TWITCH_REFRESH_TOKEN
    this.expiresAt = Temporal.Now.instant().add({ minutes: 30 })
    this.loadToken().then((token) => {
      if (token) {
        this.accessToken = token.access_token
        this.refreshToken = token.refresh_token
        this.expiresAt = Temporal.Instant.fromEpochMilliseconds(
          token.expires_at * 1000,
        )
      } else {
        this.log(
          LogLevel.DEBUG,
          'No token found in database, loading from config',
        )
      }
    }).catch((error) => {
      this.log(LogLevel.DEBUG, `Error loading token: ${JSON.stringify(error)}`)
    })
  }

  async doRefreshToken(refreshToken: string) {
    const formData = new URLSearchParams()
    formData.set('client_id', TWITCH_CLIENT_ID)
    formData.set('client_secret', TWITCH_OAUTH_TOKEN)
    formData.set('grant_type', 'refresh_token')
    formData.set('refresh_token', refreshToken)

    const response = await fetch('https://id.twitch.tv/oauth2/token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: formData,
    })
    const result = TwitchTokenResponse.assert(await response.json())
    this.accessToken = result.access_token
    this.refreshToken = result.refresh_token
    this.expiresAt = Temporal.Now.instant().add({ seconds: result.expires_in })
    await this.saveTokenResult(result)
  }

  async saveTokenResult(result: TwitchTokenResult) {
    const now = Temporal.Now.instant()

    const values = {
      access_token: result.access_token,
      refresh_token: result.refresh_token,
      expires_in: result.expires_in,
      created_at: Math.floor(now.epochMilliseconds / 1000),
      created_at_str: now.toString({ smallestUnit: 'seconds' }),
      expires_at: Math.floor(now.epochMilliseconds / 1000) + result.expires_in,
      expires_at_str: now.add({ seconds: result.expires_in }).toString({
        smallestUnit: 'seconds',
      }),
    }

    const currentRecord = await this.loadToken()
    if (currentRecord) {
      await db.update(tokensTable).set(values).where(
        eq(tokensTable.server, 'twitch'),
      ).execute()
      return
    }

    await db.insert(tokensTable).values({
      server: 'twitch',
      ...values,
    }).execute()
  }

  async loadToken() {
    const token = await db.select().from(tokensTable).where(eq(
      tokensTable.server,
      'twitch',
    )).limit(1).execute()
    if (token.length === 0) {
      return null
    }
    return token[0]
  }

  async maybeRefreshToken(): Promise<void> {
    if (!this.refreshToken || !this.expiresAt) {
      this.log(LogLevel.DEBUG, 'No refresh token or expiration time available')
      return
    }
    const now = Temporal.Now.instant()
    const expiresAt = this.expiresAt
    const refreshSince = expiresAt.subtract({ minutes: 20 })
    if (Temporal.Instant.compare(now, refreshSince) >= 0) {
      await this.doRefreshToken(this.refreshToken)
    }
  }
}

const TwitchTokenResponse = type({
  access_token: 'string',
  refresh_token: 'string',
  expires_in: 'number',
  scope: 'string[]',
  token_type: 'string',
})

type TwitchTokenResult = typeof TwitchTokenResponse.infer
