import { assertEquals } from '@std/assert'
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
