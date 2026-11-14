// /api/admin/*: what the RTE chats admin shows (chats read, clients by address) and the ban list.
// Called by the RTE backend with ADMIN_TOKEN, never by browsers.
import { timingSafeEqual } from 'node:crypto'
import { AppState } from '../app.ts'
import { ADMIN_TOKEN } from '../config.ts'
import { normalizeChannel, toChatId } from '../connectors/utils.ts'
import { ipMatcher, isIpOrRange, PRIVATE_RANGES } from './limits.ts'

const MAX_REASON = 200
// Proxies in front of us and our own services on the docker network: banning them cuts everyone off
const isPrivate = ipMatcher(PRIVATE_RANGES)
// An address inside each private range: a range covering one (0.0.0.0/0, "/2" typed for "/24") cuts everyone off too
const PRIVATE_SAMPLES = [
  '127.0.0.1',
  '10.0.0.1',
  '172.16.0.1',
  '192.168.0.1',
  '::1',
  'fc00::1',
]

function authorized(req: Request, token: string): boolean {
  const got = new TextEncoder().encode(req.headers.get('authorization') ?? '')
  const want = new TextEncoder().encode(`Bearer ${token}`)
  return got.length === want.length && timingSafeEqual(got, want)
}

const error = (status: number, message: string) =>
  Response.json({ errors: [message] }, { status })

export async function admin_handler(
  req: Request,
  token = ADMIN_TOKEN,
): Promise<Response> {
  if (!token) return new Response('Not found', { status: 404 })
  if (!authorized(req, token)) {
    return new Response('Unauthorized', { status: 401 })
  }
  const url = new URL(req.url)
  switch (`${req.method} ${url.pathname}`) {
    case 'GET /api/admin/overview':
      return await overview()
    case 'PUT /api/admin/bans':
      return await ban(req)
    case 'DELETE /api/admin/bans':
      return await unban(url)
  }
  return new Response('Not found', { status: 404 })
}

async function overview(): Promise<Response> {
  const statuses = await Promise.all(
    [...AppState.connectors.values()].map((c) => c.getStatus()),
  )
  const watchers = AppState.clients.watchers()
  return Response.json({
    nowMs: Date.now(),
    connectors: statuses.map((s) => ({
      ...s,
      channels: s.channels.map((ch) => ({
        ...ch,
        watchers:
          watchers.get(toChatId(s.server, normalizeChannel(ch.channel))) ?? [],
      })),
    })),
    clients: AppState.clients.list().map((c) => ({
      ...c,
      banned: AppState.bans.matches(c.ip),
    })),
    bans: AppState.bans.list(),
  })
}

// Body {ip, reason?}: an address or a CIDR range. Its open streams end right away
async function ban(req: Request): Promise<Response> {
  let body: { ip?: unknown; reason?: unknown }
  try {
    body = await req.json()
  } catch {
    return error(400, 'Invalid JSON')
  }
  const ip = typeof body?.ip === 'string' ? body.ip.trim() : ''
  if (!isIpOrRange(ip)) return error(400, 'Not an IP address or CIDR range')
  if (isPrivate(ip.split('/')[0]) || PRIVATE_SAMPLES.some(ipMatcher(ip))) {
    return error(
      400,
      'A private address: our proxies and services, not a client',
    )
  }
  const reason = typeof body.reason === 'string'
    ? body.reason.trim().slice(0, MAX_REASON)
    : ''
  const saved = await AppState.bans.add(ip, reason)
  const closedStreams = AppState.clients.closeStreams(ipMatcher(ip))
  return Response.json({ ban: saved, closedStreams })
}

async function unban(url: URL): Promise<Response> {
  const ip = url.searchParams.get('ip') ?? ''
  return (await AppState.bans.remove(ip))
    ? Response.json({ ok: true })
    : error(404, 'Not banned')
}
