import { sleep } from './utils.ts'
import { main_handler } from './api/handlers.ts'
import { connectors } from './connectors/utils.ts'

async function cleanupLoop() {
  while (true) {
    const connectorsArray = Array.from(connectors.values())
    for (const connector of connectorsArray) {
      connector.cleanup()
    }
    await sleep(1000 * 60 * 5) // 5 minutes
  }
}

if (import.meta.main) {
  cleanupLoop()
  Deno.serve(main_handler)
}
