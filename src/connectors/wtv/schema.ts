import { type } from 'arktype'

export const ProfileByNicknameResponse = type({
  profile: {
    userId: 'string',
    nickname: 'string',
  },
})

// streams-search-service.w.tv/api/v1/channels/<userId>; every user has a channel, imageUrl is '' without an avatar.
// A live one carries its stream with the viewers
export const ChannelResponse = type({
  channel: {
    'imageUrl?': 'string',
    'live?': 'boolean',
    'liveStream?': type({ 'viewers?': 'number' }).or('null'),
  },
})

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
