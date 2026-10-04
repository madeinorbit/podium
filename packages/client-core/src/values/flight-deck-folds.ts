import type { FlightDeckRow } from './mission'

/** Explicit fold choices. Missing rows keep using the shared default. */
export type FlightDeckFoldState = 'open' | 'closed'
export type FlightDeckFoldMap = ReadonlyMap<string, FlightDeckFoldState>

const EMPTY_FOLDS: FlightDeckFoldMap = new Map<string, FlightDeckFoldState>()

const idsIn = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((id): id is string => typeof id === 'string') : []

/** Read the current map and migrate the legacy array of closed ids. */
export function readFlightDeckFolds(raw: string | null): FlightDeckFoldMap {
  if (!raw) return EMPTY_FOLDS
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return EMPTY_FOLDS
  }
  if (Array.isArray(parsed)) {
    const legacy = idsIn(parsed)
    return legacy.length === 0
      ? EMPTY_FOLDS
      : new Map(legacy.map((id): [string, FlightDeckFoldState] => [id, 'closed']))
  }
  if (!parsed || typeof parsed !== 'object') return EMPTY_FOLDS
  const blob = parsed as { open?: unknown; closed?: unknown }
  const folds = new Map<string, FlightDeckFoldState>()
  for (const id of idsIn(blob.open)) folds.set(id, 'open')
  for (const id of idsIn(blob.closed)) folds.set(id, 'closed')
  return folds.size === 0 ? EMPTY_FOLDS : folds
}

export function writeFlightDeckFolds(folds: FlightDeckFoldMap): string | null {
  if (folds.size === 0) return null
  const open: string[] = []
  const closed: string[] = []
  for (const [id, state] of folds) (state === 'open' ? open : closed).push(id)
  return JSON.stringify({ v: 2, open, closed })
}

type FoldableRow = Pick<FlightDeckRow, 'issue' | 'descendantIds' | 'sessions'>

export function flightDeckRowHasPayload(
  row: Pick<FlightDeckRow, 'descendantIds' | 'sessions'>,
): boolean {
  return row.descendantIds.length > 0 || row.sessions.length > 0
}

/** A one-agent leaf arrives folded; real branches and rosters arrive open. */
export function flightDeckRowDefaultFolded(
  row: Pick<FlightDeckRow, 'descendantIds' | 'sessions'>,
): boolean {
  return row.descendantIds.length === 0 && row.sessions.length === 1
}

export function flightDeckRowIsFolded(row: FoldableRow, folds: FlightDeckFoldMap): boolean {
  const explicit = folds.get(row.issue.id)
  return explicit === undefined ? flightDeckRowDefaultFolded(row) : explicit === 'closed'
}
