import { LOG_LEVEL } from './config.ts'

export async function sleep(ms: number) {
  await new Promise((resolve) => setTimeout(resolve, ms))
}

export type LogLevel = number & {
  readonly __logLevel: unique symbol
}

export const LogLevel = {
  DEBUG: 1 as LogLevel,
  VERBOSE: 2 as LogLevel,
  ALL: 3 as LogLevel,
} as const

export function log(level: LogLevel, ...args: unknown[]) {
  if (level <= LOG_LEVEL) {
    console.log(...args)
  }
}
