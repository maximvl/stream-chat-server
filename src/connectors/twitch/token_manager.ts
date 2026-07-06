import {
  LogLevel,
  TWITCH_CLIENT_ID,
  TWITCH_CLIENT_SECRET,
} from '../../config.ts'
import { type } from 'arktype'
import { db } from '../../db/db.ts'
import { appTokensTable } from '../../db/schema.ts'
import { eq } from 'drizzle-orm'
import { myLog } from '../../utils.ts'
import { TokenManager } from '../types.ts'

const SERVER_NAME = 'twitch'

// App Access Token (client_credentials grant): server-to-server auth for
// Helix endpoints that don't act on behalf of a user (badges, users lookup).
// No refresh_token exists for this flow - an expired token is simply
// replaced by requesting a new one with the same client id/secret. The
// token is cached in the DB so we don't have to hit Twitch on every restart.
export class TwitchTokenManager implements TokenManager {
  accessToken: string | null = null
  expiresAt: Temporal.Instant | null = null
  private pendingFetch: Promise<string> | null = null

  log(level: LogLevel, message: string) {
    myLog(level, `[TwitchTokenManager] ${message}`)
  }

  async getAccessToken(): Promise<string> {
    if (this.accessToken && this.expiresAt && !this.isExpired(this.expiresAt)) {
      return this.accessToken
    }

    const stored = await this.loadToken()
    if (stored) {
      const expiresAt = Temporal.Instant.fromEpochMilliseconds(
        stored.expires_at * 1000,
      )
      if (!this.isExpired(expiresAt)) {
        this.accessToken = stored.access_token
        this.expiresAt = expiresAt
        return this.accessToken
      }
    }

    return await this.fetchAccessToken()
  }

  private isExpired(expiresAt: Temporal.Instant): boolean {
    return Temporal.Instant.compare(Temporal.Now.instant(), expiresAt) >= 0
  }

  private async fetchAccessToken(): Promise<string> {
    if (this.pendingFetch) {
      return await this.pendingFetch
    }
    this.pendingFetch = this.doFetchAccessToken()
    try {
      return await this.pendingFetch
    } finally {
      this.pendingFetch = null
    }
  }

  private async doFetchAccessToken(): Promise<string> {
    const formData = new URLSearchParams()
    formData.set('client_id', TWITCH_CLIENT_ID)
    formData.set('client_secret', TWITCH_CLIENT_SECRET)
    formData.set('grant_type', 'client_credentials')

    const response = await fetch('https://id.twitch.tv/oauth2/token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: formData,
    })

    if (!response.ok) {
      const body = await response.text()
      throw new Error(
        `Failed to fetch app access token: ${response.status} ${response.statusText} ${body}`,
      )
    }

    const result = TwitchAppTokenResponse.assert(await response.json())
    this.accessToken = result.access_token
    this.expiresAt = Temporal.Now.instant().add({ seconds: result.expires_in })
    await this.saveToken(this.accessToken, this.expiresAt)
    this.log(
      LogLevel.DEBUG,
      `Fetched app access token, expires at ${this.expiresAt.toString()}`,
    )
    return this.accessToken
  }

  private async loadToken() {
    const rows = await db.select().from(appTokensTable).where(
      eq(appTokensTable.server, SERVER_NAME),
    ).limit(1).execute()
    return rows[0] ?? null
  }

  private async saveToken(accessToken: string, expiresAt: Temporal.Instant) {
    const now = Temporal.Now.instant()
    const values = {
      access_token: accessToken,
      created_at: Math.floor(now.epochMilliseconds / 1000),
      created_at_str: now.toString({ smallestUnit: 'seconds' }),
      expires_at: Math.floor(expiresAt.epochMilliseconds / 1000),
      expires_at_str: expiresAt.toString({ smallestUnit: 'seconds' }),
    }

    const existing = await this.loadToken()
    if (existing) {
      await db.update(appTokensTable).set(values).where(
        eq(appTokensTable.server, SERVER_NAME),
      ).execute()
      return
    }

    await db.insert(appTokensTable).values({
      server: SERVER_NAME,
      ...values,
    }).execute()
  }

  async maybeRefreshToken(): Promise<void> {
    if (!this.expiresAt) {
      return
    }
    const refreshSince = this.expiresAt.subtract({ minutes: 20 })
    if (Temporal.Instant.compare(Temporal.Now.instant(), refreshSince) >= 0) {
      await this.fetchAccessToken()
    }
  }
}

const TwitchAppTokenResponse = type({
  access_token: 'string',
  expires_in: 'number',
  token_type: 'string',
})
