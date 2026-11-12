import { assertEquals, assertRejects } from '@std/assert'
import { AvatarCache, lookupEach } from './avatars.ts'
import { KickConnector } from './kick/kick_ws.ts'

Deno.test('avatar cache keeps hits and misses, asks failed keys again and drops non-https urls', async () => {
  const cache = new AvatarCache()
  const asked: string[][] = []
  const lookup = (missing: string[]) => {
    asked.push(missing)
    return lookupEach(missing, (key) => {
      if (key === 'down') return Promise.reject(new Error('timeout'))
      if (key === 'plain') return Promise.resolve('http://x/plain.png')
      return Promise.resolve(key === 'bob' ? 'https://x/bob.png' : '')
    })
  }

  assertEquals(await cache.get(['bob', 'ghost', 'down', 'plain'], lookup), {
    bob: 'https://x/bob.png',
  })
  assertEquals(await cache.get(['bob', 'ghost', 'plain'], lookup), {
    bob: 'https://x/bob.png',
  })
  // The failed key is asked again; nothing answered is an error, so the handler can say 502
  await assertRejects(() => cache.get(['down'], lookup))
  assertEquals(asked, [['bob', 'ghost', 'down', 'plain'], ['down']])
})

Deno.test('kick avatars are looked up by username, unknown users are misses', async () => {
  const c = Object.assign(Object.create(KickConnector.prototype), {
    avatars: new AvatarCache(),
  }) as KickConnector
  const realFetch = globalThis.fetch
  const asked: string[] = []
  globalThis.fetch = (input) => {
    const username = String(input).split('/').at(-1)!
    asked.push(username)
    return Promise.resolve(
      username === 'Ice_Poseidon'
        ? Response.json({
          username,
          profile_pic: 'https://files.kick.com/p.webp',
        })
        : username === 'NoPic'
        ? Response.json({ username, profile_pic: null })
        : new Response('', { status: 404 }),
    )
  }
  try {
    assertEquals(await c.fetchAvatars(['Ice_Poseidon', 'NoPic', 'ghost']), {
      Ice_Poseidon: 'https://files.kick.com/p.webp',
    })
    await c.fetchAvatars(['ghost', 'NoPic'])
    assertEquals(asked, ['Ice_Poseidon', 'NoPic', 'ghost'])
  } finally {
    globalThis.fetch = realFetch
  }
})
