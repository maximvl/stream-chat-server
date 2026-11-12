const AVATAR_TTL_MS = 3 * 60 * 60 * 1000
const MAX_AVATARS = 50_000
// Platforms without a batch lookup are asked one user at a time, this many at once
const LOOKUP_CONCURRENCY = 4

// Clients only load https pictures
export function httpsOnly(url: string | null | undefined): string {
  return url?.startsWith('https://') ? url : ''
}

// Profile image url by user key, '' for a user the platform doesn't know; oldest first
export class AvatarCache {
  entries: Map<string, { url: string; expiresAt: number }> = new Map()

  // lookup answers a url or '' per key; keys it leaves out failed and are asked
  // again next time. Throws when nothing was answered, so nothing is cached.
  async get(
    keys: string[],
    lookup: (missing: string[]) => Promise<Map<string, string>>,
  ): Promise<Record<string, string>> {
    const now = Date.now()
    const result: Record<string, string> = {}
    const missing: string[] = []
    for (const key of keys) {
      const cached = this.entries.get(key)
      if (!cached || cached.expiresAt <= now) missing.push(key)
      else if (cached.url) result[key] = cached.url
    }
    if (missing.length === 0) return result

    const found = await lookup(missing)
    if (found.size === 0) throw new Error('No avatar lookup succeeded')
    const expiresAt = now + AVATAR_TTL_MS
    for (const [key, rawUrl] of found) {
      const url = httpsOnly(rawUrl)
      // Re-inserted so the Map stays ordered oldest first for the size cap
      this.entries.delete(key)
      this.entries.set(key, { url, expiresAt })
      if (url) result[key] = url
    }
    for (const key of this.entries.keys()) {
      if (this.entries.size <= MAX_AVATARS) break
      this.entries.delete(key)
    }
    return result
  }
}

// one(key) answers a url, '' for an unknown user, or throws to leave the key out
export async function lookupEach(
  keys: string[],
  one: (key: string) => Promise<string>,
): Promise<Map<string, string>> {
  const found = new Map<string, string>()
  for (let i = 0; i < keys.length; i += LOOKUP_CONCURRENCY) {
    await Promise.all(
      keys.slice(i, i + LOOKUP_CONCURRENCY).map((key) =>
        one(key).then((url) => found.set(key, url), () => {})
      ),
    )
  }
  return found
}
