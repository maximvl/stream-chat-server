import { assertEquals } from '@std/assert'
import { ChannelName, ChatMessage, MessageId } from '../types.ts'
import { ChatEvent, subscribe } from '../chatEvents.ts'
import { toChatId } from '../utils.ts'
import { MessageStorage } from '../messageStorage.ts'
import {
  liveUrl,
  parseChatPage,
  parseChatResponse,
  parseLivePage,
  YoutubeConnector,
} from './youtube_chat.ts'
import { YoutubeRemoteConnector } from './youtube_remote.ts'

// A get_live_chat response with real actions; authors and texts are replaced
const response = JSON.parse(
  Deno.readTextFileSync(
    new URL('./testdata/get_live_chat.json', import.meta.url),
  ),
)

const CHANNEL = '@chan' as ChannelName

function connector(): YoutubeConnector {
  const c = new YoutubeConnector()
  c.messages.set(CHANNEL, new MessageStorage())
  return c
}

Deno.test('youtube live and chat pages give the video and the all-messages feed', () => {
  assertEquals(liveUrl('@LofiGirl'), 'https://www.youtube.com/@LofiGirl/live')
  assertEquals(liveUrl('lofigirl'), 'https://www.youtube.com/@lofigirl/live')
  assertEquals(
    liveUrl('UCSJ4gkVC6NrvII8umztf0Ow'),
    'https://www.youtube.com/channel/UCSJ4gkVC6NrvII8umztf0Ow/live',
  )

  const watch =
    '<script>var ytInitialPlayerResponse = {"videoDetails":{"videoId":"4t4AQ15yj1M","isLive":true},' +
    '"microformat":{"playerMicroformatRenderer":{"liveBroadcastDetails":{"isLiveNow":true}}}};</script>'
  assertEquals(parseLivePage(watch), '4t4AQ15yj1M')
  assertEquals(
    parseLivePage(watch.replace('"isLive":true', '"isUpcoming":true')),
    null,
  )
  assertEquals(
    parseLivePage(
      '<link rel="canonical" href="https://www.youtube.com/channel/UCx">',
    ),
    null,
  )

  const data = {
    contents: {
      liveChatRenderer: {
        continuations: [{
          invalidationContinuationData: {
            continuation: 'top',
            timeoutMs: 10000,
          },
        }],
        header: {
          liveChatHeaderRenderer: {
            viewSelector: {
              sortFilterSubMenuRenderer: {
                subMenuItems: [
                  {
                    title: 'Top chat',
                    continuation: {
                      reloadContinuationData: { continuation: 'top' },
                    },
                  },
                  {
                    title: 'Live chat',
                    continuation: {
                      reloadContinuationData: { continuation: 'all' },
                    },
                  },
                ],
              },
            },
          },
        },
      },
    },
  }
  const chat = (d: unknown) =>
    `<script>ytcfg.set({"INNERTUBE_API_KEY":"key","INNERTUBE_CONTEXT_CLIENT_VERSION":"2.2026"});</script>` +
    `<script>window["ytInitialData"] = ${JSON.stringify(d)};</script>`
  assertEquals(parseChatPage(chat(data)), {
    apiKey: 'key',
    clientVersion: '2.2026',
    continuation: 'all',
  })
  // Chat turned off for the stream
  assertEquals(parseChatPage(chat({ contents: { messageRenderer: {} } })), null)
})

