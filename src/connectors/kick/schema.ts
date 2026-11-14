import { type } from 'arktype'

export const WsPong = type({
  event: '"pusher:pong"',
  data: 'string',
})

export const WsChatMsg = type({
  event: '"App\\Events\\ChatMessageEvent"',
  data: 'string',
  channel: 'string',
})

export const WsChatBadgeV2 = type({
  name: 'string',
  badge_type: 'string',
  image_url: 'string',
  selected: 'boolean',
  sort_order: 'number',
  'metadata?': {
    'level?': 'number',
  },
})

export const WsChatBadge = type({
  type: 'string',
  text: 'string',
  'count?': 'number',
  sort_order: 'number',
})

export const WsChatMsgData = type({
  id: 'string',
  chatroom_id: 'number',
  content: 'string',
  type: '"message" | "reply"',
  created_at: 'string',
  sender: {
    id: 'number',
    username: 'string',
    slug: 'string',
    identity: {
      color: 'string',
      badges: WsChatBadge.array(),
      badges_v2: WsChatBadgeV2.array(),
    },
  },
})

// Moderation events arrive on the same chatroom channel as messages
export const WsModerationEvent = type({
  event:
    '"App\\Events\\MessageDeletedEvent" | "App\\Events\\UserBannedEvent" | "App\\Events\\ChatroomClearEvent"',
  data: 'string',
  channel: 'string',
})

// A channel hosting (raiding) this one; arrives on the same chatroom channel as messages
export const WsHostEvent = type({
  event: '"App\\Events\\StreamHostEvent"',
  data: 'string',
  channel: 'string',
})

export const StreamHostData = type({
  host_username: 'string',
  number_viewers: 'number',
  'optional_message?': 'string | null',
})

// Pinned message and poll changes; also on the chatroom channel
export const WsPinPollEvent = type({
  event:
    '"App\\Events\\PinnedMessageCreatedEvent" | "App\\Events\\PinnedMessageDeletedEvent" | "App\\Events\\PollUpdateEvent" | "App\\Events\\PollDeleteEvent"',
  data: 'string',
  channel: 'string',
})

// PinnedMessageCreatedEvent, and pinned_message of /api/v2/channels/<channel>/chatroom
export const PinnedMessageData = type({
  message: {
    id: 'string',
    content: 'string',
    sender: {
      id: 'number',
      username: 'string',
      'identity?': { 'color?': 'string' },
    },
  },
  // Seconds; absent or 0 when it stays until unpinned
  'duration?': 'number | string | null',
})

// PollUpdateEvent's poll, and data (or data.poll) of /api/v2/channels/<channel>/polls
export const PollData = type({
  title: 'string',
  options: type({ id: 'number', label: 'string', votes: 'number' }).array(),
  // Seconds left; 0 once it ended and shows its results
  remaining: 'number',
  'created_at?': 'string',
})

export const ChatroomResponse = type({ 'pinned_message?': 'unknown' })
export const PollResponse = type({ 'data?': 'unknown' })

export const MessageDeletedData = type({ message: { id: 'string' } })
export const UserBannedData = type({ user: { id: 'number | string' } })

export const WsSubscribed = type({
  event: '"pusher_internal:subscription_succeeded"',
  data: 'string',
  channel: 'string',
})

// kick.com/api/v2/channels/<any channel>/users/<username>
export const UserInChannelResponse = type({ 'profile_pic?': 'string | null' })

export const ChannelInfoResponse = type({
  id: 'number',
  user_id: 'number',
  slug: 'string',
  is_banned: 'boolean',
  chatroom: type({
    id: 'number',
  }),
})

export const RealtimeConnectionResponse = type({
  data: {
    connections: type({
      provider: 'string',
      credentials: {
        'app_key?': 'string',
        'cluster?': 'string',
      },
    }).array(),
  },
})
