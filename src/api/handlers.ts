import { AppState } from '../app.ts'
import {
  CORS_HOSTS,
  DEFAULT_LAST_MESSAGES_LIMIT,
  MAX_LAST_MESSAGES_LIMIT,
  MAX_MESSAGES_RESPONSE,
} from '../config.ts'
import { ChannelName } from '../connectors/types.ts'
import { subscribe } from '../connectors/chatEvents.ts'
import { normalizeChannel, toChatId } from '../connectors/utils.ts'
import {
  ChatLastMessagesRequest,
  ChatMessagesRequest,
  ChatStatusRequest,
  ConnectRequest,
} from './schema.ts'
import { type } from 'arktype'

export function withCors(
  handler: (req: Request) => Promise<Response>,
): (req: Request) => Promise<Response> {
  return async (req) => {
    const origin = req.headers.get('origin') ?? ''
    const allowedHost = CORS_HOSTS.includes(origin)

    const corsHeaders = {
      'Access-Control-Allow-Origin': origin,
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    }

    // Handle preflight requests
    if (req.method === 'OPTIONS') {
      return new Response(null, {
        headers: allowedHost ? corsHeaders : {},
      })
    }

    const response = await handler(req)

    const headers = new Headers(response.headers)
    if (allowedHost) {
      Object.entries(corsHeaders).forEach(([key, value]) => {
        headers.set(key, value)
      })
    }

    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    })
  }
}

export function main_handler(req: Request): Promise<Response> {
  const url = new URL(req.url)

  const routePath = routes[url.pathname]
  if (!routePath) {
    return Promise.resolve(new Response('Not found', { status: 404 }))
  }

  const routeMethod = routePath[req.method]
  if (!routeMethod) {
    return Promise.resolve(new Response('Method not allowed', { status: 405 }))
  }

  return routeMethod(req)
}

const routes: Record<
  string,
  Record<string, (req: Request) => Promise<Response>>
> = {
  '/api/chat_connect': {
    POST: chat_connect,
  },
  '/api/chat_messages': {
    GET: chat_messages,
  },
  '/api/chat_last_messages': {
    GET: chat_last_messages,
  },
  '/api/chat_stream': {
    GET: chat_stream,
  },
  '/api/status': {
    GET: app_status,
  },
}

const STREAM_KEEPALIVE_MS = 20_000

// Server-Sent Events: pushes {type: 'message' | 'delete' | 'clear'} events of one chat
function chat_stream(req: Request): Promise<Response> {
  const url = new URL(req.url)
  const params = ChatStatusRequest({
    server: url.searchParams.get('server'),
    channel: url.searchParams.get('channel'),
  })
  if (params instanceof type.errors) {
    return Promise.resolve(
      new Response(JSON.stringify({ errors: params.issues }), {
        status: 400,
        headers: { 'content-type': 'application/json' },
      }),
    )
  }

  const connector = AppState.connectors.get(params.server)
  if (!connector) {
    return Promise.resolve(
      new Response(JSON.stringify({ errors: ['Unsupported chat server'] }), {
        status: 400,
        headers: { 'content-type': 'application/json' },
      }),
    )
  }

  const channel = normalizeChannel(params.channel)
  const encoder = new TextEncoder()
  let cleanup = () => {}

  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      const send = (chunk: string) => {
        try {
          controller.enqueue(encoder.encode(chunk))
        } catch {
          cleanup()
        }
      }
      const unsubscribe = subscribe(
        toChatId(params.server, channel),
        (event) => send(`data: ${JSON.stringify(event)}\n\n`),
      )
      // (Re)joins the channel if its socket dropped and marks it as read so
      // the inactivity cleanup doesn't disconnect a chat that is on screen.
      // The ping is a named event (not a comment) so clients can detect a
      // stream that silently died and reconnect.
      const keepAlive = () => {
        connector.connect(channel).catch(() => {})
        connector.getMessages(channel, Infinity)
        send('event: ping\ndata: {}\n\n')
      }
      // EventSource waits this long before reconnecting after a drop
      send('retry: 3000\n\n')
      keepAlive()
      const timer = setInterval(keepAlive, STREAM_KEEPALIVE_MS)
      cleanup = () => {
        clearInterval(timer)
        unsubscribe()
      }
    },
    cancel() {
      cleanup()
    },
  })

  return Promise.resolve(
    new Response(body, {
      headers: {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        // nginx buffers proxied responses by default, which stalls SSE
        'x-accel-buffering': 'no',
      },
    }),
  )
}

