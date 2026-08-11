import type { LogLevel } from '../levels'
import type { LogRecord, SerializedError } from '../record'
import { RESERVED_KEYS, toNdjson } from '../record'
import type { Sink } from '../sinks'

/** The console methods this sink uses. Narrow on purpose, so it can be faked. */
export interface ConsoleLike {
  error(...args: unknown[]): void
  warn(...args: unknown[]): void
  info(...args: unknown[]): void
  debug(...args: unknown[]): void
}

export interface ConsoleSinkOptions {
  /**
   * ABSENT (the default) means the sink follows the namespace's configured
   * level, so `PODIUM_LOG_LEVEL` and the programmatic setter move it. The
   * spec's "warn in prod, debug in dev" is a BOOT decision expressed by calling
   * `setLogLevel`, not a threshold baked in here — otherwise raising verbosity
   * to diagnose a live problem would change everything except the one surface
   * the operator is reading.
   */
  minLevel?: LogLevel
  /** Human-readable single line instead of NDJSON. Defaults to dev detection. */
  pretty?: boolean
  console?: ConsoleLike
}

const METHOD: Readonly<Record<LogLevel, keyof ConsoleLike>> = {
  error: 'error',
  warn: 'warn',
  info: 'info',
  // `trace` on the console prints a stack trace, which is not what this level
  // means here — the firehose goes to `debug` like everything below `info`.
  debug: 'debug',
  trace: 'debug',
}

function isDev(): boolean {
  const proc = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process
  return proc?.env?.NODE_ENV !== 'production'
}

/** Developer visibility. NDJSON when machine-read, one padded line when not. */
export function createConsoleSink(options: ConsoleSinkOptions = {}): Sink {
  const pretty = options.pretty ?? isDev()
  const target = options.console ?? console
  return {
    name: 'console',
    ...(options.minLevel ? { minLevel: options.minLevel } : {}),
    write(record: LogRecord): void {
      const method = METHOD[record.level]
      if (!pretty) {
        // The trailing newline belongs to a file or a stream; the console adds
        // its own, and emitting both leaves a blank line between every record.
        target[method](toNdjson(record).trimEnd())
        return
      }
      target[method](prettyLine(record))
    },
  }
}

function prettyLine(record: LogRecord): string {
  const time = record.ts.slice(11, 23)
  const parts = [time, record.level.toUpperCase().padEnd(5), record.ns, record.msg]
  for (const [key, value] of Object.entries(record)) {
    if (RESERVED_KEYS.has(key)) continue
    parts.push(`${key}=${renderValue(value)}`)
  }
  if (record.err) parts.push(renderError(record.err))
  return parts.join(' ')
}

function renderValue(value: unknown): string {
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value) ?? String(value)
  } catch {
    return '[unserializable]'
  }
}

function renderError(err: SerializedError): string {
  return `\n${err.stack ?? `${err.name}: ${err.message}`}`
}
