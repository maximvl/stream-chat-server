import { drizzle } from 'drizzle-orm/libsql'
import { DB_FILE } from '../config.ts'

export const db = drizzle(DB_FILE)
