/**
 * Fractional sort keys for manual ordering (POD-168, POD-100 §4 R1).
 *
 * A sort key is a non-empty base-36 digit string compared LEXICOGRAPHICALLY —
 * conceptually a fraction in (0, 1) written without the "0." prefix. Reordering
 * a row writes exactly one key (the midpoint of its new neighbors); nothing is
 * ever renumbered. Keys never end in '0', so a strict midpoint always exists.
 *
 * One key SPACE per sibling scope (a project group's top level, a parent's
 * children, the PINNED section) — keys are only ever compared to siblings, so
 * scopes never contend.
 */

const DIGITS = '0123456789abcdefghijklmnopqrstuvwxyz'
const MIN = DIGITS[0] as string
const KEY_RE = /^[0-9a-z]+$/

/** A well-formed sort key: non-empty base-36, no trailing minimum digit. */
export function isSortKey(value: unknown): value is string {
  return typeof value === 'string' && KEY_RE.test(value) && !value.endsWith(MIN)
}

/** Strict midpoint of two fraction strings, a < b (b === '' means 1.0). */
function midpoint(a: string, b: string): string {
  if (b !== '') {
    // Shared prefix passes through; the midpoint happens after it.
    let i = 0
    while (i < b.length && (a[i] ?? MIN) === b[i]) i++
    if (i > 0) return b.slice(0, i) + midpoint(a.slice(i), b.slice(i))
  }
  const lo = a === '' ? 0 : DIGITS.indexOf(a[0] as string)
  const hi = b === '' ? DIGITS.length : DIGITS.indexOf(b[0] as string)
  if (hi - lo > 1) {
    // A whole digit fits between the two leading digits.
    return DIGITS[Math.floor((lo + hi) / 2)] as string
  }
  // Leading digits are adjacent: keep a's digit and recurse on its tail with
  // an open top ('' = 1.0), which always terminates above a.
  return (DIGITS[lo] as string) + midpoint(a.slice(1), '')
}

/**
 * A key strictly between `after` and `before` (lexicographic). `null`/absent
 * bounds are open: `sortKeyBetween(null, min)` mints above the scope's top
 * (i.e. sorts FIRST — smaller keys render first), `sortKeyBetween(max, null)`
 * below its bottom, `sortKeyBetween(null, null)` seeds an empty scope.
 * Throws if the bounds are not strictly ordered or malformed.
 */
export function sortKeyBetween(
  after: string | null | undefined,
  before: string | null | undefined,
): string {
  const a = after ?? ''
  const b = before ?? ''
  if (a !== '' && !isSortKey(a))
    throw new Error(`sortKeyBetween: malformed key ${JSON.stringify(a)}`)
  if (b !== '' && !isSortKey(b))
    throw new Error(`sortKeyBetween: malformed key ${JSON.stringify(b)}`)
  if (b !== '' && a >= b) throw new Error(`sortKeyBetween: bounds out of order (${a} >= ${b})`)
  return midpoint(a, b)
}

/** Ascending key comparison (the scope's render order, top first). */
export function compareSortKeys(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}
