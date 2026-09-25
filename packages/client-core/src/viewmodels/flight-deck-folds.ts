import { deckSessionFacts, deckTaskFacts, issueClosed, type FlightDeckRow } from './mission'

/** Explicit fold choices. Missing rows keep using the shared default. */
export type FlightDeckFoldState = 'open' | 'closed'
export type FlightDeckFoldMap = ReadonlyMap<string, FlightDeckFoldState>
export type DeckFoldKind = 'branch' | 'roster' | 'native'
export const deckFoldKey = (kind: DeckFoldKind, issueId: string, sessionId?: string): string =>
  `${kind}:${issueId}${sessionId ? `:${sessionId}` : ''}`

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
  const blob = parsed as { open?: unknown; closed?: unknown; branch?: unknown; roster?: unknown; native?: unknown }
  const folds = new Map<string, FlightDeckFoldState>()
  for (const id of idsIn(blob.open)) folds.set(id, 'open')
  for (const id of idsIn(blob.closed)) folds.set(id, 'closed')
  for (const kind of ['branch', 'roster', 'native'] as const) {
    const values = blob[kind]
    if (!values || typeof values !== 'object' || Array.isArray(values)) continue
    for (const [id, state] of Object.entries(values)) {
      if (state === 'open' || state === 'closed') folds.set(deckFoldKey(kind, id), state)
      if (kind === 'native' && state && typeof state === 'object' && !Array.isArray(state))
        for (const [sessionId, choice] of Object.entries(state))
          if (choice === 'open' || choice === 'closed') folds.set(deckFoldKey('native', id, sessionId), choice)
    }
  }
  return folds.size === 0 ? EMPTY_FOLDS : folds
}

export function writeFlightDeckFolds(folds: FlightDeckFoldMap): string | null {
  if (folds.size === 0) return null
  const open: string[] = []
  const closed: string[] = []
  const branch: Record<string, FlightDeckFoldState> = {}
  const roster: Record<string, FlightDeckFoldState> = {}
  const native: Record<string, Record<string, FlightDeckFoldState>> = {}
  for (const [id, state] of folds) {
    if (id.startsWith('branch:')) branch[id.slice(7)] = state
    else if (id.startsWith('roster:')) roster[id.slice(7)] = state
    else if (id.startsWith('native:')) {
      const [, issueId, ...sessionParts] = id.split(':')
      const sessionId = sessionParts.join(':')
      if (issueId && sessionId) (native[issueId] ??= {})[sessionId] = state
    } else (state === 'open' ? open : closed).push(id)
  }
  return JSON.stringify({ v: 2, open, closed, branch, roster, native })
}

/** Resolve old issue-wide folds on the first explicit write. Callers pass the
 * unfiltered tree and IDs whose child topology is fully hydrated. A recorded
 * descendant proves a branch even before the full slice resolves; absence
 * never proves a leaf. Keep every legacy entry as historical state alongside
 * its resolved category; explicit category choices take precedence on read. */
export function migrateResolvedDeckFolds(
  folds: FlightDeckFoldMap,
  rows: readonly Pick<FlightDeckRow, 'issue' | 'descendantIds'>[],
  resolvedIds: ReadonlySet<string> = new Set(),
): Map<string, FlightDeckFoldState> {
  const next = new Map(folds)
  for (const row of rows) {
    if (row.descendantIds.length === 0 && !resolvedIds.has(row.issue.id)) continue
    const legacy = folds.get(row.issue.id)
    if (!legacy) continue
    const kind = row.descendantIds.length > 0 ? 'branch' : 'roster'
    const key = deckFoldKey(kind, row.issue.id)
    if (!next.has(deckFoldKey('branch', row.issue.id)) && !next.has(deckFoldKey('roster', row.issue.id))) next.set(key, legacy)
  }
  return next
}

export function flightDeckBranchFolded(row: Pick<FlightDeckRow, 'issue' | 'descendantIds'>, folds: FlightDeckFoldMap): boolean {
  if (row.descendantIds.length === 0) return false
  return (folds.get(deckFoldKey('branch', row.issue.id)) ??
    (!folds.has(deckFoldKey('roster', row.issue.id)) ? folds.get(row.issue.id) : undefined)) === 'closed'
}

export function flightDeckRosterFolded(row: Pick<FlightDeckRow, 'issue' | 'descendantIds' | 'sessions'>, folds: FlightDeckFoldMap): boolean {
  const explicit = folds.get(deckFoldKey('roster', row.issue.id)) ??
    (row.descendantIds.length === 0 && !folds.has(deckFoldKey('branch', row.issue.id)) ? folds.get(row.issue.id) : undefined)
  return explicit === undefined ? (issueClosed(row.issue) || flightDeckRowDefaultFolded(row)) && !deckTaskFacts(row.issue, row.sessions).taskRequest && !row.sessions.some((session) => {
    const facts = deckSessionFacts(row.issue, session)
    return facts.running || facts.error !== null || facts.request
  }) : explicit === 'closed'
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
  return row.descendantIds.length > 0 ? flightDeckBranchFolded(row, folds) : flightDeckRosterFolded(row, folds)
}
