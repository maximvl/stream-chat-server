import { AppState } from '../app.ts'
import { CORS_HOSTS, MAX_MESSAGES_RESPONSE } from '../config.ts'
import { ChannelName } from '../connectors/types.ts'
import { ChatMessagesRequest, ConnectRequest } from './schema.ts'
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
  '/api/status': {
    GET: app_status,
  },
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

async function app_status(_req: Request): Promise<Response> {
  const connectors = Array.from(AppState.connectors.values())
  const statuses = await Promise.all(
    connectors.map((connector) => connector.getStatus()),
  )

  return Response.json({
    connectors: statuses,
  })
}
