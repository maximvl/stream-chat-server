import { int, sqliteTable, text } from 'drizzle-orm/sqlite-core'

// Generic per-connector app access tokens (client_credentials-style,
// server-to-server auth - no per-user refresh_token). Keyed by "server" so
// future connectors (vkvideo, kick, ...) can reuse the same table.
export const appTokensTable = sqliteTable('app_tokens', {
  id: int().primaryKey({ autoIncrement: true }),
  server: text().notNull().unique(),
  access_token: text().notNull(),
  created_at: int().notNull(),
  created_at_str: text().notNull(),
  expires_at: int().notNull(),
  expires_at_str: text().notNull(),
})

// Addresses or CIDR ranges the API refuses (except /api/status), set from the RTE chats admin
export const bannedIpsTable = sqliteTable('banned_ips', {
  ip: text().primaryKey(),
  reason: text().notNull().default(''),
  created_at: int().notNull(),
})
