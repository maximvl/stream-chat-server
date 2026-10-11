import { assert, assertEquals } from '@std/assert'
import { ChannelName, ChatMessage } from '../types.ts'
import { WtvChatConnection } from './connection.ts'
import { sleep } from '../../utils.ts'

function connection(
  onMessage: (msg: ChatMessage) => void = () => {},
  onSilence: () => void = () => {},
  silenceTimeoutMs = 30_000,
): WtvChatConnection {
  return new WtvChatConnection(
    'storm_q' as ChannelName,
    onMessage,
    () => {},
    () => {},
    onSilence,
    silenceTimeoutMs,
  )
}

function frame(payload: unknown): MessageEvent {
  return { data: JSON.stringify(payload) } as MessageEvent
}

const chatWithoutColor = {
  Type: 'EVENT',
  EventName: 'MESSAGE',
  Attributes: {
    data: JSON.stringify({
      messageId: 'm1',
      content: 'hello',
      sender: { userId: 'u1', nickname: 'bob', tags: [] },
      createdAt: '2026-10-11T22:37:48.921Z',
    }),
  },
}

Deno.test('w.tv keeps messages that omit nicknameColor', () => {
  const messages: ChatMessage[] = []
  const conn = connection((msg) => messages.push(msg))
  conn.handleMessage(frame(chatWithoutColor))
  assertEquals(messages.length, 1)
  assertEquals(messages[0].text, 'hello')
  assertEquals(messages[0].user.displayName, 'bob')
  assertEquals(messages[0].user.wtvFields?.nicknameColor, '')
  assertEquals(messages[0].user.wtvFields?.tags, [])
})

Deno.test('w.tv keeps nicknameColor when the sender has one', () => {
  const messages: ChatMessage[] = []
  const conn = connection((msg) => messages.push(msg))
  const withColor = structuredClone(chatWithoutColor)
  const inner = JSON.parse(withColor.Attributes.data)
  inner.sender.nicknameColor = 'A9FF26'
  withColor.Attributes.data = JSON.stringify(inner)
  conn.handleMessage(frame(withColor))
  assertEquals(messages[0].user.wtvFields?.nicknameColor, 'A9FF26')
})

Deno.test('w.tv accepts a native IVS MESSAGE frame', () => {
  const messages: ChatMessage[] = []
  const conn = connection((msg) => messages.push(msg))
  conn.handleMessage(frame({
    Type: 'MESSAGE',
    Id: 'native-1',
    Content: 'legacy',
    SendTime: '2026-10-11T22:37:48.921Z',
    Sender: { UserId: 'u2' },
    Attributes: { nickname: 'ann' },
  }))
  assertEquals(messages.length, 1)
  assertEquals(messages[0].id, 'native-1')
  assertEquals(messages[0].text, 'legacy')
  assertEquals(messages[0].user.displayName, 'ann')
  assertEquals(messages[0].user.wtvFields?.nicknameColor, '')
})

Deno.test('w.tv ping does not write to the socket', async () => {
  const conn = connection()
  const sent: string[] = []
  conn.websocket = {
    send: (data: string) => {
      sent.push(data)
    },
    close: () => {},
    readyState: WebSocket.OPEN,
  } as unknown as WebSocket

  conn.handleMessage(frame({
    Type: 'EVENT',
    Id: '1',
    RequestId: '2',
    EventName: 'PING',
  }))
  conn.handleMessage(frame({
    Type: 'EVENT',
    Id: '3',
    RequestId: '4',
    EventName: 'aws:PING',
    Attributes: { data: '{}' },
  }))
  await conn.sendPing()
  assertEquals(sent, [])
})

Deno.test('w.tv silence timer asks for a reconnect', async () => {
  let silenced = false
  const conn = connection(() => {}, () => {
    silenced = true
  }, 40)
  conn.noteActivity()
  await sleep(20)
  assert(!silenced)
  conn.noteActivity()
  await sleep(20)
  assert(!silenced)
  await sleep(50)
  assert(silenced)
})
