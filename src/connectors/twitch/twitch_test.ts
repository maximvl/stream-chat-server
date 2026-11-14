import { assertEquals } from '@std/assert'
import { ChannelName, MessageId } from '../types.ts'
import { ChatEvent, subscribe } from '../chatEvents.ts'
import { toChatId } from '../utils.ts'
import { TwitchConnector } from './twitch_ws.ts'
import { AppState } from '../../app.ts'
import { AvatarCache } from '../avatars.ts'
import { API_TOKEN } from '../../config.ts'
import { main_handler } from '../../api/handlers.ts'

// Skips the constructor: it fetches global badges from Helix
function connector(): TwitchConnector {
  return Object.assign(Object.create(TwitchConnector.prototype), {
    server: 'twitch',
    reverseChannelsMap: new Map([['#chan', 'chan']]),
    messages: new Map(),
    roomModes: new Map(),
    usersById: new Map(),
    avatars: new AvatarCache(),
    web_auth_headers: () => Promise.resolve({}),
    globalBadges: new Map(),
    badgesByChannel: new Map(),
    badgesRetryAt: new Map(),
    cheermotesByChannel: new Map(),
    rewardsByChannel: new Map([[
      'chan',
      new Map([['ge-reward', { title: 'FFZ:GE', giant: true }]]),
    ]]),
    giantRewardsRetryAt: new Map(),
    // No Helix in tests: a badge fetch "fails" unless a test stubs it
    fetch_badges: () => Promise.resolve(null),
    fetch_rewards: () =>
      Promise.resolve(
        new Map([['ge-reward', { title: 'FFZ:GE', giant: true }]]),
      ),
  })
}

function frame(line: string): MessageEvent {
  return { data: `${line}\r\n` } as MessageEvent
}

function privmsg(id: string, userId: string, text: string, emotes = '') {
  return `@emotes=${emotes};id=${id};user-id=${userId};tmi-sent-ts=1 :bob!bob@bob.tmi.twitch.tv PRIVMSG #chan :${text}`
}

Deno.test('twitch parses emotes by code point and keeps numeric user id', () => {
  const c = connector()
  c.handleMessage(
    frame(privmsg('m1', '42', '😀 Kappa hi Kappa', '25:2-6,11-15')),
  )

  const [msg] = c.getMessages('chan', 0)
  assertEquals(msg.user.twitchFields?.userId, '42')
  assertEquals(msg.emotes, [{
    id: '25',
    name: 'Kappa',
    imageUrl: 'https://static-cdn.jtvnw.net/emoticons/v2/25/default/dark/3.0',
  }])
})

Deno.test('twitch takes emote names of a /me message from the text after the ACTION marker', () => {
  const c = connector()
  c.handleMessage(
    frame(privmsg('m1', '42', '\x01ACTION 😀 Kappa hi\x01', '25:2-6')),
  )

  const [msg] = c.getMessages('chan', 0)
  assertEquals(msg.text, '\x01ACTION 😀 Kappa hi\x01')
  assertEquals(msg.emotes?.map((e) => e.name), ['Kappa'])
})

Deno.test('twitch notifies subscribers about moderated messages', () => {
  const c = connector()
  const events: ChatEvent[] = []
  const unsubscribe = subscribe(
    toChatId('twitch', 'chan' as ChannelName),
    (e) => events.push(e),
  )

  c.handleMessage(frame(privmsg('m1', '1', 'a')))
  c.handleMessage(frame(privmsg('m2', '2', 'b')))
  c.handleMessage(frame(privmsg('m3', '2', 'c')))
  c.handleMessage(frame(
    '@login=bob;target-msg-id=m1 :tmi.twitch.tv CLEARMSG #chan :a',
  ))
  c.handleMessage(frame(
    '@ban-duration=60;target-user-id=2 :tmi.twitch.tv CLEARCHAT #chan :bob',
  ))
  // History served to pollers keeps the messages and gains the timeout notice
  assertEquals(c.getMessages('chan', 0).length, 4)

  c.handleMessage(frame('@room-id=9 :tmi.twitch.tv CLEARCHAT #chan'))
  unsubscribe()

  assertEquals(events.map((e) => e.type), [
    'message',
    'message',
    'message',
    'delete',
    'delete',
    'message',
    'clear',
    'message',
  ])
  assertEquals(events[3], { type: 'delete', messageIds: ['m1'] as MessageId[] })
  assertEquals(events[4], {
    type: 'delete',
    messageIds: ['m2', 'm3'] as MessageId[],
  })
})

