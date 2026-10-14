import type { IssueNavigationModel } from '@podium/client-core/values'

export type FlightDeckDisplay = 'compact' | 'expanded'

export const FLIGHT_DECK_COMPACT_WIDTH = 366
export const FLIGHT_DECK_EXPANDED_WIDTH = 680

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
