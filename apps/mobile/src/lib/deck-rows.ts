import type { FlightDeckRow, PresenceNote } from '@podium/client-core/viewmodels'

/**
 * The Flight Deck's two phone-only display rules [POD-592].
 *
 * Everything else the deck shows comes from the shared mission module. These
 * two exist because the phone renders the spine differently from the desktop —
 * a fold is applied to a flat list here, and a strip carries state and note on
 * one subtitle line — so neither has a home in the shared derivation.
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

/** Presence kinds whose fact the strip's own state word already carries. */
const COVERED_KINDS = new Set<PresenceNote['kind']>(['blocked', 'waiting', 'done', 'review'])

/**
 * Should the presence line be suppressed under this strip?
 *
 * On the desktop the note has a column of its own. Here it sits directly under
 * a strip that has just printed the state word and, when there is one, the
 * issue note — so "Blocked by 2 tasks" would land immediately below
 * "Blocked · 2 tasks", and "Proposed · not started" below "Proposed". Two
 * adjacent lines saying one thing read as two facts; that is worse than not
 * saying it twice.
 *
 * The text comparison catches the second case without a kind list to maintain:
 * `proposed` and `backlog` share the `ready` kind but not their words.
 */
export function coveredByStrip(presence: PresenceNote, stateLabel: string): boolean {
  if (COVERED_KINDS.has(presence.kind)) return true
  return presence.text.toLowerCase().startsWith(stateLabel.toLowerCase())
}
