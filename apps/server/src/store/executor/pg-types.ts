/**
 * NATIVE POSTGRES TYPES, SEEN AS SQLITE'S VALUES [POD-6979, POD-6958 design 2.3, OD5].
 *
 * The Postgres schema stores timestamps as `timestamptz(3)`, JSON as `json` and every
 * integer as `bigint`. Repositories still read and write what they do on SQLite: ISO
 * strings in exact `toISOString()` form, JSON text, numbers. The conversion happens
 * here, once, by type OID, in postgres.js's `types` option. Because it works by type
 * and not by column, it covers builder selections, raw `sql` selections, aggregates
 * (`max(updated_at)`), bare `sql.placeholder` values and `param()` alike.
 *
 * THE SERIALIZERS DEPEND ON PREPARED STATEMENTS. postgres.js learns a parameter's
 * type only from the server's description of a prepared statement; an unprepared
 * statement sends every parameter as untyped text and no serializer runs. The driver
 * therefore prepares every statement (`unsafe(sql, params, { prepare: true })`).
 *
 * | OID  | type        | read (parse)                                     | write (serialize)                  |
 * |------|-------------|--------------------------------------------------|------------------------------------|
 * | 20   | int8        | `number`; throws beyond 2^53                      | as text                            |
 * | 1184 | timestamptz | `toISOString()` text; `-infinity` → `''`,        | `''` → `-infinity`, `'￿'` →  |
 * |      |             | `infinity` → `'￿'`                           | `infinity`, other text as is       |
 * | 114  | json        | the stored text, never parsed                    | a string as is                     |
 * | 3802 | jsonb       | the stored text, never parsed                    | a string as is                     |
 * | 17   | bytea       | a plain `Uint8Array`, as bun:sqlite returns      | hex                                |
 *
 * The sentinels: code uses `''` as "before every row" and `'￿'` as "after every
 * row" (design 2.3, rule 4). Postgres refuses `''` as a timestamp; `-infinity` and
 * `infinity` sort exactly where those strings sort among canonical ISO text.
 *
 * STRICT MODE (design 2.3, rule 1). A non-canonical timestamp (an offset, no
 * milliseconds, microseconds) is stored normalised on Postgres and verbatim on
 * SQLite, so the two engines would read it back differently. In strict mode the
 * serializer throws on any timestamp parameter that is not exact `toISOString()`
 * form, so the Postgres test leg finds every such writer. Production lets Postgres
 * normalise.
 */

import { guardRefusalOf } from '../append-only'

/** Type OIDs the driver converts. */
export const PG_OID = Object.freeze({
  int8: 20,
  json: 114,
  timestamptz: 1184,
  jsonb: 3802,
  bytea: 17,
})

/** The connection parameters every store connection starts with. */
export const PG_CONNECTION_PARAMETERS: Readonly<Record<string, string>> = Object.freeze({
  // The read parser accepts any offset, but UTC keeps the server's own output
  // (and anything a raw statement formats) in the form the parser expects first.
  // PgBouncer carries TimeZone and DateStyle per client.
  TimeZone: 'UTC',
  DateStyle: 'ISO, MDY',
})

/** The timestamp sentinel that sorts before every row (`-infinity` on Postgres). */
export const TIMESTAMP_BEFORE_ALL = ''
/** The timestamp sentinel that sorts after every row (`infinity` on Postgres). */
export const TIMESTAMP_AFTER_ALL = '￿'

const INT8_LIMIT = 2n ** 53n

/** An `int8` value outside the range a JavaScript number holds exactly. */
export class Int8RangeError extends RangeError {
  constructor(readonly text: string) {
    super(
      `int8 value ${text} is beyond 2^53 and cannot be read as a JavaScript number without ` +
        'losing precision',
    )
    this.name = 'Int8RangeError'
  }
}

/** Parse Postgres's text form of an `int8` into a number, refusing values beyond 2^53. */
export function parseInt8(text: string): number {
  const value = BigInt(text)
  if (value > INT8_LIMIT || value < -INT8_LIMIT) throw new Int8RangeError(text)
  return Number(value)
}

