import { ChannelName, ChatConnection, ChatServer } from './types.ts'

export class ChatConnector {
  server: ChatServer
  websocket: WebSocket | null = null

  constructor(server: ChatServer) {
    this.server = server
  }

  connect(channel: ChannelName) {
    if (!this.websocket) {
      this.websocket = new WebSocket(`wss://${this.server}/${channel}`)
    }
  }
}