Deno.test('twitch GIF keyboard and cheers become emotes', () => {
  const c = connector()
  c.cheermotesByChannel = new Map([[
    'chan' as ChannelName,
    new Map([['cheer', [
      { minBits: 1, color: '#979797', imageUrl: 'https://x/1.gif' },
      { minBits: 100, color: '#9c3ee8', imageUrl: 'https://x/100.gif' },
    ]]]),
  ]])

  c.handleMessage(frame(
    '@bits=150;gifs=4-6|g1|https://media.example/a.gif;id=m1;user-id=1;tmi-sent-ts=1 :bob!bob@bob.tmi.twitch.tv PRIVMSG #chan :hey GIF Cheer100 Cheer50 gg',
  ))
  const [msg] = c.getMessages('chan', 0)
  assertEquals(msg.emotes, [
    {
      id: 'g1',
      name: 'GIF',
      imageUrl: 'https://media.example/a.gif',
      kind: 'gif',
    },
    {
      id: 'cheer',
      name: 'Cheer100',
      imageUrl: 'https://x/100.gif',
      kind: 'cheer',
      bits: 100,
      color: '#9c3ee8',
    },
    {
      id: 'cheer',
      name: 'Cheer50',
      imageUrl: 'https://x/1.gif',
      kind: 'cheer',
      bits: 50,
      color: '#979797',
    },
  ])

  // Without bits, "Cheer100" is just a word
  c.handleMessage(frame(privmsg('m2', '1', 'Cheer100 lol')))
  assertEquals(c.getMessages('chan', 0)[1].emotes, [])
})

Deno.test('twitch marks giant emote messages', () => {
  const c = connector()
  c.handleMessage(frame(
    '@custom-reward-id=ge-reward;id=m1;user-id=1;tmi-sent-ts=1 :bob!bob@bob.tmi.twitch.tv PRIVMSG #chan :big Kappa',
  ))
  c.handleMessage(frame(
    '@msg-id=gigantified-emote-message;id=m2;user-id=1;tmi-sent-ts=1 :bob!bob@bob.tmi.twitch.tv PRIVMSG #chan :Kappa',
  ))
  c.handleMessage(frame(
    '@custom-reward-id=other;id=m3;user-id=1;tmi-sent-ts=1 :bob!bob@bob.tmi.twitch.tv PRIVMSG #chan :Kappa',
  ))
  assertEquals(
    c.getMessages('chan', 0).map((m) => m.user.twitchFields?.giantEmote),
    [true, true, false],
  )
})

Deno.test('twitch asks the rewards again for an unknown one, at most once a minute', async () => {
  const c = connector()
  let asked = 0
  c.fetch_rewards = () => {
    asked++
    return Promise.resolve(
      new Map([
        ['ge-reward', { title: 'FFZ:GE', giant: true }],
        ['new-ge', { title: 'FFZ:GE new', giant: true }],
      ]),
    )
  }
  const redeem = (id: string, reward: string) =>
    c.handleMessage(frame(
      `@custom-reward-id=${reward};id=${id};user-id=1;tmi-sent-ts=1 :bob!bob@bob.tmi.twitch.tv PRIVMSG #chan :Kappa`,
    ))

  redeem('m1', 'ge-reward')
  assertEquals(asked, 0)
  redeem('m2', 'new-ge')
  redeem('m3', 'other')
  assertEquals(asked, 1)
  await Promise.resolve()
  redeem('m4', 'new-ge')
  assertEquals(
    c.getMessages('chan', 0).map((m) => m.user.twitchFields?.giantEmote),
    [true, false, false, true],
  )
})

