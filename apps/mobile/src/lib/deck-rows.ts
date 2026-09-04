import {
  type FlightDeckFoldMap,
  type FlightDeckRow,
  flightDeckRowIsFolded,
} from '@podium/client-core/viewmodels'
import { BAND_H, PROPOSED_H, STRIP_H } from '../components/spine'
import { space } from '../theme/theme'

/**
 * The Flight Deck's phone-only display rules [POD-592].
 *
 * Everything else the deck shows comes from the shared mission module. This
 * exists because the phone renders the spine differently from the desktop: the
 * fold is applied to a flat list here rather than by a second tree walk — and
 * because the phone's deck is a PANEL whose height is decided from that same
 * flat list (`deckContentHeight` below), which the desktop's fixed column
 * never has to do.
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
  folds: FlightDeckFoldMap,
): FlightDeckRow[] {
  const out: FlightDeckRow[] = []
  let hideBelow: number | null = null
  for (const row of rows) {
    if (hideBelow !== null && row.depth > hideBelow) continue
    hideBelow = null
    out.push(row)
    if (flightDeckRowIsFolded(row, folds)) hideBelow = row.depth
  }
  return out
}

/**
 * THE PANEL IS AS TALL AS THE MISSION, NOT AS TALL AS THE SCREEN.
 *
 * The deck used to claim 62% of the window whatever it held, so a two-item
 * mission opened a two-thirds-screen panel that was mostly dark ground. The
 * spine's rows are fixed-height by design (`STRIP_H`, `BAND_H`, `PROPOSED_H`
 * are touch-target constants, not measurements), so the panel's natural height
 * is ARITHMETIC over the rows the deck is about to render — no `onLayout`
 * round trip, no first frame at the wrong size. The tail cards and the empty
 * state are the one place this is an estimate rather than a fact (their copy
 * wraps); an estimate only errs into a little internal scroll, never into a
 * broken gesture, because the open/close physics read whatever height was
 * decided.
 */

/** The controls row: 32pt segmented bar inside its top/bottom padding. */
const CONTROLS_H = 32 + space.sm + space.md
/** The scroller's own chrome: the top rail lead-in plus the bottom padding. */
const SCROLL_CHROME_H = space.sm + space.xl
/** A `DeckSection` head: top margin, the 9pt label line, gap before the body. */
const SECTION_HEAD_H = space.md + 14 + space.sm
/** The section body's gap, charged per row (over by one gap per section, which
 *  errs toward air rather than scroll). */
const SECTION_GAP = 6
/** `styles.departure` minHeight in MissionDeck. */
const DEPARTURE_H = 38
/** A signpost card (continuation / retired): margins, padding, a title line,
 *  two detail lines, and the action row. Estimated — the copy wraps. */
const SIGNPOST_H = 2 * space.lg + 2 * space.md + 20 + 39 + space.sm + 32
/** `EmptyState`: its double-xxl vertical padding around one title line. */
const EMPTY_STATE_H = 2 * (space.xxl * 2) + 20
/** The panel's grab edge under the deck (MissionScreen draws it). */
export const DECK_GRAB_H = 22
/** Never open as a sliver: the controls plus a couple of task strips. */
const PANEL_MIN_H = CONTROLS_H + SCROLL_CHROME_H + 2 * STRIP_H + DECK_GRAB_H

/** What the deck is about to render, counted — the input to the arithmetic. */
export interface DeckTally {
  /** Task strips in the spine. */
  strips: number
  /** Session bands: the root's plus every unfolded strip's. */
  bands: number
  /** Rows in the Proposed tail. */
  proposals: number
  /** Rows in the "Where the work went" tail. */
  departures: number
  /** Signpost cards — the continuation card and the retired card. */
  signposts: number
  /** `DeckSection` regions rendered (Proposed, Where the work went). */
  sections: number
  /** The deck is empty and says so with an `EmptyState`. */
  empty: boolean
}

/** The deck's natural height: its controls plus everything in its scroller. */
export function deckContentHeight(tally: DeckTally): number {
  return (
    CONTROLS_H +
    SCROLL_CHROME_H +
    tally.strips * STRIP_H +
    tally.bands * BAND_H +
    tally.proposals * (PROPOSED_H + SECTION_GAP) +
    tally.departures * (DEPARTURE_H + SECTION_GAP) +
    tally.signposts * SIGNPOST_H +
    tally.sections * SECTION_HEAD_H +
    (tally.empty ? EMPTY_STATE_H : 0)
  )
}

/**
 * The panel height the mission screen animates to: the deck's natural height
 * plus the grab edge, floored at {@link PANEL_MIN_H} and capped at `maxHeight`
 * (the historical 62% of the window — beyond it the deck scrolls internally).
 * `null` means the deck has not reported yet; the cap is the safe answer, and
 * the first report lands while the panel is still shut.
 */
export function deckPanelHeight(contentHeight: number | null, maxHeight: number): number {
  if (contentHeight === null) return maxHeight
  return Math.min(maxHeight, Math.max(PANEL_MIN_H, contentHeight + DECK_GRAB_H))
}
