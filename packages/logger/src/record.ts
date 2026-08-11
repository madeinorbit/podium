import type { LogLevel } from './levels'

/** An error flattened to something JSON can carry across a process boundary. */
export interface SerializedError {
  name: string
  message: string
  stack?: string
  cause?: SerializedError
}

/**
 * The NDJSON record, exactly as the spec defines it:
 *
 * ```json
 * {"ts":"2026-08-11T14:03:22.847Z","level":"warn","ns":"daemon:pty",
 *  "msg":"resize dropped","sessionId":"…","role":"daemon","v":"0.1.3"}
 * ```
 *
 * `ts` is ISO-8601 with millisecond precision and is mandatory on every record.
 * CAVEAT for anyone reading the data: cross-machine deltas are bounded by clock
 * sync. For an intra-process duration use a `durationMs` field taken from a
 * monotonic clock — never timestamp subtraction.
 */
export interface LogRecord {
  ts: string
  level: LogLevel
  ns: string
  msg: string
  role?: string
  v?: string
  err?: SerializedError
  [field: string]: unknown
}

/** Free-form structured fields. `err` is the one key with a defined meaning. */
export type Fields = Record<string, unknown>

/** The process-bound context attached once at boot. */
export interface ProcessContext {
  /** `server` | `daemon` | `janitor` | `cli` | `web` | `desktop` | `mobile`. */
  role?: string
  /** App version — `PODIUM_APP_VERSION` / `serverBuildVersion()`. */
  v?: string
  platform?: string
  instance?: string
  [field: string]: unknown
}

/**
 * Keys the record shape owns. A caller field with one of these names is DROPPED
 * rather than written: a `ns` field that overwrote the namespace would make the
 * one column every query groups by unreliable, and silently. `err` is the
 * exception — it is reserved precisely so a caller CAN pass one, and it goes
 * through {@link serializeError} on the way in.
 */
export const RESERVED_KEYS: ReadonlySet<string> = new Set([
  'ts',
  'level',
  'ns',
  'msg',
  'role',
  'v',
  'err',
])

const MAX_CAUSE_DEPTH = 5

/** Flatten anything that was thrown. Never throws itself. */
export function serializeError(value: unknown, depth = 0): SerializedError {
  if (!(value instanceof Error)) {
    return { name: 'NonError', message: safeString(value) }
  }
  const serialized: SerializedError = { name: value.name, message: value.message }
  if (typeof value.stack === 'string') serialized.stack = value.stack
  const cause: unknown = (value as { cause?: unknown }).cause
  // Depth-bounded rather than cycle-tracked: a self-referential cause is the
  // common shape and both are stopped by the same bound.
  if (cause !== undefined && cause !== null && depth < MAX_CAUSE_DEPTH) {
    serialized.cause = serializeError(cause, depth + 1)
  }
  return serialized
}

function safeString(value: unknown): string {
  if (typeof value === 'string') return value
  try {
    return typeof value === 'object' ? JSON.stringify(value) : String(value)
  } catch {
    return Object.prototype.toString.call(value)
  }
}

export interface BuildRecordInput {
  level: LogLevel
  ns: string
  msg: string
  fields: Fields
  context: ProcessContext
  /** Injectable only so tests can pin `ts`; production always uses the clock. */
  now?: () => Date
}

/**
 * Assemble one record. Key insertion order is the wire order: `ts`, `level`,
 * `ns`, `msg` lead every line so a tail of raw NDJSON is readable by eye.
 */
export function buildRecord(input: BuildRecordInput): LogRecord {
  const record: LogRecord = {
    ts: (input.now?.() ?? new Date()).toISOString(),
    level: input.level,
    ns: input.ns,
    msg: input.msg,
  }
  for (const [key, value] of Object.entries(input.fields)) {
    if (RESERVED_KEYS.has(key)) continue
    record[key] = value
  }
  for (const [key, value] of Object.entries(input.context)) {
    if (value !== undefined) record[key] = value
  }
  if (input.fields.err !== undefined) record.err = serializeError(input.fields.err)
  return record
}

/**
 * One NDJSON line, newline-terminated.
 *
 * A circular or otherwise unserializable field must not become an exception at
 * a `log.info()` call site — logging never breaks the app (spec: Error
 * handling) — so the fallback emits the record's own skeleton plus a note
 * naming what happened.
 */
export function toNdjson(record: LogRecord): string {
  try {
    return `${JSON.stringify(record)}\n`
  } catch {
    const { ts, level, ns, msg } = record
    return `${JSON.stringify({
      ts,
      level,
      ns,
      msg,
      logErr: 'record fields were not serializable and were dropped',
    })}\n`
  }
}
