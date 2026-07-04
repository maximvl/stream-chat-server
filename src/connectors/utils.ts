import { twitchConnector } from './twitch/twitch_ws.ts'
import { ChannelName, ChatId, ChatServer } from './types.ts'

export function toChatId(server: string, channel: string): ChatId {
  return `${server}/${channel}` as ChatId
}

export function fromChatId(
  chatId: ChatId,
): { server: ChatServer; channel: ChannelName } {
  const [server, channel] = chatId.split('/')
  return { server: server as ChatServer, channel: channel as ChannelName }
}

export function getConnector(server: ChatServer) {
  switch (server) {
    case 'twitch':
      return twitchConnector
    case 'vkvideo':
      return null
    case 'kick':
      return null
    default: {
      const _exhaustive: never = server
      throw new Error(`Unknown chat server: ${server}`)
    }
  }
}
