import { ChatConnector, ChatServer } from './connectors/types.ts'
import { BanList, ClientTracker, memoryBanStore } from './api/clients.ts'

export const AppState = {
  connectors: new Map<ChatServer, ChatConnector>(),
  clients: new ClientTracker(),
  // main.ts swaps in the database-backed list
  bans: new BanList(memoryBanStore()),
}
