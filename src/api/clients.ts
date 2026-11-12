// Who uses the API, for the RTE chats admin: per client address what it asked for and which chats it
// reads right now; and the addresses it refuses.
import { ipMatcher } from './limits.ts'

const MAX_CHATS_KEPT = 500
const MAX_ORIGINS_KEPT = 10
const FORGET_AFTER_MS = 24 * 60 * 60_000
// shortcut: past this many addresses the least recently seen idle one is forgotten, enough for one server
const MAX_CLIENTS = 20_000

type Client = {
  ip: string
  firstSeenMs: number
  lastSeenMs: number
  requests: number
  // "server/channel" -> how to close each open stream of that chat
  streams: Map<string, Set<() => void>>
  chats: Set<string>
  origins: Set<string>
  userAgent: string
}

export type ClientInfo = {
  ip: string
  firstSeenMs: number
  lastSeenMs: number
  requests: number
  activeStreams: number
  // Every chat asked for in the last day, at most MAX_CHATS_KEPT
  chats: string[]
  streaming: string[]
  origins: string[]
  userAgent: string
}

export class ClientTracker {
  clients: Map<string, Client> = new Map()

  seen(ip: string, req: Request, now = Date.now()): void {
    let client = this.clients.get(ip)
    if (!client) {
      if (this.clients.size >= MAX_CLIENTS) this.sweep(now, true)
      client = {
        ip,
        firstSeenMs: now,
        lastSeenMs: now,
        requests: 0,
        streams: new Map(),
        chats: new Set(),
        origins: new Set(),
        userAgent: '',
      }
    }
    // Re-inserted so the map stays ordered by last visit
    this.clients.delete(ip)
    this.clients.set(ip, client)
    client.lastSeenMs = now
    client.requests++
    client.userAgent = (req.headers.get('user-agent') ?? '').slice(0, 300)
    const origin = req.headers.get('origin')
    if (origin && client.origins.size < MAX_ORIGINS_KEPT) {
      client.origins.add(origin.slice(0, 200))
    }
  }

  chat(ip: string, chat: string): void {
    const client = this.clients.get(ip)
    if (client && client.chats.size < MAX_CHATS_KEPT) client.chats.add(chat)
  }

  // Returns the call that forgets the stream once it ends
  streamOpened(ip: string, chat: string, close: () => void): () => void {
    const client = this.clients.get(ip)
    if (!client) return () => {}
    const closers = client.streams.get(chat) ?? new Set()
    closers.add(close)
    client.streams.set(chat, closers)
    return () => {
      closers.delete(close)
      if (!closers.size && client.streams.get(chat) === closers) {
        client.streams.delete(chat)
      }
    }
  }

  // Ends the open streams of every matching address, e.g. right after a ban
  closeStreams(matches: (ip: string) => boolean): number {
    let closed = 0
    for (const client of this.clients.values()) {
      if (!matches(client.ip)) continue
      for (const closers of [...client.streams.values()]) {
        for (const close of [...closers]) {
          close()
          closed++
        }
      }
    }
    return closed
  }

  // Addresses reading each chat right now
  watchers(): Map<string, string[]> {
    const out = new Map<string, string[]>()
    for (const client of this.clients.values()) {
      for (const chat of client.streams.keys()) {
        out.set(chat, [...(out.get(chat) ?? []), client.ip])
      }
    }
    return out
  }

  list(now = Date.now()): ClientInfo[] {
    this.sweep(now, false)
    return [...this.clients.values()].sort((a, b) =>
      b.lastSeenMs - a.lastSeenMs
    ).map((c) => ({
      ip: c.ip,
      firstSeenMs: c.firstSeenMs,
      lastSeenMs: c.lastSeenMs,
      requests: c.requests,
      activeStreams: [...c.streams.values()].reduce((n, s) => n + s.size, 0),
      chats: [...c.chats],
      streaming: [...c.streams.keys()],
      origins: [...c.origins],
      userAgent: c.userAgent,
    }))
  }

  // Forgets addresses idle for a day with nothing open; `one` also drops the oldest idle one to make room
  private sweep(now: number, one: boolean): void {
    for (const [ip, c] of this.clients) {
      if (c.streams.size) continue
      if (one || now - c.lastSeenMs > FORGET_AFTER_MS) {
        this.clients.delete(ip)
        if (one) return
      }
    }
  }
}

export type Ban = { ip: string; reason: string; createdAtMs: number }

export type BanStore = {
  load(): Promise<Ban[]>
  save(ban: Ban): Promise<void>
  remove(ip: string): Promise<void>
}

export class BanList {
  bans: Map<string, Ban> = new Map()
  matches: (ip: string) => boolean = () => false

  constructor(private store: BanStore) {}

  async load(): Promise<void> {
    this.bans = new Map((await this.store.load()).map((b) => [b.ip, b]))
    this.rebuild()
  }

  async add(ip: string, reason: string, now = Date.now()): Promise<Ban> {
    const ban = { ip, reason, createdAtMs: now }
    await this.store.save(ban)
    this.bans.set(ip, ban)
    this.rebuild()
    return ban
  }

  async remove(ip: string): Promise<boolean> {
    if (!this.bans.has(ip)) return false
    await this.store.remove(ip)
    this.bans.delete(ip)
    this.rebuild()
    return true
  }

  list(): Ban[] {
    return [...this.bans.values()].sort((a, b) => b.createdAtMs - a.createdAtMs)
  }

  private rebuild(): void {
    this.matches = ipMatcher([...this.bans.keys()].join(','))
  }
}

export function memoryBanStore(): BanStore {
  const bans = new Map<string, Ban>()
  return {
    load: () => Promise.resolve([...bans.values()]),
    save: (ban) => Promise.resolve(void bans.set(ban.ip, ban)),
    remove: (ip) => Promise.resolve(void bans.delete(ip)),
  }
}
