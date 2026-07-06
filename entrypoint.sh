#!/bin/sh
set -e

echo "Running database migrations..."
deno task migrate

echo "Starting stream-chat-server..."
exec deno task start
