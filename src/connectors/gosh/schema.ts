import { type } from 'arktype'

const MessageItem = type({
  ID: 'string',
  type: 'string',
  conversationID: 'string',
  conversationType: 'string',
  to: 'string',
  from: 'string',
  flow: 'string',
  time: 'number',
  sequence: 'number',
  status: 'string',
  isRevoked: 'boolean',
  isDeleted: 'boolean',
  isModified: 'boolean',
  payload: type({
    data: 'string',
    description: 'string',
  }),
})

export const MessageData = type({
  type: 'number',
  msg_id: 'number',
  live_id: 'string',
  occur_at: 'number',
  data: type({
    text: 'string',
  }),
  user: type({
    id: 'number',
    user_type: 'number',
    nickname: 'string',
    avatar: 'string',
    bot_type: 'number',
    is_channel_owner: 'boolean',
    name_color: 'string',
  }),
})

const MessagesResponseSuccess = type({
  code: '0',
  data: type({
    msgs: MessageItem.array(),
  }),
})

const MessagesResponseError = type({
  code: 'number.integer > 0',
  message: 'string',
})

export const MessagesResponse = MessagesResponseSuccess.or(
  MessagesResponseError,
)
