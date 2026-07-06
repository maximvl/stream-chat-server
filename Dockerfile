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

EXPOSE 8000

ENTRYPOINT ["./entrypoint.sh"]
