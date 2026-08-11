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

/**
 * Keys the CONTEXT is allowed to write even though the record shape owns them.
 * `role` and `v` are the process context's whole purpose — they are reserved
 * against caller fields precisely so that boot, not a call site, decides them.
 */
const CONTEXT_OWNED_KEYS: ReadonlySet<string> = new Set(['role', 'v'])

const MAX_CAUSE_DEPTH = 5

/**
 * Is this already a serialized error rather than a thrown one?
 *
 * A crash forwarded from a browser client arrives as a plain `{name, message,
 * stack}` object, not an `Error` — it crossed a JSON boundary to get here
 * (spec: serialized crashes). Without this check it is a `NonError` whose
 * `message` is the whole thing JSON-stringified, so a server that relogs a
 * client's `err` field double-wraps it and the stack stops being a stack.
 */
function isSerializedError(value: unknown): value is SerializedError {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const candidate = value as { name?: unknown; message?: unknown }
  return typeof candidate.name === 'string' && typeof candidate.message === 'string'
}

/** Flatten anything that was thrown. Never throws itself. */
export function serializeError(value: unknown, depth = 0): SerializedError {
  if (!(value instanceof Error)) {
    if (isSerializedError(value)) {
      // Pass through, rebuilt field by field rather than returned as-is: the
      // object came from outside and may carry anything else besides.
      const passed: SerializedError = { name: value.name, message: value.message }
      if (typeof value.stack === 'string') passed.stack = value.stack
      const nested: unknown = (value as { cause?: unknown }).cause
      if (nested !== undefined && nested !== null && depth < MAX_CAUSE_DEPTH) {
        passed.cause = serializeError(nested, depth + 1)
      }
      return passed
    }
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
 * Should built records be frozen? Cached, because this is decided by the
 * environment once and then asked on every record.
 */
let freezeRecords: boolean | null = null

function ambientFlag(name: string): string | undefined {
  const proc = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process
  return proc?.env?.[name]
}

function shouldFreeze(): boolean {
  if (freezeRecords === null) {
    const env = ambientFlag('NODE_ENV')
    freezeRecords =
      ambientFlag('PODIUM_LOG_FREEZE') === '1' || env === 'test' || env === 'development'
  }
  return freezeRecords
}

/**
 * Force record freezing on or off; `null` restores the environment default.
 *
 * Exists so a test can assert BOTH halves of the policy — that a mutating sink
 * is caught under development, and that production does not pay for the check.
 */
export function setRecordFreezing(on: boolean | null): void {
  freezeRecords = on
}

/**
 * Assemble one record. Key insertion order is the wire order: `ts`, `level`,
 * `ns`, `msg` lead every line so a tail of raw NDJSON is readable by eye.
 *
 * Under `NODE_ENV=test`/`development` (or `PODIUM_LOG_FREEZE=1`) the finished
 * record is FROZEN. `Sink.write` forbids mutating a record — every sink and
 * every ring-buffer snapshot share the same object, so one mutation rewrites
 * another sink's history — but nothing enforced that, and a violation would
 * have surfaced as a wrong crash payload weeks later rather than as a failure
 * in the offending sink's own test run.
 *
 * Frozen, a mutating sink throws (modules are strict mode), fail-open disables
 * it, and the existing local warning names it. The cost is deliberately not
 * paid in production: one cached boolean, and no freeze on the hot path.
 *
 * The freeze is SHALLOW — a nested field object is still mutable — so this
 * catches the common violation, not every one.
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
    if (value === undefined) continue
    // The context is filtered exactly like caller fields, and for the same
    // reason. `ProcessContext` has an index signature, so nothing in the type
    // system stops `setProcessContext({ ns: 'SPOOFED', ts: 'bogus' })` — and a
    // forged `ns` is worse from here than from a call site, because it is set
    // once at boot and then silently forges EVERY record the process emits.
    if (RESERVED_KEYS.has(key) && !CONTEXT_OWNED_KEYS.has(key)) continue
    record[key] = value
  }
  if (input.fields.err !== undefined) record.err = serializeError(input.fields.err)
  return shouldFreeze() ? Object.freeze(record) : record
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
