import { TwitchConnector } from './twitch/twitch_ws.ts'
import { ChannelName, ChatConnector, ChatId, ChatServer } from './types.ts'

export function toChatId(server: string, channel: string): ChatId {
  return `${server}/${channel}` as ChatId
}

export function fromChatId(
  chatId: ChatId,
): { server: ChatServer; channel: ChannelName } {
  const [server, channel] = chatId.split('/')
  return { server: server as ChatServer, channel: channel as ChannelName }
}

export const connectors: Map<ChatServer, ChatConnector> = new Map()

connectors.set('twitch', new TwitchConnector())
