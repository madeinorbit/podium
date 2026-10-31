import {
  FLIGHT_DECK_FULL_COMPACT_WIDTH_KEY,
  FLIGHT_DECK_FULL_EXPANDED_WIDTH_KEY,
} from '@podium/client-core/ui-state'
import type { IssueNavigationModel } from '@podium/client-core/values'

export type FlightDeckDisplay = 'compact' | 'expanded'

export const FLIGHT_DECK_COMPACT_WIDTH = 366

export function flightDeckSizing(display: FlightDeckDisplay) {
  const expanded = display === 'expanded'
  return {
    storageKey: expanded ? FLIGHT_DECK_FULL_EXPANDED_WIDTH_KEY : FLIGHT_DECK_FULL_COMPACT_WIDTH_KEY,
    min: expanded ? 540 : 300,
    max: expanded ? 1120 : 620,
    defaultWidth: expanded ? 900 : FLIGHT_DECK_COMPACT_WIDTH,
  }
}

export function readFlightDeckWidth(raw: string | null, display: FlightDeckDisplay): number {
  const sizing = flightDeckSizing(display)
  const width = Number(raw)
  return Number.isFinite(width) && width >= sizing.min && width <= sizing.max
    ? width
    : sizing.defaultWidth
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