/** A timestamp Postgres printed that this parser does not understand. */
export class TimestampFormatError extends Error {
  constructor(readonly text: string) {
    super(`unrecognised timestamptz output: ${JSON.stringify(text)}`)
    this.name = 'TimestampFormatError'
  }
}

/**
 * Postgres's ISO output of a `timestamptz`: `2026-11-16 10:00:00.12+00`. The fraction
 * drops trailing zeros (or is absent), the offset is the session time zone's (`+00`,
 * `+05:30`, or `+05:53:28` for a historic local mean time), years past 9999 have
 * more digits and years before 1 end in ` BC`.
 */
const PG_TIMESTAMPTZ =
  /^(\d{4,})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,6}))?([+-])(\d{2})(?::(\d{2}))?(?::(\d{2}))?( BC)?$/

/**
 * A `timestamptz` read as `toISOString()` text, whatever the session time zone and
 * however many fraction digits Postgres printed. A fraction beyond milliseconds is
 * truncated, as `new Date(text)` truncates it. `-infinity` and `infinity` read as the
 * sentinels `''` and `'￿'`.
 */
export function parseTimestamptz(text: string): string {
  if (text === '-infinity') return TIMESTAMP_BEFORE_ALL
  if (text === 'infinity') return TIMESTAMP_AFTER_ALL
  const match = PG_TIMESTAMPTZ.exec(text)
  if (match === null) throw new TimestampFormatError(text)
  const [, year, month, day, hour, minute, second, fraction, sign, offH, offM, offS, bc] = match
  const millis = Number(`${fraction ?? ''}000`.slice(0, 3))
  // setUTCFullYear, not Date.UTC: Date.UTC maps years 0 to 99 onto 1900 to 1999.
  const at = new Date(0)
  const fullYear = bc === undefined ? Number(year) : 1 - Number(year)
  at.setUTCFullYear(fullYear, Number(month) - 1, Number(day))
  at.setUTCHours(Number(hour), Number(minute), Number(second), millis)
  const offsetSeconds =
    (Number(offH) * 3600 + Number(offM ?? 0) * 60 + Number(offS ?? 0)) * (sign === '-' ? -1 : 1)
  const utc = at.getTime() - offsetSeconds * 1000
  if (!Number.isFinite(utc)) throw new TimestampFormatError(text)
  return new Date(utc).toISOString()
}

/** A timestamp parameter that is not exact `toISOString()` form, refused in strict mode. */
export class NonCanonicalTimestampError extends TypeError {
  constructor(readonly value: unknown) {
    super(
      `timestamp parameter ${JSON.stringify(value)} is not in exact toISOString() form; ` +
        'write new Date(x).toISOString() at the writer (POD-6958 design 2.3, rule 1)',
    )
    this.name = 'NonCanonicalTimestampError'
  }
}

const CANONICAL_ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/

/** True when `value` is exactly what `Date.prototype.toISOString` produces for it. */
export function isCanonicalTimestamp(value: string): boolean {
  if (!CANONICAL_ISO.test(value)) return false
  const at = new Date(value)
  return !Number.isNaN(at.getTime()) && at.toISOString() === value
}

/**
 * A `timestamptz` parameter as the text Postgres parses. The sentinels become the
 * infinities; a `Date` becomes its ISO text; any other string goes as it is (strict
 * mode refuses one that is not canonical).
 */
export function serializeTimestamptz(value: unknown, strict: boolean): string {
  if (value === TIMESTAMP_BEFORE_ALL) return '-infinity'
  if (value === TIMESTAMP_AFTER_ALL) return 'infinity'
  if (value instanceof Date) return value.toISOString()
  if (strict && (typeof value !== 'string' || !isCanonicalTimestamp(value))) {
    throw new NonCanonicalTimestampError(value)
  }
  return String(value)
}

/**
 * A SERIALIZER MUST NEVER THROW. postgres.js runs it while it handles the server's
 * description of a prepared statement; a throw there escapes its message loop and leaves
 * the query unanswered and the connection stuck. So a parameter the store refuses is
 * sent as a marked value the server itself refuses (`22007`/`22P02`, invalid input), and
 * {@link translatePgError} turns that failure back into the refusal. The statement fails
 * like any other, so the transaction it ran in aborts as it would on any failure.
 */
