import {
  FLIGHT_DECK_FULL_COMPACT_WIDTH_KEY,
  FLIGHT_DECK_FULL_DISPLAY_KEY,
  FLIGHT_DECK_FULL_EXPANDED_WIDTH_KEY,
  FLIGHT_DECK_FULL_WIDTH_KEY,
} from '@podium/client-core/ui-state'
import type { IssueNavigationModel } from '@podium/client-core/values'

/** The dormant waterfall view's density. Full has no modes (POD-6245). */
export type FlightDeckDisplay = 'compact' | 'expanded'

export const FLIGHT_DECK_COMPACT_WIDTH = 366

/**
 * ONE WIDTH, RESIZED FREELY (POD-6245). Full used to have a compact and a wide
 * mode, each with its own saved width and its own range (300–620 and
 * 540–1120), so a wide deck could not be dragged narrow and a compact one
 * could not be dragged wide. The panel now has one range; its rows shed
 * optional slots by the panel's own width, so no mode is needed to fit.
 */
export const FLIGHT_DECK_SIZING = {
  storageKey: FLIGHT_DECK_FULL_WIDTH_KEY,
  min: 300,
  max: 1600,
  defaultWidth: FLIGHT_DECK_COMPACT_WIDTH,
} as const

function validWidth(raw: string | null): number | null {
  if (raw === null || raw.trim() === '') return null
  const width = Number(raw)
  return Number.isFinite(width) &&
    width >= FLIGHT_DECK_SIZING.min &&
    width <= FLIGHT_DECK_SIZING.max
    ? width
    : null
}

/** The saved width. Before the single width exists, seed it from the mode the
 * user last used, so the deck opens at the width it had. Never writes. */
export function readFlightDeckWidth(get: (key: string) => string | null): number {
  const own = validWidth(get(FLIGHT_DECK_FULL_WIDTH_KEY))
  if (own !== null) return own
  const legacy =
    get(FLIGHT_DECK_FULL_DISPLAY_KEY) === 'expanded'
      ? FLIGHT_DECK_FULL_EXPANDED_WIDTH_KEY
      : FLIGHT_DECK_FULL_COMPACT_WIDTH_KEY
  return validWidth(get(legacy)) ?? FLIGHT_DECK_SIZING.defaultWidth
}

export function isComplexFlightDeckMission(
  issue: Pick<IssueNavigationModel, 'type' | 'childCount'> | null | undefined,
): boolean {
  // No `epic` type any more (POD-6106): a mission's size alone makes it complex.
  return Boolean(issue && issue.childCount >= 6)
}
