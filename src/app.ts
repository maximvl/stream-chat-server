import { TwitchConnector } from './connectors/twitch/twitch_ws.ts'
import { ChatConnector, ChatServer } from './connectors/types.ts'
import { VkVideoConnector } from './connectors/vkvideo/vkvideo_ws.ts'

export const AppState = {
  connectors: new Map<ChatServer, ChatConnector>(),
}

AppState.connectors.set('twitch', new TwitchConnector())
AppState.connectors.set('vkvideo', new VkVideoConnector())
