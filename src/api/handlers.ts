import { ChannelName } from '../connectors/types.ts'
import { ChatStatusRequest, ConnectRequest } from './schema.ts'
import { type } from 'arktype'
import { connectors } from '../connectors/utils.ts'

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
  '/api/chat_status': {
    GET: chat_status,
  },
}

async function chat_connect(req: Request): Promise<Response> {
  const body = ConnectRequest(await req.json())
  if (body instanceof type.errors) {
    return Promise.resolve(
      new Response(JSON.stringify({ errors: body.issues }), {
        status: 400,
        headers: { 'content-type': 'application/json' },
      }),
    )
  }

  const connector = connectors.get(body.server)
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

function chat_status(req: Request): Promise<Response> {
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

  const connector = connectors.get(params.server)
  if (!connector) {
    return Promise.resolve(
      new Response(JSON.stringify({ errors: ['Unsupported chat server'] }), {
        status: 400,
        headers: { 'content-type': 'application/json' },
      }),
    )
  }

  const status = connector.getChannelStatus(params.channel as ChannelName)

  return Promise.resolve(
    Response.json({
      status,
    }),
  )
}
