import { int, sqliteTable, text } from 'drizzle-orm/sqlite-core'

export const tokensTable = sqliteTable('tokens', {
  id: int().primaryKey({ autoIncrement: true }),
  server: text().notNull(),
  token: text().notNull(),
  refresh_token: text().notNull(),
  createdAt: int().notNull(),
  expires_in: int().notNull(),
})
