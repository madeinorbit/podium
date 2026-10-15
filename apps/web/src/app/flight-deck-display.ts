import type { IssueNavigationModel } from '@podium/client-core/values'
import {
  FLIGHT_DECK_EXPANDED_WIDTH_KEY,
  FLIGHT_DECK_FULL_COMPACT_WIDTH_KEY,
  FLIGHT_DECK_FULL_EXPANDED_WIDTH_KEY,
} from '@podium/client-core/ui-state'

export type FlightDeckDisplay = 'compact' | 'expanded'

export const FLIGHT_DECK_COMPACT_WIDTH = 366
export const FLIGHT_DECK_EXPANDED_WIDTH = 680

/** The existing development views retain their own saved widths and caps. */
export function flightDeckSizing(full: boolean, display: FlightDeckDisplay) {
  const expanded = display === 'expanded'
  return {
    storageKey: full
      ? expanded ? FLIGHT_DECK_FULL_EXPANDED_WIDTH_KEY : FLIGHT_DECK_FULL_COMPACT_WIDTH_KEY
      : expanded ? FLIGHT_DECK_EXPANDED_WIDTH_KEY : 'podium:superagent:width',
    min: expanded ? 540 : 300,
    max: expanded ? full ? 1120 : 760 : 620,
    defaultWidth: expanded ? full ? 900 : FLIGHT_DECK_EXPANDED_WIDTH : FLIGHT_DECK_COMPACT_WIDTH,
  }
}

export function readFlightDeckWidth(raw: string | null, full: boolean, display: FlightDeckDisplay): number {
  const sizing = flightDeckSizing(full, display)
  const width = Number(raw)
  return Number.isFinite(width) && width >= sizing.min && width <= sizing.max
    ? width : sizing.defaultWidth
}

export function isComplexFlightDeckMission(
  issue: Pick<IssueNavigationModel, 'type' | 'childCount'> | null | undefined,
): boolean {
  // No `epic` type any more (POD-6106): a mission's size alone makes it complex.
  return Boolean(issue && issue.childCount >= 6)
}

export function readFlightDeckDisplay(
  raw: string | null,
  complexMission: boolean,
): FlightDeckDisplay {
  if (raw === 'compact' || raw === 'expanded') return raw
  return complexMission ? 'expanded' : 'compact'
}

export function nextFlightDeckDisplayForSessionPick(
  current: FlightDeckDisplay,
  activeSessionId: string | null,
  pickedSessionId: string,
  permanent: boolean,
): FlightDeckDisplay {
  if (permanent || current === 'expanded') return 'compact'
  return activeSessionId === pickedSessionId ? 'expanded' : 'compact'
}
