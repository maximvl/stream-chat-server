import { assertEquals } from '@std/assert'
import { ChannelName, MessageId } from '../types.ts'
import { ChatEvent, subscribe } from '../chatEvents.ts'
import { toChatId } from '../utils.ts'
import { MessageStorage } from '../messageStorage.ts'
import { KickConnector } from './kick_ws.ts'

const ROOM = 'chatrooms.42.v2'

// Skips the constructor and network setup
function connector(): KickConnector {
  return Object.assign(Object.create(KickConnector.prototype), {
    reverseChannelsMap: new Map([[ROOM, 'chan']]),
    messages: new Map(),
    channelStatus: new Map(),
  })
}

function frame(event: string, data: unknown): MessageEvent {
  return {
    data: JSON.stringify({ event, data: JSON.stringify(data), channel: ROOM }),
  } as MessageEvent
}

Deno.test('kick moderation events reach live subscribers', () => {
  const c = connector()
  const storage = new MessageStorage()
  c.messages.set('chan' as ChannelName, storage)
  for (const [id, userId] of [['a', '7'], ['b', '8'], ['c', '7']]) {
    storage.messages.push({
      id: id as MessageId,
      user: { id: userId, displayName: 'u' },
      text: 'x',
      timestampMs: 1,
      server: 'kick',
      channel: 'chan',
    } as never)
  }

  const events: ChatEvent[] = []
  const unsubscribe = subscribe(
    toChatId('kick', 'chan' as ChannelName),
    (e) => events.push(e),
  )
  c.handleMessage(
    frame('App\\Events\\MessageDeletedEvent', {
      id: 'e1',
      message: { id: 'b' },
    }),
  )
  c.handleMessage(
    frame('App\\Events\\UserBannedEvent', { id: 'e2', user: { id: 7 } }),
  )
  c.handleMessage(frame('App\\Events\\ChatroomClearEvent', { id: 'e3' }))
  unsubscribe()

  assertEquals(events, [
    { type: 'delete', messageIds: ['b'] as MessageId[] },
    { type: 'delete', messageIds: ['a', 'c'] as MessageId[] },
    { type: 'clear' },
  ])
  // History served to pollers is untouched
  assertEquals(storage.messages.length, 3)
})

Deno.test('kick host event becomes a raid notice', () => {
  const c = connector()
  c.handleMessage(
    frame('App\\Events\\StreamHostEvent', {
      chatroom_id: 42,
      optional_message: '',
      number_viewers: 15,
      host_username: 'Eve',
    }),
  )
  const [msg] = c.messages.get('chan' as ChannelName)!.messages
  assertEquals(msg.server, 'kick')
  assertEquals(msg.user.displayName, 'Eve')
  assertEquals(msg.notice?.kind, 'raid')
  assertEquals(msg.notice?.params, { displayName: 'Eve', viewerCount: '15' })
})
