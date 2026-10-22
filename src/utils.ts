import { LOG_LEVEL, LogLevel } from './config.ts'

export async function sleep(ms: number) {
  await new Promise((resolve) => setTimeout(resolve, ms))
}

export function myLog(level: LogLevel, ...args: unknown[]) {
  // Local time of the TZ env (Europe/Moscow in Docker)
  const timestamp = Temporal.Now.zonedDateTimeISO().toString({
    smallestUnit: 'seconds',
    timeZoneName: 'never',
  })
  if (level <= LOG_LEVEL) {
    console.log(`[${timestamp}]`, ...args)
  }
}
