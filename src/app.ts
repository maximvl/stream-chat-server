import { ChatConnector, ChatServer } from './connectors/types.ts'

export const AppState = {
  connectors: new Map<ChatServer, ChatConnector>(),
}
