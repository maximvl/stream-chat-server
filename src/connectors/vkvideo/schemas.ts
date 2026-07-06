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

const ChatRole = type({
  id: 'string',
  name: 'string',
  largeUrl: 'string',
  priority: 'number',
})

const ChatBadge = type({
  id: 'string',
  name: 'string',
  largeUrl: 'string',
  achievement: type({
    name: 'string',
    type: 'string',
  }),
})

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