Deno.test('twitch marks first messages', () => {
  const c = connector()
  c.handleMessage(frame(
    '@first-msg=1;id=m1;user-id=1;tmi-sent-ts=1 :bob!bob@bob.tmi.twitch.tv PRIVMSG #chan :hi',
  ))
  c.handleMessage(frame(
    '@first-msg=0;id=m2;user-id=1;tmi-sent-ts=1 :bob!bob@bob.tmi.twitch.tv PRIVMSG #chan :hi again',
  ))
  assertEquals(
    c.getMessages('chan', 0).map((m) => m.user.twitchFields?.firstMessage),
    [true, false],
  )
})

Deno.test('twitch prefers the channel badge over the global one of the same set', () => {
  const c = connector()
  const version = (id: string, url: string) => ({
    id,
    title: url,
    description: '',
    image_url_1x: url,
    image_url_2x: url,
    image_url_4x: url,
  })
  c.globalBadges = new Map([
    ['subscriber', new Map([['0', version('0', 'star')]])],
    ['vip', new Map([['1', version('1', 'vip')]])],
  ])
  c.badgesByChannel.set(
    'chan' as ChannelName,
    new Map([[
      'subscriber',
      new Map([
        ['0', version('0', 'cat')],
        ['12', version('12', 'fox')],
      ]),
    ]]),
  )

  const urls = (tag: string) =>
    c.parseBadges('chan' as ChannelName, tag).map((b) => b.imageUrl)
  assertEquals(urls('subscriber/0,vip/1'), ['cat', 'vip'])
  assertEquals(urls('subscriber/12'), ['fox'])
  assertEquals(
    c.parseBadges('chan' as ChannelName, 'vip/1').map((b) => b.setId),
    ['vip'],
  )
})

Deno.test('twitch retries a failed badge fetch, at most once a minute', async () => {
  const c = connector()
  c.badgesByChannel.clear()
  const asked: (string | undefined)[] = []
  let answer: Map<string, Map<string, never>> | null = null
  c.fetch_badges = (channel) => {
    asked.push(channel)
    return Promise.resolve(answer)
  }

  c.parseBadges('chan' as ChannelName, '')
  c.parseBadges('chan' as ChannelName, '')
  assertEquals(asked, [undefined, 'chan'])

  c.badgesRetryAt.clear()
  answer = new Map()
  c.parseBadges('chan' as ChannelName, '')
  await Promise.resolve()
  assertEquals(c.badgesByChannel.has('chan' as ChannelName), true)
  // An empty set is a real answer: the channel is not asked again
  c.badgesRetryAt.clear()
  c.parseBadges('chan' as ChannelName, '')
  assertEquals(asked.filter((a) => a === 'chan').length, 2)
})

Deno.test('twitch turns USERNOTICE into notices, with or without the user message', () => {
  const c = connector()
  c.handleMessage(frame(
    '@display-name=Bob;id=n1;login=bob;msg-id=resub;msg-param-cumulative-months=12;msg-param-sub-plan=1000;msg-param-sub-plan-name=Channel\\sSub;system-msg=bob\\ssubscribed;tmi-sent-ts=5;user-id=7 :tmi.twitch.tv USERNOTICE #chan :love it',
  ))
  c.handleMessage(frame(
    '@display-name=Ann;id=n2;login=ann;msg-id=viewermilestone;msg-param-category=watch-streak;msg-param-value=3;tmi-sent-ts=6;user-id=8 :tmi.twitch.tv USERNOTICE #chan',
  ))
  const [resub, streak] = c.getMessages('chan', 0)
  assertEquals(resub.user.id, 'bob')
  assertEquals(resub.text, 'love it')
  assertEquals(resub.notice, {
    kind: 'resub',
    params: {
      'cumulative-months': '12',
      'sub-plan': '1000',
      'sub-plan-name': 'Channel Sub',
    },
    systemText: 'bob subscribed',
  })
  assertEquals(streak.text, '')
  assertEquals(streak.notice?.kind, 'viewermilestone')
  assertEquals(streak.notice?.params.value, '3')
})

