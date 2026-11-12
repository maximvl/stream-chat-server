import { assertEquals } from '@std/assert'
import { AppState } from '../app.ts'
import { API_TOKEN } from '../config.ts'
import { ChatConnector } from '../connectors/types.ts'
import { apiLimiter, joinLimiter, main_handler } from './handlers.ts'
import { clientIp, ipMatcher, RateLimiter } from './limits.ts'

Deno.test('ip matcher takes addresses and CIDR ranges of both families', () => {
  const match = ipMatcher('172.16.0.0/12, 203.0.113.7, 2a01:db8::/32, bad, ::1')
  assertEquals(match('172.18.0.1'), true)
  assertEquals(match('172.32.0.1'), false)
  assertEquals(match('203.0.113.7'), true)
  assertEquals(match('::ffff:203.0.113.7'), true)
  assertEquals(match('2a01:db8:1::5'), true)
  assertEquals(match('2a01:db9::5'), false)
  assertEquals(match('::1'), true)
  assertEquals(match('not an ip'), false)
})

Deno.test('client ip believes forwarding headers only from trusted proxies', () => {
  const trusted = ipMatcher('172.16.0.0/12,198.51.100.0/24')
  const req = (headers: Record<string, string>) =>
    new Request('http://x/', { headers })
  const forwarded = { 'x-forwarded-for': '6.6.6.6, 1.2.3.4, 198.51.100.9' }

  // Socket is not a proxy: the headers may be forged
  assertEquals(clientIp(req(forwarded), '9.9.9.9', trusted), '9.9.9.9')
  // nginx (docker bridge) and the DDoS protection are skipped from the right;
  // the forged entry on the left is never reached
  assertEquals(clientIp(req(forwarded), '172.18.0.1', trusted), '1.2.3.4')
  assertEquals(
    clientIp(req({ 'x-real-ip': '1.2.3.4' }), '172.18.0.1', trusted),
    '1.2.3.4',
  )
  assertEquals(clientIp(req({}), '172.18.0.1', trusted), '172.18.0.1')
})

Deno.test('rate limiter counts per key per window and says how long to wait', () => {
  const limiter = new RateLimiter(2, 1000)
  assertEquals(limiter.hit('a', 0), 0)
  assertEquals(limiter.hit('a', 100), 0)
  assertEquals(limiter.hit('a', 400), 600)
  assertEquals(limiter.hit('b', 400), 0)
  assertEquals(limiter.hit('a', 1000), 0)
  assertEquals(new RateLimiter(0, 1000).hit('a'), 0)
})

function fakeConnector(
  joined: number,
): ChatConnector & { connected: string[] } {
  const connected: string[] = []
  const channels = Array.from({ length: joined }, (_, i) => `c${i}`)
  return {
    connected,
    connect: (channel) => {
      connected.push(channel)
      return Promise.resolve()
    },
    disconnect: () => {},
    cleanup: () => {},
    getChannelStatus: (channel) =>
      channels.includes(channel)
        ? {
          channel: channel as never,
          status: 'connected',
          joinedAtMs: 0,
          joinedAtStr: '',
          uptimeMs: 0,
          messagesCount: 0,
        }
        : null,
    getMessages: () => [],
    getLastMessages: () => [],
    getStatus: () => ({
      server: 'kick',
      status: 'connected',
      startedAtMs: 0,
      startedAtStr: '',
      uptimeMs: 0,
      channels: channels.map((channel) => ({
        channel: channel as never,
        status: 'connected',
        joinedAtMs: 0,
        joinedAtStr: '',
        uptimeMs: 0,
        messagesCount: 0,
      })),
    }),
  }
}

function connect(channel: string, ip: string) {
  return main_handler(
    new Request('http://x/api/chat_connect', {
      method: 'POST',
      body: JSON.stringify({ server: 'kick', channel }),
      headers: API_TOKEN ? { authorization: 'Bearer wrong' } : {},
    }),
    { remoteAddr: { transport: 'tcp', hostname: ip, port: 1 } },
  )
}

Deno.test('a new channel past the cap gets 503, joined channels keep working', async () => {
  if (API_TOKEN) return // every request would be refused before the route
  const c = fakeConnector(300)
  AppState.connectors.set('kick', c)
  try {
    assertEquals((await connect('c5', '203.0.113.1')).status, 200)
    const refused = await connect('fresh', '203.0.113.1')
    assertEquals(refused.status, 503)
    assertEquals(c.connected, ['c5'])
  } finally {
    AppState.connectors.delete('kick')
  }
})

Deno.test('new channels are limited per client ip with Retry-After; private addresses are not', async () => {
  if (API_TOKEN) return
  const c = fakeConnector(0)
  AppState.connectors.set('kick', c)
  const saved = joinLimiter.limit
  joinLimiter.limit = 2
  try {
    assertEquals((await connect('a', '203.0.113.2')).status, 200)
    assertEquals((await connect('b', '203.0.113.2')).status, 200)
    const refused = await connect('c', '203.0.113.2')
    assertEquals(refused.status, 429)
    assertEquals(Number(refused.headers.get('retry-after')) > 0, true)
    assertEquals((await connect('c', '203.0.113.3')).status, 200)
    assertEquals((await connect('d', '172.18.0.1')).status, 200)
    assertEquals((await connect('e', '172.18.0.1')).status, 200)
    assertEquals((await connect('f', '172.18.0.1')).status, 200)
  } finally {
    joinLimiter.limit = saved
    joinLimiter.windows.clear()
    apiLimiter.windows.clear()
    AppState.connectors.delete('kick')
  }
})

Deno.test('the general limit answers 429 and leaves /api/status alone', async () => {
  const saved = apiLimiter.limit
  apiLimiter.limit = 1
  const get = (path: string) =>
    main_handler(new Request(`http://x${path}`), {
      remoteAddr: { transport: 'tcp', hostname: '203.0.113.4', port: 1 },
    })
  try {
    await get('/api/chat_messages')
    assertEquals((await get('/api/chat_messages')).status, 429)
    assertEquals((await get('/api/status')).status, 200)
  } finally {
    apiLimiter.limit = saved
    apiLimiter.windows.clear()
  }
})