const REFUSED = /podium-refused:(\w+):([^:"]*):end/

function refusedParameter(kind: 'timestamp' | 'json', detail: string): string {
  return `podium-refused:${kind}:${encodeURIComponent(detail)}:end`
}

/**
 * A Postgres failure caused by a refused parameter, as the refusal; a shipping guard's
 * in-statement refusal as the error SQLite's trigger raises (`store/append-only.ts`,
 * `guardRefusalOf`: only a `22P02` carrying a declared guard text); anything else as it is.
 */
export function translatePgError(error: unknown): unknown {
  const guard = guardRefusalOf(error)
  if (guard !== undefined) return guard
  const message = (error as { message?: unknown } | null)?.message
  if (typeof message !== 'string') return error
  const match = REFUSED.exec(message)
  if (match === null) return error
  const [, kind, encoded] = match
  const detail = decodeURIComponent(encoded ?? '')
  const refusal =
    kind === 'timestamp'
      ? new NonCanonicalTimestampError(JSON.parse(detail))
      : new TypeError(`JSON parameter refused: ${detail}`)
  return Object.assign(refusal, { cause: error })
}

function timestamptzParameter(value: unknown, strict: boolean): string {
  try {
    return serializeTimestamptz(value, strict)
  } catch (error) {
    if (!(error instanceof NonCanonicalTimestampError)) throw error
    return refusedParameter('timestamp', JSON.stringify(value ?? null))
  }
}

function jsonParameter(value: unknown): string {
  try {
    return serializeJson(value)
  } catch (error) {
    return refusedParameter('json', error instanceof Error ? error.message : String(error))
  }
}

/** A `json`/`jsonb` parameter as text: a string is already JSON text and goes as it is. */
export function serializeJson(value: unknown): string {
  return typeof value === 'string' ? value : JSON.stringify(value)
}

/** How the driver converts values. */
export interface PgTypeOptions {
  /** Refuse non-canonical timestamp parameters (design 2.3, rule 1). */
  readonly strictTimestamps: boolean
}

/** One entry of postgres.js's `types` option. */
export interface PgTypeHandler {
  readonly to: number
  readonly from: readonly number[]
  readonly serialize: (value: unknown) => string
  readonly parse: (text: string) => unknown
}

/**
 * The postgres.js `types` option for a store connection. postgres.js registers each
 * `serialize` for the `to` OID and every `from` OID, and each `parse` for every
 * `from` OID, replacing its own handlers for those types (its defaults parse JSON
 * and turn timestamps into `Date` objects).
 */
export function pgTypeHandlers(options: PgTypeOptions): Record<string, PgTypeHandler> {
  return {
    storeInt8: {
      to: PG_OID.int8,
      from: [PG_OID.int8],
      serialize: (value) => String(value),
      parse: parseInt8,
    },
    storeTimestamptz: {
      to: PG_OID.timestamptz,
      from: [PG_OID.timestamptz],
      serialize: (value) => timestamptzParameter(value, options.strictTimestamps),
      parse: parseTimestamptz,
    },
    storeBytea: {
      to: PG_OID.bytea,
      from: [PG_OID.bytea],
      serialize: (value) => `\\x${Buffer.from(value as Uint8Array).toString('hex')}`,
      // postgres.js would return a Node Buffer; bun:sqlite returns a plain Uint8Array.
      parse: (text) => new Uint8Array(Buffer.from(text.slice(2), 'hex')),
    },
    storeJson: {
      to: PG_OID.json,
      from: [PG_OID.json, PG_OID.jsonb],
      serialize: jsonParameter,
      parse: (text) => text,
    },
  }
}

/**
 * Whether a Postgres store refuses non-canonical timestamps, when its opener does not
 * say: on in the Postgres test leg (`PODIUM_TEST_STORE_ENGINE=pg`) and wherever
 * `PODIUM_PG_STRICT_TIMESTAMPS=1`, off otherwise.
 */
export function strictTimestampsFromEnvironment(
  env: Record<string, string | undefined> = process.env,
): boolean {
  if (env.PODIUM_PG_STRICT_TIMESTAMPS === '1') return true
  if (env.PODIUM_PG_STRICT_TIMESTAMPS === '0') return false
  return env.PODIUM_TEST_STORE_ENGINE === 'pg'
}
