import { type } from 'arktype'

const Thumbnails = type({ thumbnails: type({ url: 'string' }).array() })

// One piece of a message: plain text or an emoji. Standard emojis have the
// character itself as emojiId; channel and YouTube emojis are isCustomEmoji.
const Run = type({
  'text?': 'string',
  'emoji?': {
    emojiId: 'string',
    'shortcuts?': 'string[]',
    'isCustomEmoji?': 'boolean',
    image: Thumbnails,
  },
})

// Owner, moderator and verified badges are icons; a member badge is the channel's own picture
const AuthorBadge = type({
  liveChatAuthorBadgeRenderer: {
    'icon?': { iconType: 'string' },
    'customThumbnail?': Thumbnails,
    tooltip: 'string',
  },
})

export const TextMessage = type({
  id: 'string',
  timestampUsec: 'string',
  authorExternalChannelId: 'string',
  'authorName?': { simpleText: 'string' },
  // Smallest first (32 and 64 px)
  'authorPhoto?': Thumbnails,
  'message?': { runs: Run.array() },
  'authorBadges?': AuthorBadge.array(),
  // Super Chat amount, e.g. "$5.00"
  'purchaseAmountText?': { simpleText: 'string' },
})

export const ChatAction = type({
  'addChatItemAction?': {
    item: {
      'liveChatTextMessageRenderer?': TextMessage,
      'liveChatPaidMessageRenderer?': TextMessage,
    },
  },
  'removeChatItemAction?': { targetItemId: 'string' },
  'markChatItemAsDeletedAction?': { targetItemId: 'string' },
  'removeChatItemByAuthorAction?': { externalChannelId: 'string' },
  'markChatItemsByAuthorAsDeletedAction?': { externalChannelId: 'string' },
})

const Continuation = type({ continuation: 'string', 'timeoutMs?': 'number' })

export const LiveChatResponse = type({
  'continuationContents?': {
    liveChatContinuation: {
      'continuations?': type({
        'invalidationContinuationData?': Continuation,
        'timedContinuationData?': Continuation,
        'reloadContinuationData?': Continuation,
      }).array(),
      'actions?': 'unknown[]',
    },
  },
})

// ytInitialData of youtube.com/live_chat?v=…; absent liveChatRenderer means the chat is off
export const ChatPageData = type({
  contents: {
    'liveChatRenderer?': {
      'continuations?': type({
        'invalidationContinuationData?': Continuation,
        'timedContinuationData?': Continuation,
      }).array(),
      'header?': {
        liveChatHeaderRenderer: {
          'viewSelector?': {
            sortFilterSubMenuRenderer: {
              // "Top chat", then "Live chat" with all messages
              subMenuItems: type({
                continuation: { reloadContinuationData: Continuation },
              }).array(),
            },
          },
        },
      },
    },
  },
})
