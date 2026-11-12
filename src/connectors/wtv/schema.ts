import { type } from 'arktype'

export const ProfileByNicknameResponse = type({
  profile: {
    userId: 'string',
    nickname: 'string',
  },
})

// streams-search-service.w.tv/api/v1/channels/<userId>; every user has a channel, imageUrl is '' without an avatar
export const ChannelResponse = type({ channel: { 'imageUrl?': 'string' } })

export const JoinChatResponse = type({
  token: 'string',
})

// nicknameColor is omitted by most senders. tags is usually present, including
// an empty list, but a missing list should not drop the message.
export const WsChatMsgData = type({
  messageId: 'string',
  content: 'string',
  sender: {
    userId: 'string',
    nickname: 'string',
    'tags?': 'string[]',
    'nicknameColor?': 'string',
  },
  createdAt: 'string',
})
