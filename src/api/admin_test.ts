import { assertEquals } from '@std/assert'
import { AppState } from '../app.ts'
import { API_TOKEN } from '../config.ts'
import { admin_handler } from './admin.ts'
import { BanList, ClientTracker, memoryBanStore } from './clients.ts'
import { main_handler } from './handlers.ts'
import { isIpOrRange } from './limits.ts'

const info = (hostname: string) =>
  ({
    remoteAddr: { transport: 'tcp', hostname, port: 1 },
  }) as unknown as Deno.ServeHandlerInfo

function fresh() {
  AppState.clients = new ClientTracker()
  AppState.bans = new BanList(memoryBanStore())
}

Deno.test('ban entries are single addresses or CIDR ranges', () => {
  assertEquals(isIpOrRange('203.0.113.7'), true)
  assertEquals(isIpOrRange('203.0.113.0/24'), true)
  assertEquals(isIpOrRange('2a01:db8::/32'), true)
  assertEquals(isIpOrRange('203.0.113.0/33'), false)
  assertEquals(isIpOrRange('203.0.113.0/'), false)
  assertEquals(isIpOrRange('203.0.113.0/24/1'), false)
  assertEquals(isIpOrRange('1.2.3.4,5.6.7.8'), false)
  assertEquals(isIpOrRange('evil'), false)
})

Deno.test('the tracker counts requests and chats per address and knows who reads a chat', () => {
  const t = new ClientTracker()
  const req = new Request('http://x/', {
    headers: { origin: 'https://a.example', 'user-agent': 'OBS' },
  })
  t.seen('1.1.1.1', req, 1000)
  t.seen('1.1.1.1', req, 2000)
  t.seen('2.2.2.2', req, 1500)
  t.chat('1.1.1.1', 'twitch/a')
  t.chat('1.1.1.1', 'kick/b')
  let closed = 0
  const forget = t.streamOpened('1.1.1.1', 'twitch/a', () => closed++)
  t.streamOpened('2.2.2.2', 'twitch/a', () => closed++)

  const [first, second] = t.list(3000)
  assertEquals(first.ip, '1.1.1.1')
  assertEquals([
    first.requests,
    first.activeStreams,
    first.chats,
    first.streaming,
  ], [2, 1, ['twitch/a', 'kick/b'], ['twitch/a']])
  assertEquals([first.origins, first.userAgent], [['https://a.example'], 'OBS'])
  assertEquals(second.ip, '2.2.2.2')
  assertEquals(t.watchers().get('twitch/a'), ['1.1.1.1', '2.2.2.2'])

  forget()
  assertEquals(t.watchers().get('twitch/a'), ['2.2.2.2'])
  assertEquals(t.closeStreams((ip) => ip === '2.2.2.2'), 1)
  assertEquals(closed, 1)

  // A day idle with nothing open: forgotten
  assertEquals(t.list(2000 + 25 * 60 * 60_000).map((c) => c.ip), ['2.2.2.2'])
})

Deno.test('admin routes want the admin token and ban addresses from the whole API', async () => {
  fresh()
  const admin = (
    method: string,
    path: string,
    body?: unknown,
    token = 'secret',
  ) =>
    admin_handler(
      new Request(`http://localhost${path}`, {
        method,
        headers: { authorization: `Bearer ${token}` },
        body: body === undefined ? undefined : JSON.stringify(body),
      }),
      'secret',
    )
  const status = (ip: string) =>
    main_handler(
      new Request('http://localhost/api/status', {
        headers: API_TOKEN ? { authorization: `Bearer ${API_TOKEN}` } : {},
      }),
      info(ip),
    )
  const avatars = (ip: string) =>
    main_handler(
      new Request('http://localhost/api/avatars?server=twitch&channel=Chan', {
        headers: API_TOKEN ? { authorization: `Bearer ${API_TOKEN}` } : {},
      }),
      info(ip),
    )

  assertEquals(
    (await admin_handler(
      new Request('http://localhost/api/admin/overview'),
      '',
    )).status,
    404,
  )
  assertEquals(
    (await admin('GET', '/api/admin/overview', undefined, 'wrong')).status,
    401,
  )
  assertEquals(
    (await admin('PUT', '/api/admin/bans', { ip: 'nope' })).status,
    400,
  )
  for (const ip of ['172.19.0.1', '10.0.0.0/8', '::1']) {
    assertEquals((await admin('PUT', '/api/admin/bans', { ip })).status, 400)
  }

  await (await avatars('203.0.113.7')).body?.cancel()
  let closed = 0
  AppState.clients.streamOpened('203.0.113.7', 'twitch/chan', () => closed++)

  const banned = await admin('PUT', '/api/admin/bans', {
    ip: '203.0.113.0/24',
    reason: ' scraping ',
  })
  assertEquals((await banned.json()).closedStreams, 1)
  assertEquals(closed, 1)
  assertEquals((await avatars('203.0.113.7')).status, 403)
  // The healthcheck is never refused
  await (await status('203.0.113.7')).body?.cancel()
  assertEquals((await status('203.0.113.7')).status, 200)

  const overview = await (await admin('GET', '/api/admin/overview')).json()
  assertEquals(
    overview.bans.map((b: { ip: string; reason: string }) => [b.ip, b.reason]),
    [['203.0.113.0/24', 'scraping']],
  )
  const client = overview.clients.find((c: { ip: string }) =>
    c.ip === '203.0.113.7'
  )
  assertEquals([client.banned, client.chats], [true, ['twitch/chan']])

  assertEquals(
    (await admin('DELETE', '/api/admin/bans?ip=203.0.113.0/24')).status,
    200,
  )
  assertEquals(
    (await admin('DELETE', '/api/admin/bans?ip=203.0.113.0/24')).status,
    404,
  )
  assertEquals((await avatars('203.0.113.7')).status !== 403, true)
  fresh()
})
