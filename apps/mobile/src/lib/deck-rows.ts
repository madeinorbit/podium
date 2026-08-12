import type { FlightDeckRow } from '@podium/client-core/viewmodels'

/**
 * The Flight Deck's one phone-only display rule [POD-592].
 *
 * Everything else the deck shows comes from the shared mission module. This
 * exists because the phone renders the spine differently from the desktop: the
 * fold is applied to a flat list here rather than by a second tree walk.
 *
 * `coveredByStrip` USED TO LIVE HERE and is gone (POD-767). It suppressed the
 * presence line under a strip whose state word had just said the same thing —
 * "Blocked by 2 tasks" landing directly below "Blocked · 2 tasks". There is no
 * presence line any more: the only presence the redesign draws is a HELD SEAT,
 * and it is a chip in the strip's own chip slot rather than a row beneath it.
 * `seatFor` in ../components/spine.tsx narrows to the two kinds that are
 * genuinely a held seat, which is the same suppression one level earlier and
 * without a text comparison.
 */

/**
 * Hide the descendants of every folded row.
 *
 * `buildFlightDeckRows` returns the spine FLAT with a depth on each row, so a
 * fold is a filter over that list rather than a second tree walk: once a folded
 * row is passed, drop everything deeper than it until the depth comes back to
 * its own. Nested folds fall out of this for free — the outer fold is still in
 * effect when the inner one's rows arrive.
 */
export function applyFolds(
  rows: readonly FlightDeckRow[],
  folded: ReadonlySet<string>,
): FlightDeckRow[] {
  if (folded.size === 0) return [...rows]
  const out: FlightDeckRow[] = []
  let hideBelow: number | null = null
  for (const row of rows) {
    if (hideBelow !== null && row.depth > hideBelow) continue
    hideBelow = null
    out.push(row)
    if (folded.has(row.issue.id)) hideBelow = row.depth
  }
  return out
}