Deno.test('twitch keeps the summary of a mass gift and drops Shared Chat copies of other channels', () => {
  const c = connector()
  c.handleMessage(frame(
    '@id=g0;login=bob;msg-id=submysterygift;msg-param-mass-gift-count=2 :tmi.twitch.tv USERNOTICE #chan',
  ))
  c.handleMessage(frame(
    '@id=g1;login=bob;msg-id=subgift;msg-param-community-gift-id=x;msg-param-recipient-display-name=A :tmi.twitch.tv USERNOTICE #chan',
  ))
  c.handleMessage(frame(
    '@id=g2;login=bob;msg-id=subgift;msg-param-recipient-display-name=B :tmi.twitch.tv USERNOTICE #chan',
  ))
  c.handleMessage(frame(
    '@id=s1;login=eve;msg-id=sharedchatnotice;source-msg-id=raid;msg-param-viewerCount=5 :tmi.twitch.tv USERNOTICE #chan',
  ))
  const notices = c.getMessages('chan', 0).map((m) => m.notice)
  assertEquals(notices.map((n) => n?.kind), ['submysterygift', 'subgift'])
})

Deno.test('twitch reports bans and room mode changes, not the modes on join', () => {
  const c = connector()
  c.handleMessage(frame(
    '@emote-only=0;followers-only=-1;r9k=0;room-id=1;slow=0;subs-only=0 :tmi.twitch.tv ROOMSTATE #chan',
  ))
  c.handleMessage(frame('@room-id=1;slow=10 :tmi.twitch.tv ROOMSTATE #chan'))
  // A rejoin repeats the snapshot: nothing new
  c.handleMessage(frame(
    '@emote-only=0;followers-only=-1;r9k=0;room-id=1;slow=10;subs-only=0 :tmi.twitch.tv ROOMSTATE #chan',
  ))
  c.handleMessage(frame(
    '@room-id=1;target-user-id=2;tmi-sent-ts=9 :tmi.twitch.tv CLEARCHAT #chan :bob',
  ))
  const messages = c.getMessages('chan', 0)
  assertEquals(messages.map((m) => m.notice), [
    {
      kind: 'roomstate',
      params: { mode: 'slow', value: '10' },
      systemText: '',
    },
    { kind: 'ban', params: {}, systemText: '' },
  ])
  assertEquals(messages[1].user.id, 'bob')
  assertEquals(messages[1].timestampMs, 9)
})

Deno.test('twitch tells which channel points reward a message bought', () => {
  const c = connector()
  c.rewardsByChannel.set(
    'chan' as ChannelName,
    new Map([['ask', {
      title: 'Задать вопрос',
      cost: 500,
      color: '#9146FF',
      giant: false,
    }]]),
  )
  c.handleMessage(frame(
    `@custom-reward-id=ask;id=m1;user-id=1;tmi-sent-ts=1 :bob!bob@bob.tmi.twitch.tv PRIVMSG #chan :как дела`,
  ))
  assertEquals(c.getMessages('chan', 0)[0].user.twitchFields?.reward, {
    id: 'ask',
    title: 'Задать вопрос',
    cost: 500,
    color: '#9146FF',
  })
})

