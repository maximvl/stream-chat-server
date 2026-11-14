import { assertEquals } from '@std/assert'
import { VkVideoConnector } from './vkvideo_ws.ts'
import { ChatEvent, subscribe } from '../chatEvents.ts'
import { toChatId } from '../utils.ts'
import { ChannelName } from '../types.ts'

// Skips the constructor and network setup
function connector(): VkVideoConnector {
  return Object.assign(Object.create(VkVideoConnector.prototype), {
    reverseChannelsMap: new Map([
      ['channel-chat:1', 'chan'],
      ['channel-info:1', 'chan'],
    ]),
    subMsgChannelMap: new Map(),
    messages: new Map(),
    channelStatus: new Map(),
  })
}

Deno.test('vk users without an avatar url get the picture by id', () => {
  const c = connector()
  c.handleMessage({
    data: JSON.stringify({
      push: {
        channel: 'channel-chat:1',
        pub: {
          data: {
            type: 'message',
            data: {
              id: 8,
              createdAt: 1,
              author: {
                id: 6,
                displayName: 'ann',
                avatarUrl: '',
                nickColor: 2,
                isChatModerator: false,
                isChannelModerator: false,
                roles: [],
                badges: [],
              },
              data: [{ type: 'text', content: '["hi"]' }],
            },
          },
        },
      },
    }),
  } as MessageEvent)
  const [msg] = c.getMessages('chan', 0)
  assertEquals(
    msg.user.avatarUrl,
    'https://images.live.vkvideo.ru/user/6/avatar',
  )
})

Deno.test('vk smiles stay in the text and are listed as emotes', () => {
  const c = connector()
  c.handleMessage({
    data: JSON.stringify({
      push: {
        channel: 'channel-chat:1',
        pub: {
          data: {
            type: 'message',
            data: {
              id: 7,
              createdAt: 1,
              author: {
                id: 5,
                displayName: 'bob',
                avatarUrl: 'https://images.live.vkvideo.ru/user/5/avatar',
                nickColor: 2,
                isChatModerator: false,
                isChannelModerator: false,
                roles: [],
                badges: [],
              },
              data: [
                { type: 'text', content: '["привет"]' },
                {
                  type: 'smile',
                  id: 's1',
                  name: 'cool',
                  largeUrl: 'https://x/large.png',
                  mediumUrl: 'https://x/m.png',
                  smallUrl: 'https://x/s.png',
                },
              ],
            },
          },
        },
      },
    }),
  } as MessageEvent)

  const [msg] = c.getMessages('chan', 0)
  assertEquals(msg.text, 'привет cool')
  assertEquals(
    msg.user.avatarUrl,
    'https://images.live.vkvideo.ru/user/5/avatar',
  )
  assertEquals(msg.emotes, [{
    id: 's1',
    name: 'cool',
    imageUrl: 'https://x/large.png',
  }])
})

Deno.test('vk mentions stay in the text', () => {
  const c = connector()
  c.handleMessage({
    data: JSON.stringify({
      push: {
        channel: 'channel-chat:1',
        pub: {
          data: {
            type: 'message',
            data: {
              id: 8,
              createdAt: 1,
              author: {
                id: 5,
                displayName: 'bob',
                nickColor: 2,
                isChatModerator: false,
                isChannelModerator: false,
                roles: [],
                badges: [],
              },
              data: [
                { type: 'mention', id: 9, displayName: 'alice', nickColor: 1 },
                { type: 'text', content: '["слишком чистый для ада"]' },
              ],
            },
          },
        },
      },
    }),
  } as MessageEvent)

  const [msg] = c.getMessages('chan', 0)
  assertEquals(msg.text, '@alice слишком чистый для ада')
  assertEquals(msg.vkFields?.mentions, [{ id: 9, displayName: 'alice' }])
})

const push = (channel: string, type: string, data: unknown) => ({
  data: JSON.stringify({ push: { channel, pub: { data: { type, data } } } }),
} as MessageEvent)

Deno.test('vk pins and polls become chat state', () => {
  const c = connector()
  const events: ChatEvent[] = []
  const unsubscribe = subscribe(
    toChatId('vkvideo', 'chan' as ChannelName),
    (e) => events.push(e),
  )
  const pinned = {
    id: 5516,
    author: { id: 6, displayName: 'ann', avatarUrl: '', nickColor: 2 },
    data: [
      { type: 'text', content: '["Ставим лайки","unstyled",[]]' },
      { type: 'smile', id: 's1', name: 'Smile', largeUrl: 'https://x/s.png' },
      { type: 'text', content: '', modificator: 'BLOCK_END' },
    ],
    kind: 'permanent',
  }
  c.handleMessage(push('channel-chat:1', 'chat_pinned_message_pin', pinned))
  // The REST answer wraps it
  c.handleMessage(
    push('channel-chat:1', 'chat_pinned_message_edit', {
      pinnedMessage: pinned,
    }),
  )
  c.handleMessage(
    push('channel-info:1', 'poll', {
      id: 3,
      title: 'Map?',
      state: 'active',
      createdAt: 100,
      duration: 60,
      decisions: [{ id: 1, name: 'A', votesCount: 2, isWinner: false }],
    }),
  )
  c.handleMessage(
    push('channel-info:1', 'poll', {
      id: 3,
      title: 'Map?',
      state: 'canceled',
      decisions: [],
    }),
  )
  c.handleMessage(push('channel-chat:1', 'chat_pinned_message_unpin', {}))
  unsubscribe()

  assertEquals(events.map((e) => e.type), ['pin', 'pin', 'poll', 'poll', 'pin'])
  const pin = events[1].type === 'pin' ? events[1].pin : null
  assertEquals(pin?.text, 'Ставим лайки Smile')
  assertEquals(pin?.emotes?.map((e) => e.name), ['Smile'])
  assertEquals(pin?.user.vkFields?.color, '#1D90FF')
  const poll = events[2].type === 'poll' ? events[2].poll : null
  assertEquals(poll, {
    id: '3',
    title: 'Map?',
    choices: [{ title: 'A', votes: 2 }],
    endsAtMs: 160_000,
    ended: false,
  })
  assertEquals(events[3].type === 'poll' && events[3].poll, null)
  assertEquals(events[4].type === 'pin' && events[4].pin, null)
})
