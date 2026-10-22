import { myLog, sleep } from './utils.ts'
import { main_handler, withCors } from './api/handlers.ts'
import { AppState } from './app.ts'
import {
  DISABLED_CONNECTORS,
  LogLevel,
  WEBSERVER_HOST,
  WEBSERVER_PORT,
} from './config.ts'
import { TwitchConnector } from './connectors/twitch/twitch_ws.ts'
import { VkVideoConnector } from './connectors/vkvideo/vkvideo_ws.ts'
import { KickConnector } from './connectors/kick/kick_ws.ts'
import { WtvConnector } from './connectors/wtv/wtv_ws.ts'
import { ChatConnector } from './connectors/types.ts'

// One failing connector must neither stop the loop nor crash the process
async function connectorLoop(
  name: string,
  intervalMs: number,
  fn: (connector: ChatConnector) => unknown,
) {
  while (true) {
    for (const [server, connector] of AppState.connectors.entries()) {
      try {
        await fn(connector)
      } catch (error) {
        myLog(LogLevel.DEBUG, `[${server}] ${name} failed:`, error)
      }
    }
    await sleep(intervalMs)
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
  if (!DISABLED_CONNECTORS.includes('wtv')) {
    AppState.connectors.set('wtv', new WtvConnector())
  }

  connectorLoop('cleanup', 1000 * 60 * 5, (c) => c.cleanup())
  connectorLoop('tokenRefresh', 1000 * 60 * 5, (c) => c.refreshToken?.())
  connectorLoop('ping', 1000 * 60 * 1, (c) => c.sendPing?.())
  connectorLoop('poll', 1000 * 3, (c) => c.pollMessages?.())

  Deno.serve(
    { port: WEBSERVER_PORT, hostname: WEBSERVER_HOST },
    withCors(main_handler),
  )
}
