import { type } from 'arktype'

export const AppConfig = type({
  websocket: type({
    token: 'string',
  }),
  hosts: type({
    websocket: 'string',
  }),
})

export const ChannelInfoResponse = type({
  data: type({
    owner: type({
      id: 'number',
      name: 'string',
      nick: 'string',
    }),
  }),
})

export const WsErrorMessage = type({
  id: 'number',
  error: type({
    code: 'number',
    message: 'string',
  }),
})

export const WsSubscribeMessage = type({
  id: 'number',
})

export const ChatRole = type({
  id: 'string',
  name: 'string',
  largeUrl: 'string',
  priority: 'number',
})

export type ChatRole = typeof ChatRole.infer

export const ChatBadge = type({
  id: 'string',
  name: 'string',
  largeUrl: 'string',
  achievement: type({
    name: 'string',
    type: 'string',
  }),
})

export type ChatBadge = typeof ChatBadge.infer

const MsgAuthor = type({
  id: 'number',
  displayName: 'string',
  nickColor: 'number',
  isChatModerator: 'boolean',
  isChannelModerator: 'boolean',
  roles: ChatRole.array(),
  badges: ChatBadge.array(),
})

const ContentDataMention = type({
  id: 'number',
  type: '"mention"',
  displayName: 'string',
  nickColor: 'number',
})

const ContentDataText = type({
  type: '"text"',
  content: 'string',
})

const ContentIgnore = type({})

const ContentData = ContentDataMention.or(ContentDataText).or(ContentIgnore)

export const WsChatMessage = type({
  push: type({
    channel: 'string',
    pub: type({
      data: type({
        type: '"message"',
        data: type({
          id: 'number',
          createdAt: 'number',
          author: MsgAuthor,
          data: ContentData.array(),
        }),
      }),
    }),
  }),
})

export const VkColorsMap: Record<number, string> = {
  0: '#D66E34',
  1: '#B8AAFF',
  2: '#1D90FF',
  3: '#9961F9',
  4: '#59A840',
  5: '#E73629',
  6: '#DE6489',
  7: '#20BBA1',
  8: '#F8B301',
  9: '#0099BB',
  10: '#7BBEFF',
  11: '#E542FF',
  12: '#A36C59',
  13: '#8BA259',
  14: '#00A9FF',
  15: '#A20BFF',
}
