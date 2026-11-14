import { assertEquals, assertRejects } from '@std/assert'
import { AvatarCache, lookupEach } from './avatars.ts'
import { KickConnector } from './kick/kick_ws.ts'
import { WtvConnector } from './wtv/wtv_ws.ts'

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

Deno.test('avatar cache asks the platform once for keys two requests want at the same time', async () => {
  const cache = new AvatarCache()
  const asked: string[][] = []
  const lookup = async (missing: string[]) => {
    asked.push(missing)
    await new Promise((resolve) => setTimeout(resolve, 5))
    return new Map(missing.map((key) => [key, `https://x/${key}.png`]))
  }
  const [stream, reader] = await Promise.all([
    cache.get(['ann', 'bob'], lookup),
    cache.get(['bob', 'cat'], lookup),
  ])
  assertEquals(stream, { ann: 'https://x/ann.png', bob: 'https://x/bob.png' })
  assertEquals(reader, { bob: 'https://x/bob.png', cat: 'https://x/cat.png' })
  assertEquals(asked, [['ann', 'bob'], ['cat']])
  assertEquals(cache.pending.size, 0)
})

Deno.test('kick avatars are looked up by user id through the username seen in chat', async () => {
  const c = Object.assign(Object.create(KickConnector.prototype), {
    avatars: new AvatarCache(),
    usernames: new Map(),
  }) as KickConnector
  c.rememberUsername('1', 'Ice_Poseidon')
  c.rememberUsername('2', 'NoPic')
  c.rememberUsername('3', 'gone')
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
    assertEquals(await c.fetchAvatars(['1', '2', '3', '99']), {
      '1': 'https://files.kick.com/p.webp',
    })
    // 2 and 3 are cached misses; 99 never wrote, so it is not asked
    assertEquals(await c.fetchAvatars(['3', '2', '99']), {})
    assertEquals(asked, ['Ice_Poseidon', 'NoPic', 'gone'])
  } finally {
    globalThis.fetch = realFetch
  }
})

Deno.test('w.tv avatars come from the user channel, with a user agent', async () => {
  const c = Object.assign(Object.create(WtvConnector.prototype), {
    avatars: new AvatarCache(),
  }) as WtvConnector
  const id = '01a1743a-c8c5-71d8-8fe0-94b57a9dfd0e'
  const realFetch = globalThis.fetch
  globalThis.fetch = (input, init) => {
    assertEquals(new Headers(init?.headers).has('user-agent'), true)
    assertEquals(
      String(input),
      `https://streams-search-service.w.tv/api/v1/channels/${id}`,
    )
    return Promise.resolve(Response.json({
      channel: { channelId: id, imageUrl: 'https://files.w.tv/pub/a' },
    }))
  }
  try {
    assertEquals(await c.fetchAvatars([id]), {
      [id]: 'https://files.w.tv/pub/a',
    })
  } finally {
    globalThis.fetch = realFetch
  }
})
