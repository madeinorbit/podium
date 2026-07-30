/**
 * THE clock representation for the model (POD-299).
 *
 * Every time-dependent predicate in this package takes an {@link Instant} —
 * epoch milliseconds. Nothing takes an ISO string, and nothing compares
 * timestamps as strings. Conversion happens ONCE, at the edge, through
 * {@link toInstant} / {@link toIso}.
 *
 * WHY epoch and not ISO. Before this collapse the package carried twin
 * predicate families over the same stored field: an ISO-string one for the
 * server (which holds an ISO `now`) and an epoch-ms one for client viewmodels
 * (which hold `Date.now()`). Two implementations of one rule is the thing
 * `packages/model` exists to stop, and the ISO half was the wrong survivor:
 *
 *   - Lexicographic ISO comparison is only correct when BOTH sides are the
 *     same shape and the same zone. `deferUntil` is not: the board's defer
 *     presets store a bare date (`YYYY-MM-DD`) while the server stores a full
 *     `toISOString()` instant, and any offset-bearing spelling
 *     (`…T12:00:00+02:00`) sorts by its printed digits rather than its actual
 *     instant. Epoch comparison is total and zone-correct by construction.
 *   - The same trap has already cost us once at the SQL layer, where
 *     `created_at >= datetime(...)` string-compares wrongly because ISO's `T`
 *     sorts above a space.
 *
 * WHY the field types do NOT change. Stored and wire values stay the strings
 * they are today — this collapse is about the COMPARISON, not the
 * representation on the wire. `snoozedUntil` and `deferUntil` remain
 * `string | null`, so the wire stays byte-identical. That is also what makes
 * POD-1076's move of `snoozedUntil` into the per-user state family a re-KEY
 * rather than a re-representation.
 */

/** A point in time as epoch milliseconds — the model's only clock type. */
export type Instant = number

/**
 * Wire → model. Accepts every spelling the stored timestamp fields actually
 * carry: a full ISO instant, a bare `YYYY-MM-DD` date (parsed as UTC midnight,
 * matching `Date.parse`), or an already-epoch number.
 *
 * Null for absent, empty, or unparseable input, so a caller cannot silently
 * treat garbage as the epoch. Sentinel values that are not timestamps at all
 * (`DEFER_NEXT_MESSAGE`) are the caller's to special-case BEFORE converting —
 * they read as null here.
 */
export function toInstant(value: string | number | null | undefined): Instant | null {
  if (value === null || value === undefined) return null
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : null
}

/**
 * Wire → model for a value the caller knows is a timestamp — the adapter at a
 * server edge that holds an ISO `now`. Throws on unparseable input rather than
 * inventing a fallback: a broken clock must not silently read as 1970.
 */
export function requireInstant(value: string | number): Instant {
  const at = toInstant(value)
  if (at === null) throw new Error(`requireInstant: not a timestamp: ${JSON.stringify(value)}`)
  return at
}

/**
 * Model → wire. The ISO-8601 UTC spelling every persisted timestamp field
 * carries, so a value that round-trips through the model comes back
 * byte-identical to what the server would have written itself.
 */
export function toIso(at: Instant): string {
  return new Date(at).toISOString()
}