Deno.test('youtube poll keeps text, channel emojis and roles', () => {
  const result = parseChatResponse(response)!
  // YouTube's 10 s is cut down for overlays
  assertEquals(result.continuation, 'next-continuation')
  assertEquals(result.timeoutMs, 5000)
  assertEquals(
    parseChatResponse({ continuationContents: { liveChatContinuation: {} } }),
    null,
  )

  const c = connector()
  c.handleActions(CHANNEL, result.actions)
  // Placeholders (held for review) and gifts are not messages
  const [viewer, member, moder, owner, verified, ...rest] =
    c.messages.get(CHANNEL)!.messages
  assertEquals(rest, [])

  assertEquals(viewer.text, 'hello wow❤❌:hand-pink-waving:')
  assertEquals(viewer.emotes?.map((e) => e.name), [':hand-pink-waving:'])
  assertEquals(
    viewer.emotes?.[0].imageUrl.startsWith('https://yt3.ggpht.com/'),
    true,
  )
  assertEquals(viewer.user.id, 'UCviewerxxxxxxxxxxxxxxxx')
  assertEquals(viewer.user.displayName, 'viewer')
  assertEquals(viewer.server, 'youtube')
  assertEquals(viewer.channel, CHANNEL)
  assertEquals(viewer.timestampMs > 1_700_000_000_000, true)
  assertEquals(viewer.user.youtubeFields, {
    color: '',
    isOwner: false,
    isModerator: false,
    isMember: false,
    isVerified: false,
    badges: [],
  })

  assertEquals(member.user.youtubeFields?.isMember, true)
  assertEquals(member.user.youtubeFields?.color, '#2ba640')
  assertEquals(member.user.youtubeFields?.badges[0].title, 'Member (1 month)')

  // The same emoji thrice is one emote
  assertEquals(moder.emotes?.map((e) => e.name), [':face-blue-smiling:'])
  assertEquals(moder.user.youtubeFields?.isModerator, true)
  assertEquals(moder.user.youtubeFields?.color, '#5e84f1')

  assertEquals(owner.user.youtubeFields?.isOwner, true)
  assertEquals(owner.user.youtubeFields?.isVerified, true)
  assertEquals(owner.user.youtubeFields?.color, '#ffd600')

  assertEquals(verified.user.youtubeFields?.isModerator, false)
  assertEquals(verified.user.youtubeFields?.isVerified, true)

  // Replayed history after a reconnect is not added twice
  c.handleActions(CHANNEL, result.actions)
  assertEquals(c.messages.get(CHANNEL)!.count(), 5)
})

Deno.test('youtube super chats are messages with the amount', () => {
  const c = connector()
  c.handleActions(CHANNEL, [{
    addChatItemAction: {
      item: {
        liveChatPaidMessageRenderer: {
          id: 'paid1',
          timestampUsec: '1794117000000000',
          authorExternalChannelId: 'UCpayerxxxxxxxxxxxxxxxxx',
          authorName: { simpleText: '@payer' },
          purchaseAmountText: { simpleText: '$5.00' },
          message: { runs: [{ text: 'thanks' }] },
        },
      },
    },
  }])
  const [paid] = c.messages.get(CHANNEL)!.messages
  assertEquals(paid.text, '$5.00 thanks')
  assertEquals(paid.timestampMs, 1794117000000)
})

Deno.test('youtube moderation events reach live subscribers', () => {
  const c = connector()
  const storage = c.messages.get(CHANNEL)!
  for (const [id, userId] of [['1', 'UCa'], ['2', 'UCb'], ['3', 'UCa']]) {
    storage.messages.push(
      { id, user: { id: userId, displayName: 'u' } } as unknown as ChatMessage,
    )
  }

  const events: ChatEvent[] = []
  const unsubscribe = subscribe(
    toChatId('youtube', CHANNEL),
    (e) => events.push(e),
  )
  c.handleActions(CHANNEL, [
    { removeChatItemAction: { targetItemId: '2' } },
    {
      markChatItemAsDeletedAction: {
        targetItemId: '1',
        deletedStateMessage: {},
      },
    },
    { removeChatItemByAuthorAction: { externalChannelId: 'UCa' } },
    { markChatItemsByAuthorAsDeletedAction: { externalChannelId: 'UCnobody' } },
  ])
  unsubscribe()

  assertEquals(events, [
    { type: 'delete', messageIds: ['2'] as MessageId[] },
    { type: 'delete', messageIds: ['1'] as MessageId[] },
    { type: 'delete', messageIds: ['1', '3'] as MessageId[] },
  ])
})

Deno.test('youtube remote connector stores node events once and passes deletes on', () => {
  const c = new YoutubeRemoteConnector('https://node.example/', '')
  assertEquals(c.nodeUrl, 'https://node.example')
  c.messages.set(CHANNEL, new MessageStorage())

  const events: ChatEvent[] = []
  const unsubscribe = subscribe(
    toChatId('youtube', CHANNEL),
    (e) => events.push(e),
  )
  const message = {
    id: 'm1',
    channel: CHANNEL,
    server: 'youtube',
    text: 'hi',
  } as unknown as ChatMessage
  c.handleEvent(CHANNEL, { type: 'message', message })
  c.handleEvent(CHANNEL, { type: 'message', message })
  c.handleEvent(CHANNEL, { type: 'delete', messageIds: ['m1' as MessageId] })
  unsubscribe()

  assertEquals(c.messages.get(CHANNEL)!.messages.map((m) => m.id), ['m1'])
  assertEquals(events, [
    { type: 'message', message },
    { type: 'delete', messageIds: ['m1'] as MessageId[] },
  ])
})
