FROM denoland/deno:2.9.1

WORKDIR /app

# Cache dependencies separately so they're reused across builds
COPY deno.json deno.lock ./
COPY src ./src
COPY drizzle.config.ts ./
COPY drizzle ./drizzle

RUN deno cache src/main.ts

COPY entrypoint.sh ./
RUN chmod +x entrypoint.sh && mkdir -p /app/data

ENV TZ=Europe/Moscow

EXPOSE 8000

# Docker never restarts an unhealthy container by itself, so the check stops PID 1
# and the compose `restart:` policy brings the container back
HEALTHCHECK --interval=30s --timeout=30s --start-period=60s \
  CMD deno eval "for (let i = 0; i < 3; i++) { try { const r = await fetch('http://127.0.0.1:' + (Deno.env.get('PORT') || 8000) + '/api/status', { signal: AbortSignal.timeout(5000) }); if (r.ok) Deno.exit(0) } catch {} await new Promise((r) => setTimeout(r, 2000)) } Deno.exit(1)" || kill 1

ENTRYPOINT ["./entrypoint.sh"]
