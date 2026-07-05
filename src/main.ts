import { sleep } from './utils.ts'
import { main_handler } from './api/handlers.ts'
import { AppState } from './app.ts'
import { WEBSERVER_HOST, WEBSERVER_PORT } from './config.ts'

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
        connector.cleanup()
        await connector.maybeRefreshToken()
      }
    }
    await sleep(1000 * 60 * 5) // 5 minutes
  }
}

if (import.meta.main) {
  cleanupLoop()
  tokenRefreshLoop()
  Deno.serve({ port: WEBSERVER_PORT, hostname: WEBSERVER_HOST }, main_handler)
}
