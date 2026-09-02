import type { IssueNavigationModel } from '@podium/client-core/viewmodels'

export type FlightDeckDisplay = 'compact' | 'expanded'

export const FLIGHT_DECK_COMPACT_WIDTH = 366
export const FLIGHT_DECK_EXPANDED_WIDTH = 680

export function isComplexFlightDeckMission(
  issue: Pick<IssueNavigationModel, 'type' | 'childCount'> | null | undefined,
): boolean {
  return Boolean(issue && (issue.type === 'epic' || issue.childCount >= 6))
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
