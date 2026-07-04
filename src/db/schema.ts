import { int, sqliteTable, text } from 'drizzle-orm/sqlite-core'

export const tokensTable = sqliteTable('tokens', {
  id: int().primaryKey({ autoIncrement: true }),
  server: text().notNull(),
  access_token: text().notNull(),
  refresh_token: text().notNull(),
  expires_in: int().notNull(),
  created_at: int().notNull(),
  created_at_str: text().notNull(),
  expires_at: int().notNull(),
  expires_at_str: text().notNull(),
})
