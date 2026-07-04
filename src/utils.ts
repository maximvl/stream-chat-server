import { LOG_LEVEL, LogLevel } from './config.ts'

export async function sleep(ms: number) {
  await new Promise((resolve) => setTimeout(resolve, ms))
}

export function myLog(level: LogLevel, ...args: unknown[]) {
  if (level <= LOG_LEVEL) {
    console.log(...args)
  }
}
