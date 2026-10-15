/**
 * PREPARED ONCE, REUSED [POD-6147, server data design §3 rule 1].
 *
 * A drizzle builder chain (`db.select().from(t).where(...).get()`) does its
 * expensive work at the terminal call: it serialises the statement through the
 * dialect and generates a row mapper over the selection. POD-3854 measured that
 * as about 89% of a primary-key read. `.prepare()` keeps that work, and what is
 * left per call is filling placeholders and running the statement.
 *
 * WHY ONE INSTANCE PER STORE IS ENOUGH. A prepared query closes over the session
 * of the drizzle instance it was built on. The store hands every repository ONE
 * drizzle instance over the executor's AMBIENT client, whose router resolves the
 * enclosing transaction for each statement as it executes. So a query prepared
 * once runs inside whatever transaction is current when it is executed, exactly
 * like the fluent form did (`SyncRepository`'s `change_latest` statements have
 * relied on this since POD-3494).
 *
 * The helpers here are keyed by that drizzle instance rather than held as plain
 * module constants, because a process can hold several stores (tests, restore)
 * and each store has its own instance. They are generic over the instance type
 * so `apps/server`'s repositories and this package's adapter share one
 * implementation.
 *
 * Rules for a converted query:
 *   - A comparison value is `param(column, 'name')`, never a bare
 *     `sql.placeholder`: drizzle applies the column's encoder (JSON, boolean,
 *     timestamp modes) only to a placeholder wrapped in a column `Param`, which
 *     is what `eq(column, value)` built for a literal value.
 *   - A `.values({...})` or `.set({...})` entry is `sql.placeholder('name')`:
 *     the builder wraps it in the column's `Param` itself.
 *   - A query whose SQL text depends on the call (optional filters, a patch
 *     with varying keys, an IN list) is a {@link preparedFamily} keyed by its
 *     SHAPE. The key comes from a finite domain, never from a value.
 */

import { type Column, inArray, notInArray, Param, type Placeholder, type SQL, sql } from 'drizzle-orm'

/** One query, prepared on first use and reused for the drizzle instance's life. */
export function prepared<D extends object, P>(build: (db: D) => P): (db: D) => P {
  const cache = new WeakMap<D, P>()
  return (db) => {
    const hit = cache.get(db)
    if (hit !== undefined) return hit
    const made = build(db)
    cache.set(db, made)
    return made
  }
}

/**
 * How many shapes one family keeps per drizzle instance. A family's keys come
 * from a finite domain by construction (flags, IN-list sizes, the column set of
 * a typed patch), so this is a backstop against a key that accidentally carries
 * a value, not a working limit. Overflow evicts the oldest shape and is counted,
 * so the guard test can see it.
 */
const FAMILY_LIMIT = 128
let familyOverflowCount = 0

/** Times any family evicted a shape since the process started (guard tests read it). */
export function preparedFamilyOverflows(): number {
  return familyOverflowCount
}

/**
 * A bounded set of prepared queries, one per SHAPE.
 *
 * For a query whose SQL text varies by call: which optional filters are set,
 * which columns a patch writes, how many values an IN list holds. Each shape is
 * prepared once, the first time it is asked for, and the SQL text of every
 * shape is the text the fluent form produced for the same call.
 */
export function preparedFamily<D extends object, K extends string | number, P>(
  build: (db: D, key: K) => P,
): (db: D, key: K) => P {
  const cache = new WeakMap<D, Map<K, P>>()
  return (db, key) => {
    let family = cache.get(db)
    if (family === undefined) {
      family = new Map()
      cache.set(db, family)
    }
    const hit = family.get(key)
    if (hit !== undefined) return hit
    if (family.size >= FAMILY_LIMIT) {
      familyOverflowCount += 1
      const oldest = family.keys().next().value as K
      family.delete(oldest)
    }
    const made = build(db, key)
    family.set(key, made)
    return made
  }
}

/**
 * A named placeholder bound to `column`'s encoder, for the right-hand side of a
 * comparison. Renders `?`, exactly as `eq(column, value)` does, and fills with
 * the value encoded the way that literal would have been.
 */
export function param(column: Column, name: string): Param {
  return new Param(sql.placeholder(name), column)
}

/**
 * The shape key of a patch: the names of the keys it actually sets, in a fixed
 * order. Drizzle's `.set()` and `.values()` skip a key whose value is
 * `undefined`, so a key that is present but undefined is not part of the shape.
 */
export function shapeOf(patch: object): string {
  return Object.keys(patch)
    .filter((key) => (patch as Record<string, unknown>)[key] !== undefined)
    .sort()
    .join(',')
}

/**
 * Placeholder-valued copy of a patch's set keys, for `.set()` or `.values()`
 * inside a family's builder: `{ title: sql.placeholder('title'), ... }`.
 */
export function placeholdersFor(shape: string): Record<string, Placeholder> {
  const out: Record<string, Placeholder> = {}
  if (shape === '') return out
  for (const key of shape.split(',')) out[key] = sql.placeholder(key)
  return out
}

// ---------------------------------------------------------------------------
// Bounded IN lists
// ---------------------------------------------------------------------------

/**
 * The size an IN list of `count` values is prepared at: 0, 1, then the next
 * power of two. A query keyed by this size has at most
 * log2(largest list) + 2 shapes, however many distinct lengths its callers pass,
 * where the fluent form made one SQL text (and one cached driver statement) per
 * distinct length.
 *
 * Above SQLite's portable bound-parameter ceiling the exact count is used: a
 * list that large is not chunked by its caller today, and rounding it up could
 * cross the limit. Every chunked caller (500 per chunk) stays bucketed.
 */
export function inListSize(count: number): number {
  if (count <= 1) return count
  let size = 2
  while (size < count) size *= 2
  return size > IN_LIST_BUCKET_CEILING ? count : size
}

/** Lists longer than this keep their exact length (see {@link inListSize}). */
export const IN_LIST_BUCKET_CEILING = 16384

/**
 * `column IN (?, ?, ...)` with `size` placeholders named `${prefix}0`,
 * `${prefix}1`, ...; `size` 0 renders drizzle's own `false`, as an empty list
 * always did.
 */
export function inListOf(column: Column, size: number, prefix = 'in'): SQL {
  return inArray(column, inListParams(column, size, prefix))
}

/** `column NOT IN (...)`, the same way; `size` 0 renders drizzle's `true`. */
export function notInListOf(column: Column, size: number, prefix = 'in'): SQL {
  return notInArray(column, inListParams(column, size, prefix))
}

function inListParams(column: Column, size: number, prefix: string): Param[] {
  return Array.from({ length: size }, (_, index) => param(column, `${prefix}${index}`))
}

/**
 * The placeholder values for an IN list prepared at `size`. Padding REPEATS the
 * last value: a duplicate in an IN list matches nothing a single copy does not,
 * so the rows (and the count of changed rows) are the ones the exact list gave,
 * and no sentinel value can ever collide with real data.
 */
export function inListValues(
  values: readonly unknown[],
  size: number,
  prefix = 'in',
  into: Record<string, unknown> = {},
): Record<string, unknown> {
  if (values.length > size) {
    throw new RangeError(`IN list of ${values.length} values prepared at size ${size}`)
  }
  const last = values[values.length - 1]
  for (let index = 0; index < size; index++) {
    into[`${prefix}${index}`] = index < values.length ? values[index] : last
  }
  return into
}
