import { type } from 'arktype'

export const ProfileByNicknameResponse = type({
  profile: {
    userId: 'string',
    nickname: 'string',
  },
})

export const JoinChatResponse = type({
  token: 'string',
})

export const WsEventEnvelope = type({
  Type: 'string',
  Id: 'string',
  RequestId: 'string',
  EventName: 'string',
  Attributes: {
    data: 'string',
  },
})

export const WsChatMsgData = type({
  messageId: 'string',
  content: 'string',
  sender: {
    userId: 'string',
    nickname: 'string',
    tags: 'string[]',
    nicknameColor: 'string',
  },
  createdAt: 'string',
})
