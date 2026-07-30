/** Shared read-quarantine helpers for the per-aggregate repositories. */

/**
 * Parse a JSON text column that should hold `string[]`, tolerating corruption.
 * A single malformed value (bad JSON, or valid JSON of the wrong shape) must not
 * throw out of a row mapper — that would abort the whole table load (and, for the
 * issues table, crash-loop the server at boot). Quarantine the bad value to `[]`
 * and warn so it stays observable.
 */
export function parseStringArray(raw: unknown, label: string): string[] {
  if (raw == null) return []
  try {
    const v = JSON.parse(raw as string)
    if (Array.isArray(v) && v.every((x) => typeof x === 'string')) return v
    console.warn(`[podium] ${label}: expected string[], got ${typeof v} — quarantined to []`)
    return []
  } catch (err) {
    console.warn(`[podium] ${label}: unparseable JSON — quarantined to [] (${String(err)})`)
    return []
  }
}

/**
 * Parse a JSON text column to `T | undefined`, tolerating corruption (see
 * {@link parseStringArray}). Returns `undefined` for a null column or any parse
 * failure, so one corrupt blob can't abort the rest of the load.
 */
export function parseJsonColumn<T>(raw: unknown, label: string): T | undefined {
  if (raw == null) return undefined
  try {
    return JSON.parse(raw as string) as T
  } catch (err) {
    console.warn(`[podium] ${label}: unparseable JSON — quarantined (${String(err)})`)
    return undefined
  }
}

/**
 * Refuse a per-user WRITE with no identity (POD-380; extended to the issue half
 * by POD-1076, which is why it lives here rather than in one repository).
 *
 * The reads tolerate an unknown user (they return that user's empty slice, which
 * is the truthful answer), but a write with no owner would create a row nobody
 * can ever read or delete. Failing here rather than defaulting to the first admin
 * is §3.1.6 S4's rule: an unidentified principal fails CLOSED, it does not fall
 * back to an operator identity.
 */
export function requireUserId(userId: string): void {
  if (userId.trim() === '') throw new Error('per-user state write has no user id')
}
