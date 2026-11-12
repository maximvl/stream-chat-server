import { eq } from 'drizzle-orm'
import { db } from './db.ts'
import { bannedIpsTable } from './schema.ts'
import type { BanStore } from '../api/clients.ts'

export const sqliteBanStore: BanStore = {
  async load() {
    const rows = await db.select().from(bannedIpsTable).execute()
    return rows.map((r) => ({
      ip: r.ip,
      reason: r.reason,
      createdAtMs: r.created_at,
    }))
  },
  async save(ban) {
    const values = { reason: ban.reason, created_at: ban.createdAtMs }
    await db.insert(bannedIpsTable).values({ ip: ban.ip, ...values })
      .onConflictDoUpdate({ target: bannedIpsTable.ip, set: values }).execute()
  },
  async remove(ip) {
    await db.delete(bannedIpsTable).where(eq(bannedIpsTable.ip, ip)).execute()
  },
}