async function chat_connect(req: Request): Promise<Response> {
  const bodyText = await req.text()
  let bodyJson
  try {
    bodyJson = JSON.parse(bodyText || '{}')
  } catch {
    return Promise.resolve(
      new Response(JSON.stringify({ errors: ['Invalid JSON'] }), {
        status: 400,
        headers: { 'content-type': 'application/json' },
      }),
    )
  }

  const body = ConnectRequest(bodyJson)
  if (body instanceof type.errors) {
    return Promise.resolve(
      new Response(JSON.stringify({ errors: body.issues }), {
        status: 400,
        headers: { 'content-type': 'application/json' },
      }),
    )
  }

  const connector = AppState.connectors.get(body.server)
  if (!connector) {
    return Promise.resolve(
      new Response(JSON.stringify({ errors: ['Unsupported chat server'] }), {
        status: 400,
        headers: { 'content-type': 'application/json' },
      }),
    )
  }

  await connector.connect(body.channel as ChannelName)
  const status = connector.getChannelStatus(body.channel as ChannelName)

  return Promise.resolve(
    Response.json({
      status,
    }),
  )
}

function chat_messages(req: Request): Promise<Response> {
  const url = new URL(req.url)
  const params = ChatMessagesRequest({
    server: url.searchParams.get('server'),
    channel: url.searchParams.get('channel'),
    tsFrom: url.searchParams.get('tsFrom'),
  })
  if (params instanceof type.errors) {
    return Promise.resolve(
      new Response(JSON.stringify({ errors: params.issues }), {
        status: 400,
        headers: { 'content-type': 'application/json' },
      }),
    )
  }

  const connector = AppState.connectors.get(params.server)
  if (!connector) {
    return Promise.resolve(
      new Response(JSON.stringify({ errors: ['Unsupported chat server'] }), {
        status: 400,
        headers: { 'content-type': 'application/json' },
      }),
    )
  }

  const status = connector.getChannelStatus(params.channel as ChannelName)

  const messages = connector.getMessages(
    params.channel as ChannelName,
    params.tsFrom,
  )

  const limited = messages.slice(0, MAX_MESSAGES_RESPONSE)

  return Promise.resolve(
    Response.json({
      status,
      messages: limited,
    }),
  )
}

function chat_last_messages(req: Request): Promise<Response> {
  const url = new URL(req.url)
  const limitParam = url.searchParams.get('limit')
  const params = ChatLastMessagesRequest({
    server: url.searchParams.get('server'),
    channel: url.searchParams.get('channel'),
    ...(limitParam !== null ? { limit: limitParam } : {}),
  })
  if (params instanceof type.errors) {
    return Promise.resolve(
      new Response(JSON.stringify({ errors: params.issues }), {
        status: 400,
        headers: { 'content-type': 'application/json' },
      }),
    )
  }

  const connector = AppState.connectors.get(params.server)
  if (!connector) {
    return Promise.resolve(
      new Response(JSON.stringify({ errors: ['Unsupported chat server'] }), {
        status: 400,
        headers: { 'content-type': 'application/json' },
      }),
    )
  }

  const status = connector.getChannelStatus(params.channel as ChannelName)

  const limit = Math.min(
    params.limit ?? DEFAULT_LAST_MESSAGES_LIMIT,
    MAX_LAST_MESSAGES_LIMIT,
  )

  const messages = connector.getLastMessages(
    params.channel as ChannelName,
    limit,
  )

  return Promise.resolve(
    Response.json({
      status,
      messages,
    }),
  )
}

async function app_status(_req: Request): Promise<Response> {
  const connectors = Array.from(AppState.connectors.values())
  const statuses = await Promise.all(
    connectors.map((connector) => connector.getStatus()),
  )

  return Response.json({
    connectors: statuses,
  })
}
