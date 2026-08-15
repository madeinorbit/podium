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
 *
 * "NOTHING IS EVER RENUMBERED" HOLDS FOR A REORDER, NOT FOR A SCOPE (POD-1102).
 * The claim above is true of the one write a drag plans, and it was read as a
 * property of the key space, which it is not: a scope that only ever gains rows
 * AT THE TOP — which is exactly what "new work appears first" means — drives its
 * own minimum one character longer every five creates, for as long as the repo
 * lives. Six hundred issues in, the keys near the top are longer than the wire
 * would accept, and the drag stops working on exactly the rows people drag.
 * {@link spreadSortKeys} is the way out: a scope whose keys have grown long
 * takes fresh evenly-spread ones IN ITS CURRENT ORDER, and the head of the space
 * is open again. Compaction is a scope-level repair, deliberately rare, and it
 * is the ONLY thing here that renumbers.
 */

const DIGITS = '0123456789abcdefghijklmnopqrstuvwxyz'
const MIN = DIGITS[0] as string
const KEY_RE = /^[0-9a-z]+$/

/**
 * The length at which a scope is COMPACTED. This — not the wire ceiling below —
 * is what bounds key growth, and the distinction is the whole lesson of
 * POD-1102: a limit that only REFUSES cannot bound anything, because the writer
 * doing the growing (`mintSortKey`, server-side) never meets it. All the refusal
 * achieved was to break the one path that does cross the wire, the drag.
 *
 * High enough that compaction stays rare — one per ~320 creates in a scope.
 */
export const SORT_KEY_COMPACT_LEN = 64

/**
 * The wire's absolute ceiling on a `sortKey` — an anti-abuse bound, deliberately
 * far above anything the system produces once {@link SORT_KEY_COMPACT_LEN} is
 * doing its job.
 *
 * IT MUST STAY WELL CLEAR OF A HONEST PLAN. A client reordering a scope that has
 * not been compacted yet mints a key one character longer than the neighbour it
 * is landing above — a perfectly well-formed key that merely inherited the
 * scope's history. Refusing it (the old 128) told the operator "that drag
 * failed" about a row whose only crime was being near the top of an old repo,
 * AND skipped the service, so the scope never got repaired and the next drag
 * failed the same way. Accepting it costs one oversized row for the length of
 * one request: `update` compacts the scope on the way out.
 */
export const SORT_KEY_MAX_LEN = 1024

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

/** `count` as a fixed-width base-36 numeral, so lexicographic order over a set
 *  of same-width keys is numeric order. */
function base36(value: number, width: number): string {
  return value.toString(36).padStart(width, MIN)
}

/**
 * `count` ascending keys spread evenly across the whole key space — the order a
 * COMPACTED scope takes (POD-1102). Fixed width, so they compare numerically,
 * and short: a thousand-row scope fits in three characters.
 *
 * The width leaves at least one unused slot between neighbours, which buys two
 * things at once. Ordinary reorders keep landing on the fast path (there is a
 * midpoint between every adjacent pair without lengthening anything), and a key
 * whose last digit came out '0' — illegal, since a trailing minimum has no
 * strict midpoint below it — can be nudged one slot up without ever reaching
 * its neighbour.
 */
export function spreadSortKeys(count: number): string[] {
  if (count <= 0) return []
  let width = 1
  let space = DIGITS.length
  while (space < (count + 1) * 2) {
    width += 1
    space *= DIGITS.length
  }
  const step = Math.floor(space / (count + 1))
  const keys: string[] = []
  for (let i = 1; i <= count; i++) {
    const slot = i * step
    keys.push(base36(slot % DIGITS.length === 0 ? slot + 1 : slot, width))
  }
  return keys
}
