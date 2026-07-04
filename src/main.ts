import { twitchConnector } from './connector/twitch_ws.ts'
import { ChatChannel } from './connector/types.ts'

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

if (import.meta.main) {
  twitchConnector.connect('praden' as ChatChannel)
  Deno.serve(handler)
}
