import { AppState } from '../app.ts'
import {
  API_TOKEN,
  CORS_HOSTS,
  DEFAULT_LAST_MESSAGES_LIMIT,
  LogLevel,
  MAX_CHANNELS,
  MAX_LAST_MESSAGES_LIMIT,
  MAX_MESSAGES_RESPONSE,
  NEW_CHANNELS_PER_10_MINUTES,
  RATE_LIMIT_ALLOWLIST,
  RATE_LIMIT_PER_MINUTE,
  TRUSTED_PROXIES,
} from '../config.ts'
import { ChannelName, ChatConnector, ChatMessage } from '../connectors/types.ts'
import { subscribe } from '../connectors/chatEvents.ts'
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
import { clientIp, ipMatcher, PRIVATE_RANGES, RateLimiter } from './limits.ts'

type ServeInfo = { remoteAddr: Deno.Addr }

export function withCors(
  handler: (req: Request, info?: ServeInfo) => Promise<Response>,
): (req: Request, info?: ServeInfo) => Promise<Response> {
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

const isTrustedProxy = ipMatcher(TRUSTED_PROXIES)
const isUnlimited = ipMatcher(`${PRIVATE_RANGES},${RATE_LIMIT_ALLOWLIST}`)
export const apiLimiter = new RateLimiter(RATE_LIMIT_PER_MINUTE, 60_000)
export const joinLimiter = new RateLimiter(
  NEW_CHANNELS_PER_10_MINUTES,
  10 * 60_000,
)

function tooManyRequests(waitMs: number, error: string): Response | null {
  if (waitMs <= 0) return null
  return Response.json({ errors: [error] }, {
    status: 429,
    headers: { 'retry-after': String(Math.ceil(waitMs / 1000)) },
  })
}

// A request that would join a channel not joined yet: the per-connector cap, then the per-IP rate.
// client is null for requests that are not limited.
function admitChannel(
  connector: ChatConnector,
  channel: string,
  client: string | null,
): Response | null {
  if (connector.getChannelStatus(channel)) return null
  if (
    MAX_CHANNELS > 0 &&
    connector.getStatus().channels.length >= MAX_CHANNELS
  ) {
    return Response.json({
      errors: ['This server reads too many channels already, try later'],
    }, { status: 503 })
  }
  return client === null ? null : tooManyRequests(
    joinLimiter.hit(client),
    'Too many new channels from this address, try later',
  )
}

export function main_handler(
  req: Request,
  info?: ServeInfo,
): Promise<Response> {
  const url = new URL(req.url)

  const routePath = routes[url.pathname]
  if (!routePath) {
    return Promise.resolve(new Response('Not found', { status: 404 }))
  }

  const routeMethod = routePath[req.method]
  if (!routeMethod) {
    return Promise.resolve(new Response('Method not allowed', { status: 405 }))
  }

  const authorized = !!API_TOKEN &&
    req.headers.get('authorization') === `Bearer ${API_TOKEN}`
  const ip = clientIp(
    req,
    (info?.remoteAddr as Deno.NetAddr | undefined)?.hostname ?? '',
    isTrustedProxy,
  )
  const client = authorized || isUnlimited(ip) ? null : ip

  if (client !== null && url.pathname !== '/api/status') {
    const refused = tooManyRequests(
      apiLimiter.hit(client),
      'Too many requests from this address, try later',
    )
    if (refused) return Promise.resolve(refused)
  }

  if (API_TOKEN && url.pathname !== '/api/status' && !authorized) {
    return Promise.resolve(new Response('Unauthorized', { status: 401 }))
  }

  return routeMethod(req, client)
}

const routes: Record<
  string,
  Record<string, (req: Request, client: string | null) => Promise<Response>>
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

// Twitch system notices (subs, raids, timeouts...) are opt-in with notices=1: older clients expect chat lines only
function noticeFilter(url: URL): (message: ChatMessage) => boolean {
  return url.searchParams.get('notices') === '1'
    ? () => true
    : (message) => !message.notice
}

// Server-Sent Events: pushes {type: 'message' | 'delete' | 'clear'} events of one chat
function chat_stream(req: Request, client: string | null): Promise<Response> {
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

  const refused = admitChannel(connector, params.channel, client)
  if (refused) return Promise.resolve(refused)

  const channel = normalizeChannel(params.channel)
  const encoder = new TextEncoder()
  const keep = noticeFilter(url)
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

async function chat_connect(
  req: Request,
  client: string | null,
): Promise<Response> {
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

  const refused = admitChannel(connector, body.channel, client)
  if (refused) return refused

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
