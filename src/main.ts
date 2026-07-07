import { sleep } from './utils.ts'
import { main_handler, withCors } from './api/handlers.ts'
import { AppState } from './app.ts'
import {
  DISABLED_CONNECTORS,
  WEBSERVER_HOST,
  WEBSERVER_PORT,
} from './config.ts'
import { TwitchConnector } from './connectors/twitch/twitch_ws.ts'
import { VkVideoConnector } from './connectors/vkvideo/vkvideo_ws.ts'
import { KickConnector } from './connectors/kick/kick_ws.ts'

async function cleanupLoop() {
  while (true) {
    const connectorsArray = Array.from(AppState.connectors.values())
    for (const connector of connectorsArray) {
      connector.cleanup()
    }
    await sleep(1000 * 60 * 5) // 5 minutes
  }
}

async function tokenRefreshLoop() {
  while (true) {
    for (const [_server, connector] of AppState.connectors.entries()) {
      if (connector) {
        await connector.refreshToken?.()
      }
    }
    await sleep(1000 * 60 * 5) // 5 minutes
  }
}

async function pingLoop() {
  while (true) {
    for (const [_server, connector] of AppState.connectors.entries()) {
      if (connector) {
        await connector.sendPing?.()
      }
    }
    await sleep(1000 * 60 * 1) // 1 minute
  }
}

if (import.meta.main) {
  if (!DISABLED_CONNECTORS.includes('twitch')) {
    AppState.connectors.set('twitch', new TwitchConnector())
  }
  if (!DISABLED_CONNECTORS.includes('vkvideo')) {
    AppState.connectors.set('vkvideo', new VkVideoConnector())
  }
  if (!DISABLED_CONNECTORS.includes('kick')) {
    AppState.connectors.set('kick', new KickConnector())
  }

  cleanupLoop()
  tokenRefreshLoop()
  pingLoop()
  Deno.serve(
    { port: WEBSERVER_PORT, hostname: WEBSERVER_HOST },
    withCors(main_handler),
  )
}
