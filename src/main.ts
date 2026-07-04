import { twitchConnector } from './connectors/twitch/twitch_ws.ts'
import { ChannelName } from './connectors/types.ts'
import { messageStorage } from './storage/messageStorage.ts'
import { sleep } from './utils.ts'

export function handler(req: Request): Response {
  const url = new URL(req.url)

  if (url.pathname === '/api') {
    return Response.json({
      message: 'Hello, world!',
      time: new Date().toISOString(),
    })
  }

  return new Response('<h1>Welcome to Deno!</h1>', {
    headers: { 'content-type': 'text/html' },
  })
}

async function cleanupLoop() {
  while (true) {
    messageStorage.cleanupOldMessages()
    await sleep(1000 * 60 * 5) // 5 minutes
  }
}

if (import.meta.main) {
  cleanupLoop()
  twitchConnector.connect('segall' as ChannelName)
  Deno.serve(handler)
}
