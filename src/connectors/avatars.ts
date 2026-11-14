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
  // Keys being looked up now: the stream and the reader of one chat ask for the same new chatters at once
  pending: Map<string, Promise<Map<string, string>>> = new Map()

  // lookup answers a url or '' per key; keys it leaves out failed and are asked
  // again next time. Throws when nothing was answered, so nothing is cached.
  async get(
    keys: string[],
    lookup: (missing: string[]) => Promise<Map<string, string>>,
  ): Promise<Record<string, string>> {
    const now = Date.now()
    const result: Record<string, string> = {}
    const missing: string[] = []
    const others: [string, Promise<Map<string, string>>][] = []
    for (const key of keys) {
      const cached = this.entries.get(key)
      const pending = this.pending.get(key)
      if (cached && cached.expiresAt > now) {
        if (cached.url) result[key] = cached.url
      } else if (pending) others.push([key, pending])
      else missing.push(key)
    }
    if (missing.length === 0 && others.length === 0) return result

    let answered = false
    if (missing.length) {
      const run = lookup(missing)
      for (const key of missing) this.pending.set(key, run)
      let found: Map<string, string>
      try {
        found = await run
      } finally {
        for (const key of missing) {
          if (this.pending.get(key) === run) this.pending.delete(key)
        }
      }
      answered = found.size > 0
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
    }
    // Keys another request was looking up: its answer, which that request cached
    for (const [key, pending] of others) {
      const found = await pending.catch(() => undefined)
      if (!found?.has(key)) continue
      answered = true
      const url = httpsOnly(found.get(key))
      if (url) result[key] = url
    }
    if (!answered) throw new Error('No avatar lookup succeeded')
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
