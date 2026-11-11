import { assertEquals } from '@std/assert'
import { ChannelName, MessageId } from '../types.ts'
import { ChatEvent, subscribe } from '../chatEvents.ts'
import { toChatId } from '../utils.ts'
import { TwitchConnector } from './twitch_ws.ts'

// Skips the constructor: it fetches global badges from Helix
function connector(): TwitchConnector {
  return Object.assign(Object.create(TwitchConnector.prototype), {
    server: 'twitch',
    reverseChannelsMap: new Map([['#chan', 'chan']]),
    messages: new Map(),
    roomModes: new Map(),
    usersById: new Map(),
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
