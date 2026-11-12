import { assertEquals } from '@std/assert'
import { VkVideoConnector } from './vkvideo_ws.ts'

// Skips the constructor and network setup
function connector(): VkVideoConnector {
  return Object.assign(Object.create(VkVideoConnector.prototype), {
    reverseChannelsMap: new Map([['channel-chat:1', 'chan']]),
    subMsgChannelMap: new Map(),
    messages: new Map(),
    channelStatus: new Map(),
  })
}

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
