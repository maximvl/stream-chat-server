import { AppState } from '../app.ts'
import {
  API_TOKEN,
  CORS_HOSTS,
  DEFAULT_LAST_MESSAGES_LIMIT,
  LogLevel,
  MAX_LAST_MESSAGES_LIMIT,
  MAX_MESSAGES_RESPONSE,
  TRUSTED_PROXIES,
} from '../config.ts'
import { ChannelName, ChatMessage } from '../connectors/types.ts'
import { chatState, subscribe } from '../connectors/chatEvents.ts'
import { normalizeChannel, toChatId } from '../connectors/utils.ts'
import {
  AvatarsRequest,
  ChatLastMessagesRequest,
  ChatMessagesRequest,
  ChatStatusRequest,
  ConnectRequest,
} from './schema.ts'
import { type } from 'arktype'
import { myLog } from '../utils.ts'
import { admin_handler } from './admin.ts'
import { clientIp, ipMatcher } from './limits.ts'

const trustedProxy = ipMatcher(TRUSTED_PROXIES)

type Handler = (req: Request, info?: Deno.ServeHandlerInfo) => Promise<Response>

export function withCors(handler: Handler): Handler {
  return async (req, info) => {
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

    const response = await handler(req, info)

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

// info is missing in tests: no client address, nothing tracked or refused
export function main_handler(
  req: Request,
  info?: Deno.ServeHandlerInfo,
): Promise<Response> {
  const url = new URL(req.url)
  if (url.pathname.startsWith('/api/admin/')) return admin_handler(req)

  const routePath = routes[url.pathname]
  if (!routePath) {
    return Promise.resolve(new Response('Not found', { status: 404 }))
  }

  const routeMethod = routePath[req.method]
  if (!routeMethod) {
    return Promise.resolve(new Response('Method not allowed', { status: 405 }))
  }

  if (
    API_TOKEN && url.pathname !== '/api/status' &&
    req.headers.get('authorization') !== `Bearer ${API_TOKEN}`
  ) {
    return Promise.resolve(new Response('Unauthorized', { status: 401 }))
  }

  const remote = (info?.remoteAddr as Deno.NetAddr | undefined)?.hostname
  const ip = remote ? clientIp(req, remote, trustedProxy) : ''
  if (ip && url.pathname !== '/api/status') {
    if (AppState.bans.matches(ip)) {
      return Promise.resolve(new Response('Forbidden', { status: 403 }))
    }
    AppState.clients.seen(ip, req)
    const server = url.searchParams.get('server')
    const channel = url.searchParams.get('channel')
    if (server && channel) {
      AppState.clients.chat(ip, toChatId(server, normalizeChannel(channel)))
    }
  }

  return routeMethod(req, ip)
}

const routes: Record<
  string,
  Record<string, (req: Request, ip: string) => Promise<Response>>
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
  '/api/avatars': {
    GET: avatars,
  },
}

// Profile images of chatters by user key; users the platform doesn't know are left out
async function avatars(req: Request): Promise<Response> {
  const url = new URL(req.url)
  const params = AvatarsRequest({
    server: url.searchParams.get('server'),
    ids: url.searchParams.get('ids'),
  })
  if (params instanceof type.errors) {
    return Response.json({ errors: params.issues }, { status: 400 })
  }

  const connector = AppState.connectors.get(params.server)
  if (!connector?.fetchAvatars) {
    return Response.json({ errors: ['Unsupported chat server'] }, {
      status: 400,
    })
  }

  try {
    return Response.json({ avatars: await connector.fetchAvatars(params.ids) })
  } catch (error) {
    myLog(
      LogLevel.DEBUG,
      `[${params.server}] Failed to fetch avatars: ${error}`,
    )
    return Response.json({ errors: ['The platform did not answer'] }, {
      status: 502,
    })
  }
}

const STREAM_KEEPALIVE_MS = 20_000

// System notices (Twitch subs, raids, timeouts..., Kick raids) are opt-in with notices=1: older clients expect chat lines only
function noticeFilter(url: URL): (message: ChatMessage) => boolean {
  return url.searchParams.get('notices') === '1'
    ? () => true
    : (message) => !message.notice
}

// Pins, polls and predictions (types 'pin', 'poll', 'prediction') are opt-in with pins=1: older clients treat an unknown event as a clear
function wantsState(url: URL): boolean {
  return url.searchParams.get('pins') === '1'
}

// Server-Sent Events: pushes {type: 'message' | 'delete' | 'clear' | 'pin' | 'poll' | 'prediction'} events of one chat
function chat_stream(req: Request, ip: string): Promise<Response> {
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
  const keep = noticeFilter(url)
  const state = wantsState(url)
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
        (event) => {
          if (event.type === 'message' && !keep(event.message)) return
          if (
            (event.type === 'pin' || event.type === 'poll' ||
              event.type === 'prediction') && !state
          ) return
          send(`data: ${JSON.stringify(event)}\n\n`)
        },
      )
      // (Re)joins the channel if its socket dropped and marks it as read so
      // the inactivity cleanup doesn't disconnect a chat that is on screen.
      // The ping is a named event (not a comment) so clients can detect a
      // stream that silently died and reconnect.
      // connect() gets the channel as sent: YouTube channel ids are case-sensitive
      const keepAlive = () => {
        connector.connect(params.channel).catch(() => {})
        connector.getMessages(channel, Infinity)
        send('event: ping\ndata: {}\n\n')
      }
      // EventSource waits this long before reconnecting after a drop
      send('retry: 3000\n\n')
      if (state) {
        for (const event of chatState(toChatId(params.server, channel))) {
          send(`data: ${JSON.stringify(event)}\n\n`)
        }
      }
      keepAlive()
      const timer = setInterval(keepAlive, STREAM_KEEPALIVE_MS)
      const forget = AppState.clients.streamOpened(
        ip,
        toChatId(params.server, channel),
        () => {
          cleanup()
          try {
            controller.close()
          } catch {
            // already closed by the client
          }
        },
      )
      cleanup = () => {
        clearInterval(timer)
        unsubscribe()
        forget()
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

async function chat_connect(req: Request, ip: string): Promise<Response> {
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

  if (ip) {
    AppState.clients.chat(
      ip,
      toChatId(body.server, normalizeChannel(body.channel)),
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

  const limited = messages.filter(noticeFilter(url)).slice(
    0,
    MAX_MESSAGES_RESPONSE,
  )

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
  ).filter(noticeFilter(url))

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
