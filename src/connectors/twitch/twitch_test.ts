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
    usersById: new Map(),
    globalBadges: new Map(),
    badgesByChannel: new Map(),
    cheermotesByChannel: new Map(),
    giantRewardsByChannel: new Map([['chan', new Set(['ge-reward'])]]),
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
  // History served to pollers is untouched
  assertEquals(c.getMessages('chan', 0).length, 3)

  c.handleMessage(frame('@room-id=9 :tmi.twitch.tv CLEARCHAT #chan'))
  unsubscribe()

  assertEquals(events.map((e) => e.type), [
    'message',
    'message',
    'message',
    'delete',
    'delete',
    'clear',
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