Deno.test('twitch avatars: validates ids, caches hits and misses, answers 502 without caching when Helix fails', async () => {
  const c = connector()
  AppState.connectors.set('twitch', c)
  const realFetch = globalThis.fetch
  const asked: string[] = []
  let failing = false
  globalThis.fetch = (input) => {
    const url = new URL(String(input))
    asked.push(url.searchParams.getAll('id').join(','))
    if (failing) return Promise.resolve(new Response('', { status: 500 }))
    return Promise.resolve(Response.json({
      data: url.searchParams.getAll('id').filter((id) => id === '1').map((
        id,
      ) => ({
        id,
        login: 'bob',
        display_name: 'Bob',
        type: '',
        broadcaster_type: '',
        description: '',
        profile_image_url: 'https://cdn/bob-300x300.png',
        offline_image_url: '',
        view_count: 0,
        created_at: '',
      })),
    }))
  }
  const get = (query: string) =>
    main_handler(
      new Request(`http://localhost/api/avatars?${query}`, {
        headers: API_TOKEN ? { authorization: `Bearer ${API_TOKEN}` } : {},
      }),
    )

  try {
    assertEquals((await get('server=kick&ids=1')).status, 400)
    assertEquals((await get('server=twitch&ids=1,abc')).status, 400)
    assertEquals((await get('server=twitch')).status, 400)
    assertEquals(asked, [])

    const first = await get('server=twitch&ids=1,2,1')
    assertEquals(await first.json(), {
      avatars: { '1': 'https://cdn/bob-300x300.png' },
    })
    assertEquals(asked, ['1,2'])

    // Both the hit and the miss come from the cache
    const second = await get('server=twitch&ids=2,1')
    assertEquals(await second.json(), {
      avatars: { '1': 'https://cdn/bob-300x300.png' },
    })
    assertEquals(asked, ['1,2'])

    failing = true
    assertEquals((await get('server=twitch&ids=3,1')).status, 502)
    failing = false
    await get('server=twitch&ids=3')
    assertEquals(asked, ['1,2', '3', '3'])

    const many = Array.from({ length: 150 }, (_, i) => i + 10).join(',')
    await get(`server=twitch&ids=${many}`)
    assertEquals(asked.at(-1)?.split(',').length, 100)
  } finally {
    globalThis.fetch = realFetch
    AppState.connectors.delete('twitch')
  }
})

Deno.test('twitch join asks GQL for the pin and the prediction up, a locked one included', async () => {
  const c = connector()
  const realFetch = globalThis.fetch
  let channel: unknown = null
  globalThis.fetch = () => Promise.resolve(Response.json({ data: { channel } }))
  const outcome = (id: string, totalPoints: number) => ({
    id,
    title: id.toUpperCase(),
    totalPoints,
    totalUsers: 2,
  })
  try {
    channel = {
      pinnedChatMessages: {
        edges: [{
          node: {
            endsAt: null,
            pinnedMessage: {
              id: 'p1',
              content: {
                text: 'hi Kappa',
                fragments: [{ text: 'hi ', content: null }, {
                  text: 'Kappa',
                  content: { __typename: 'Emote', emoteID: '25' },
                }],
              },
              sender: {
                id: '7',
                login: 'eve',
                displayName: 'Eve',
                chatColor: null,
              },
            },
          },
        }],
      },
      activePredictionEvents: [],
      lockedPredictionEvents: [{
        id: 'e1',
        title: 'Win?',
        status: 'LOCKED',
        createdAt: '2026-11-14T03:15:40Z',
        predictionWindowSeconds: 120,
        outcomes: [outcome('yes', 300), outcome('no', 100)],
      }],
    }
    const locked = await c.fetch_state('chan' as ChannelName, '42')
    assertEquals(locked.pin?.text, 'hi Kappa')
    assertEquals(locked.pin?.emotes?.map((e) => e.name), ['Kappa'])
    assertEquals(locked.prediction, {
      id: 'e1',
      title: 'Win?',
      outcomes: [{ title: 'YES', points: 300, users: 2 }, {
        title: 'NO',
        points: 100,
        users: 2,
      }],
      state: 'locked',
    })

    channel = {
      pinnedChatMessages: { edges: [] },
      activePredictionEvents: [{
        id: 'e2',
        title: 'Map?',
        status: 'ACTIVE',
        createdAt: '2026-11-14T03:15:40Z',
        predictionWindowSeconds: 120,
        outcomes: [outcome('a', 0), outcome('b', 0)],
      }],
      lockedPredictionEvents: [],
    }
    const open = await c.fetch_state('chan' as ChannelName, '42')
    assertEquals(open.pin, null)
    assertEquals(open.prediction?.state, 'open')
    assertEquals(
      open.prediction?.endsAtMs,
      Date.parse('2026-11-14T03:15:40Z') + 120_000,
    )

    channel = { pinnedChatMessages: null }
    assertEquals(await c.fetch_state('chan' as ChannelName, '42'), {
      pin: null,
      prediction: null,
    })
  } finally {
    globalThis.fetch = realFetch
  }
})

