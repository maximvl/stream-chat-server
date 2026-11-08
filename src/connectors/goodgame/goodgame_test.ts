import { assertEquals } from '@std/assert'
import { ChannelName, ChatMessage, MessageId } from '../types.ts'
import { ChatEvent, subscribe } from '../chatEvents.ts'
import { toChatId } from '../utils.ts'
import { MessageStorage } from '../messageStorage.ts'
import { GoodgameConnector } from './goodgame_ws.ts'

const ROOM = '218490'

// Skips network setup
function connector(): GoodgameConnector {
  const c = new GoodgameConnector()
  c.reverseChannelsMap.set(ROOM as never, 'chan' as ChannelName)
  c.smiles.set(':znamya:', {
    id: '1',
    name: ':znamya:',
    imageUrl: 'https://goodgame.ru/images/anismiles/znamya-gif.gif',
  })
  return c
}

function frame(type: string, data: unknown): MessageEvent {
  return { data: JSON.stringify({ type, data }) } as MessageEvent
}

function message(userId: number, rights: number, text: string, id: number) {
  return frame('message', {
    channel_id: ROOM,
    user_id: userId,
    user_name: `u${userId}`,
    user_rights: rights,
    premiums: [ROOM],
    color: 'premium',
    icon: 'ggplus',
    message_id: id,
    timestamp: 1794046269,
    text,
  })
}

Deno.test('goodgame messages keep smiles, color and roles', () => {
  const c = connector()
  c.handleMessage(
    frame('success_join', { channel_id: ROOM, channel_streamer: { id: 7 } }),
  )
  c.handleMessage(message(7, 20, 'СССР:znamya: :unknown:', 1794046269405))
  c.handleMessage(message(8, 10, 'hi', 1794046269406))

  const [streamer, mod] = c.messages.get('chan' as ChannelName)!.messages
  assertEquals(c.getChannelStatus('chan')?.status, 'connected')
  assertEquals(streamer.id, '1794046269405')
  assertEquals(streamer.timestampMs, 1794046269000)
  assertEquals(streamer.emotes?.map((e) => e.name), [':znamya:'])
  assertEquals(streamer.user.goodgameFields, {
    color: '#bd70d7',
    colorName: 'premium',
    icon: 'ggplus',
    rights: 20,
    isStreamer: true,
    isModerator: true,
    subscriber: true,
  })
  assertEquals(mod.user.goodgameFields?.isStreamer, false)
  assertEquals(mod.user.goodgameFields?.isModerator, true)
})

Deno.test('goodgame moderation events reach live subscribers', () => {
  const c = connector()
  const storage = new MessageStorage()
  c.messages.set('chan' as ChannelName, storage)
  for (const [id, userId] of [['1', '7'], ['2', '8'], ['3', '7']]) {
    storage.messages.push(
      { id, user: { id: userId, displayName: 'u' } } as unknown as ChatMessage,
    )
  }

  const events: ChatEvent[] = []
  const unsubscribe = subscribe(
    toChatId('goodgame', 'chan' as ChannelName),
    (e) => events.push(e),
  )
  c.handleMessage(
    frame('remove_message', { channel_id: ROOM, message_id: 2 }),
  )
  c.handleMessage(
    frame('user_ban', { channel_id: ROOM, user_id: 7, type: 0, duration: 300 }),
  )
  // Unban
  c.handleMessage(
    frame('user_ban', { channel_id: ROOM, user_id: 8, type: 0, duration: 0 }),
  )
  unsubscribe()

  assertEquals(events, [
    { type: 'delete', messageIds: ['2'] as MessageId[] },
    { type: 'delete', messageIds: ['1', '3'] as MessageId[] },
  ])
})
