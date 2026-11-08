# YouTube node

YouTube is not reachable from the main server, so its chats are read by a second copy of
this server on a host abroad (the "node"). The main server follows the node's
`/api/chat_stream` and keeps the messages in its own storage, so history, `chat_stream`
and chat command checks work as for the other platforms.

```
overlay → main server (YOUTUBE_NODE_URL) → node abroad → youtube.com
```

The node reads the chat the way youtube.com/live_chat does, as a guest: no API key, no
quota. A channel is given as `@handle` or as a channel id `UC…`; while it is off the air the
node checks again once a minute.

## Node

Same image, only the YouTube connector. With Docker:

```sh
git clone <this repo> stream-chat-server && cd stream-chat-server
docker build -t stream-chat-server .
docker run -d --name youtube-node --restart unless-stopped \
  -p 8000:8000 \
  -e DISABLED_CONNECTORS=twitch,vkvideo,kick,wtv,goodgame \
  -e API_TOKEN=<long random string> \
  -v youtube_node_data:/app/data -e DB_FILE=file:/app/data/db.sqlite \
  stream-chat-server
```

Or with Deno 2:

```sh
DISABLED_CONNECTORS=twitch,vkvideo,kick,wtv,goodgame API_TOKEN=<token> PORT=8000 deno task start
```

| Env | |
| --- | --- |
| `DISABLED_CONNECTORS` | `twitch,vkvideo,kick,wtv,goodgame`: the node reads YouTube only |
| `API_TOKEN` | optional; when set, every API call except `/api/status` needs `Authorization: Bearer <token>` |
| `PORT` | default `8000` |
| `CORS_HOSTS` | not needed: browsers never talk to the node |

Check: connect a channel that is live, then read it back a few seconds later:

```sh
curl -X POST -H 'Authorization: Bearer <token>' -H 'Content-Type: application/json' \
  -d '{"server":"youtube","channel":"@LofiGirl"}' http://<node>:8000/api/chat_connect
curl -H 'Authorization: Bearer <token>' 'http://<node>:8000/api/chat_last_messages?server=youtube&channel=@LofiGirl'
```

The second call shows `"status": "connected"` and the latest messages. Without the first one
it returns `"status": null`: reading does not connect a channel.

Put it behind HTTPS (nginx, Caddy) if the link between the servers is not trusted; for nginx
turn off buffering for `/api/chat_stream` (the server already sends `X-Accel-Buffering: no`).

## Main server

Add to its environment and restart:

| Env | |
| --- | --- |
| `YOUTUBE_NODE_URL` | node address, e.g. `https://yt-node.example.com` (no trailing path) |
| `YOUTUBE_NODE_TOKEN` | the node's `API_TOKEN`, if set |

With `YOUTUBE_NODE_URL` set the main server does not go to YouTube itself. Its
`/api/status` lists YouTube channels as `connected` only while the node reads them.