Deno.test('twitch pins and polls from PubSub become chat state', () => {
  const c = connector()
  c.channelByBroadcaster = new Map([['42', 'chan' as ChannelName]])
  const events: ChatEvent[] = []
  const unsubscribe = subscribe(
    toChatId('twitch', 'chan' as ChannelName),
    (e) => events.push(e),
  )
  c.handlePubSub('pinned-chat-updates-v1.42', {
    type: 'pin-message',
    data: {
      id: 'pin1',
      pinned_by: { id: '1', display_name: 'Mod' },
      message: {
        id: 'msg1',
        sender: {
          user_id: '7',
          login: 'eve',
          display_name: 'Eve',
          chat_color: '#00FF00',
          badges: [],
        },
        content: {
          text: 'hello Kappa',
          fragments: [{ text: 'hello ' }, {
            text: 'Kappa',
            emoticon: { emoticon_id: '25', emoticon_set_id: '0' },
          }],
        },
        type: 'MOD',
        ends_at: null,
      },
    },
  })
  c.handlePubSub('pinned-chat-updates-v1.42', {
    type: 'update-message',
    data: { id: 'pin1', ends_at: 2_000_000_000 },
  })
  c.handlePubSub('polls.42', {
    type: 'POLL_UPDATE',
    data: {
      poll: {
        poll_id: 'p1',
        title: 'Map?',
        status: 'ACTIVE',
        choices: [{ choice_id: 'c1', title: 'A', votes: { total: 4 } }],
        remaining_duration_milliseconds: 30_000,
      },
    },
  })
  c.handlePubSub('polls.42', {
    type: 'POLL_ARCHIVE',
    data: {
      poll: {
        poll_id: 'p1',
        title: 'Map?',
        status: 'ARCHIVED',
        choices: [],
      },
    },
  })
  c.handlePubSub('pinned-chat-updates-v1.42', {
    type: 'unpin-message',
    data: { id: 'pin1' },
  })
  // Another channel's topic is ignored
  c.handlePubSub('polls.99', { type: 'POLL_UPDATE', data: {} })
  unsubscribe()

  assertEquals(events.map((e) => e.type), ['pin', 'pin', 'poll', 'poll', 'pin'])
  const pin = events[0].type === 'pin' ? events[0].pin : null
  assertEquals(pin?.text, 'hello Kappa')
  assertEquals(pin?.user.displayName, 'Eve')
  assertEquals(pin?.user.twitchFields?.color, '#00FF00')
  assertEquals(pin?.emotes?.map((e) => [e.id, e.name]), [['25', 'Kappa']])
  assertEquals(pin?.endsAtMs, undefined)
  const updated = events[1].type === 'pin' ? events[1].pin : null
  assertEquals(updated?.endsAtMs, 2_000_000_000_000)
  const poll = events[2].type === 'poll' ? events[2].poll : null
  assertEquals([poll?.title, poll?.ended, poll?.choices], ['Map?', false, [{
    title: 'A',
    votes: 4,
  }]])
  assertEquals(events[3].type === 'poll' && events[3].poll, null)
  assertEquals(events[4].type === 'pin' && events[4].pin, null)
})

