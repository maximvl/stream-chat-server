// Client addresses and per-IP request limits

type Range = { value: bigint; bits: number; prefix: number }

function parseIp(ip: string): { value: bigint; bits: number } | null {
  const mapped = ip.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i)
  if (mapped) ip = mapped[1]
  const v4 = ip.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/)
  if (v4) {
    const octets = v4.slice(1).map(Number)
    if (octets.some((o) => o > 255)) return null
    return {
      value: octets.reduce((acc, o) => (acc << 8n) + BigInt(o), 0n),
      bits: 32,
    }
  }
  const halves = ip.split('::')
  if (halves.length > 2) return null
  const head = halves[0] ? halves[0].split(':') : []
  const tail = halves[1] ? halves[1].split(':') : []
  const fill = 8 - head.length - tail.length
  if (halves.length === 1 ? fill !== 0 : fill < 1) return null
  const groups = [...head, ...Array(fill).fill('0'), ...tail]
  if (!groups.every((g) => /^[0-9a-f]{1,4}$/i.test(g))) return null
  return {
    value: groups.reduce(
      (acc, g) => (acc << 16n) + BigInt(parseInt(g, 16)),
      0n,
    ),
    bits: 128,
  }
}

// Comma-separated addresses and CIDR ranges, IPv4 or IPv6; bad entries are skipped
export function ipMatcher(list: string): (ip: string) => boolean {
  const ranges: Range[] = []
  for (const entry of list.split(',').map((e) => e.trim()).filter(Boolean)) {
    const [addr, prefixText] = entry.split('/')
    const ip = parseIp(addr)
    if (!ip) continue
    const prefix = prefixText === undefined ? ip.bits : Number(prefixText)
    if (!Number.isInteger(prefix) || prefix < 0 || prefix > ip.bits) continue
    ranges.push({ ...ip, prefix })
  }
  return (text) => {
    const ip = parseIp(text)
    return !!ip && ranges.some((r) => {
      if (r.bits !== ip.bits) return false
      const shift = BigInt(r.bits - r.prefix)
      return (r.value >> shift) === (ip.value >> shift)
    })
  }
}

export const PRIVATE_RANGES =
  '127.0.0.0/8,10.0.0.0/8,172.16.0.0/12,192.168.0.0/16,::1,fc00::/7'

// The socket address, unless it is a trusted proxy: then the nearest address in
// X-Forwarded-For (read from the right) that is not a trusted proxy, or X-Real-IP
export function clientIp(
  req: Request,
  remote: string,
  trusted: (ip: string) => boolean,
): string {
  if (!trusted(remote)) return remote
  const chain = (req.headers.get('x-forwarded-for') ?? '').split(',')
    .map((ip) => ip.trim()).filter(Boolean)
  if (chain.length === 0) {
    return req.headers.get('x-real-ip')?.trim() || remote
  }
  for (let i = chain.length - 1; i > 0; i--) {
    if (!trusted(chain[i])) return chain[i]
  }
  return chain[0]
}

// Fixed window counter per key; a limit of 0 or less turns it off
export class RateLimiter {
  windows: Map<string, { count: number; resetAt: number }> = new Map()

  constructor(public limit: number, public windowMs: number) {}

  // Milliseconds to wait before trying again, 0 when the request may go on
  hit(key: string, now = Date.now()): number {
    if (this.limit <= 0) return 0
    let window = this.windows.get(key)
    if (!window || window.resetAt <= now) {
      // shortcut: expired windows are only swept when the map gets big, enough for one server
      if (this.windows.size >= 100_000) {
        for (const [k, w] of this.windows) {
          if (w.resetAt <= now) this.windows.delete(k)
        }
      }
      window = { count: 0, resetAt: now + this.windowMs }
      this.windows.set(key, window)
    }
    if (window.count >= this.limit) return window.resetAt - now
    window.count++
    return 0
  }
}
