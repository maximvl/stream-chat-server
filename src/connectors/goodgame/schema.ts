import { type } from 'arktype'

// Every frame of wss://chat-1.goodgame.ru/chat2/ is {type, data}
export const WsEvent = type({
  type: 'string',
  data: 'unknown',
})

export const JoinData = type({
  channel_id: 'string',
  channel_streamer: { id: 'number' },
})

export const MessageData = type({
  channel_id: 'string',
  user_id: 'number',
  user_name: 'string',
  'user_rights?': 'number',
  'premiums?': 'string[]',
  'color?': 'string',
  'icon?': 'string',
  message_id: 'number',
  timestamp: 'number',
  text: 'string',
})

export const RemoveMessageData = type({
  channel_id: 'string',
  message_id: 'number | string',
})

// type 0 with duration 0 is an unban
export const UserBanData = type({
  channel_id: 'string',
  user_id: 'number | string',
  'type?': 'number',
  'duration?': 'number',
})

export const ChannelInfoResponse = type({
  id: 'number',
})

export const Smile = type({
  id: 'number',
  key: 'string',
  animated: 'number | boolean',
  images: {
    big: 'string',
    'gif?': 'string',
  },
})
