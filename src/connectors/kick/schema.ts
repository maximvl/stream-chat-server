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
  metadata: {
    level: 'number',
  },
})

export const WsChatBadge = type({
  type: 'string',
  text: 'string',
  count: 'number',
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

export const WsSubscribed = type({
  event: '"pusher_internal:subscription_succeeded"',
  data: 'string',
  channel: 'string',
})

export const ChannelInfoResponse = type({
  id: 'number',
  user_id: 'number',
  slug: 'string',
  is_banned: 'boolean',
  chatroom: type({
    id: 'number',
  }),
})