Deno.test('chat stream sends the current pin and poll only to pins=1 clients', async () => {
  const { setPin, setPoll } = await import('../chatEvents.ts')
  const chatId = toChatId('twitch', 'statechan' as ChannelName)
  setPoll(chatId, { id: 'p', title: 'Q', choices: [], ended: false })
  setPin(chatId, {
    id: 'x',
    user: { id: 'u' as never, displayName: 'U' },
    text: 'pinned',
  })
  const c = connector()
  c.connect = () => Promise.resolve()
  c.getMessages = () => []
  AppState.connectors.set('twitch', c)
  const read = async (query: string) => {
    const response = await main_handler(
      new Request(
        `http://x/api/chat_stream?server=twitch&channel=statechan${query}`,
      ),
      { remoteAddr: { hostname: '127.0.0.1' } } as never,
    )
    const reader = response.body!.getReader()
    // One chunk per event; the keep-alive ping is the last one sent on open
    let text = ''
    while (!text.includes('event: ping')) {
      const { value, done } = await reader.read()
      if (done) break
      text += new TextDecoder().decode(value)
    }
    await reader.cancel()
    return text
  }
  const withState = await read('&pins=1')
  const without = await read('')
  setPin(chatId, null)
  setPoll(chatId, null)
  // Gone while a client was away: it hears null, not silence, so it drops its stale cards
  const cleared = await read('&pins=1')
  assertEquals(cleared.includes('"pin":null'), true)
  assertEquals(cleared.includes('"poll":null'), true)
  assertEquals(cleared.includes('"prediction":null'), true)
  assertEquals(withState.includes('"type":"pin"'), true)
  assertEquals(withState.includes('"type":"poll"'), true)
  assertEquals(without.includes('"type":"pin"'), false)
})

Deno.test('twitch predictions from PubSub: open, locked, resolved, canceled', () => {
  const c = connector()
  c.channelByBroadcaster = new Map([['42', 'chan' as ChannelName]])
  const events: ChatEvent[] = []
  const unsubscribe = subscribe(
    toChatId('twitch', 'chan' as ChannelName),
    (e) => events.push(e),
  )
  const send = (status: string) =>
    c.handlePubSub('predictions-channel-v1.42', {
      type: 'event-updated',
      data: {
        timestamp: '2026-11-14T00:00:05Z',
        event: {
          id: 'e1',
          title: 'Win?',
          status,
          created_at: '2026-11-14T00:00:00Z',
          prediction_window_seconds: 120,
          winning_outcome_id: status === 'RESOLVED' ? 'o2' : null,
          outcomes: [
            {
              id: 'o1',
              title: 'Yes',
              color: 'BLUE',
              total_points: 1000,
              total_users: 10,
            },
            {
              id: 'o2',
              title: 'No',
              color: 'PINK',
              total_points: 3000,
              total_users: 5,
            },
          ],
        },
      },
    })
  for (const status of ['ACTIVE', 'LOCKED', 'RESOLVED', 'CANCELED']) {
    send(status)
  }
  unsubscribe()

  const got = events.map((e) => e.type === 'prediction' ? e.prediction : 'x')
  assertEquals(got.map((p) => p && typeof p === 'object' ? p.state : p), [
    'open',
    'locked',
    'resolved',
    null,
  ])
  assertEquals(
    (got[0] as { endsAtMs?: number }).endsAtMs,
    Date.parse('2026-11-14T00:02:00Z'),
  )
  assertEquals((got[2] as { winner?: number }).winner, 1)
})
