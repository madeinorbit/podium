/**
 * POD-4443 — parity oracle: the exact rows, order and groups the current app
 * would show for a fixture corpus.
 *
 * The oracle IS the legacy code: it builds the minimal `Store` the published
 * worklist slice reads (a stub `Replica` over the corpus rows plus the corpus
 * arrays), runs `worklistSlice.derive`, and projects the result onto the
 * frozen `SliceSnapshot` (see `README.md` for the projection table). Nothing
 * is hand-written; an arm passes parity iff it produces this snapshot.
 */

import type { PodiumClientApi } from '@podium/client-core/api'
import type { Store } from '@podium/client-core/engine'
import type { Replica } from '@podium/client-core/replica'
import { allIssueViewModels } from '@podium/client-core/replica'
import {
  groupUnifiedWorkRows,
  indexMissionSessions,
  issueDisplayTitle,
  missionRollup,
  rowHasWorkingSession,
  rowInClosedFold,
  rowMotionPhase,
  rowWaitingCount,
  sortUnifiedWorkRows,
  splitPinnedWork,
  unifiedRowBand,
  type IssueNavigationModel,
  type UnifiedIssueRow,
  type UnifiedWorkRow,
  type WorklistSlice,
  worklistSlice,
} from '@podium/client-core/viewmodels'
import type { SessionMeta } from '@podium/model'
import type {
  SliceGroup,
  SliceLocals,
  SliceOrder,
  SliceRow,
  SliceSnapshot,
} from '../../../shared/src/slice-types'
import type { FixtureCorpus } from '../fixture/index'

/** The legacy derivation output plus the inputs the projection needs. */
export interface LegacyDerivation {
  slice: WorklistSlice
  models: IssueNavigationModel[]
  sessions: SessionMeta[]
  allWorktreePaths: string[]
}

function stubReplica(corpus: FixtureCorpus): Replica {
  const byKind = {
    issueProjections: corpus.issueProjections,
    issues: corpus.issues,
    repos: corpus.repoProjections,
    issueDeps: corpus.issueDeps,
    sessions: corpus.sessions,
  }
  return {
    rows: ((kind: keyof typeof byKind) => byKind[kind] ?? []) as Replica['rows'],
    subscribeRows: () => () => {},
    batch: <T>(fn: () => T): T => fn(),
    persistent: true,
  } as unknown as Replica
}

/**
 * Run the legacy published worklist derivation against the corpus.
 *
 * Option (b) from the issue plan: construct the `Store` object directly with
 * the fields `worklistSlice.derive` reads, instead of booting a kernel
 * replica + `ClientRuntime`. Less code, same derivation — `derive` reads
 * `replica`, `issues`, `issueProjections`, `repos`, `machines`, `sessions`,
 * `pins` and `coarseNow`, and nothing else.
 */
export function runLegacyDerivation(corpus: FixtureCorpus, locals: SliceLocals): LegacyDerivation {
  const replica = stubReplica(corpus)
  const store = {
    replica,
    issues: corpus.issues,
    issueProjections: corpus.issueProjections,
    repos: corpus.repos,
    machines: corpus.machines,
    sessions: corpus.sessions,
    pins: corpus.pins,
    coarseNow: locals.coarseNow,
  } as unknown as Store<PodiumClientApi>
  const slice = worklistSlice.derive(store)
  // The same shared model cache the slice derived from: identical inputs, so
  // the progress fallback below reads the same objects, never a rebuild.
  const models = allIssueViewModels(replica, corpus.issueProjections, corpus.issues)
  return { slice, models, sessions: corpus.sessions, allWorktreePaths: slice.allWorktreePaths }
}

/** Every nested descendant as its own row, pre-order (parent before child). */
function flattenIssueRows(rows: UnifiedWorkRow[]): UnifiedIssueRow[] {
  const out: UnifiedIssueRow[] = []
  const visit = (row: UnifiedWorkRow): void => {
    if (row.kind !== 'issue') return
    out.push(row)
    for (const child of row.startedByChildren ?? []) visit(child)
  }
  for (const row of rows) visit(row)
  return out
}

function projectRow(
  row: UnifiedIssueRow,
  derivation: LegacyDerivation,
  locals: SliceLocals,
): SliceRow {
  const { models, sessions, allWorktreePaths } = derivation
  const rollup =
    row.missionRollup ?? missionRollup(models, sessions, row.issue.id, indexMissionSessions(sessions))
  const band = unifiedRowBand(row, locals.coarseNow)
  return {
    id: row.issue.id,
    displayRef: row.issue.displayRef ?? `#${row.issue.seq}`,
    title: issueDisplayTitle(row.issue, sessions, allWorktreePaths),
    phase: rowMotionPhase(row),
    progressDone: rollup.progress.done,
    progressTotal: rollup.progress.total,
    working: rowHasWorkingSession(row),
    asking: rowWaitingCount(row) > 0,
    band: (band === 0 || band === 2 ? band : 1) as SliceRow['band'],
    repoKey: row.issue.repoId ?? row.issue.repoPath,
    closed: rowInClosedFold(row, null, false, locals.coarseNow),
  }
}

/**
 * The exact snapshot the current app would show for this corpus: rows, order
 * and groups. Deterministic in `(corpus, locals.coarseNow)`; selection stays
 * out (unselected baseline, spec §7).
 */
export function expectedSnapshot(corpus: FixtureCorpus, locals: SliceLocals): SliceSnapshot {
  return projectSnapshot(runLegacyDerivation(corpus, locals), locals)
}

/**
 * POD-4445 — project an already-derived legacy derivation onto the frozen
 * `SliceSnapshot`. `expectedSnapshot` is this over a fixture corpus; the G4
 * count harness calls this over a LIVE engine store (see `snapshotFromStore`)
 * so engine-backed arms and the legacy control check parity against the same
 * projection the fixture oracle uses. One projection, two inputs, no second
 * implementation to drift.
 */
export function projectSnapshot(derivation: LegacyDerivation, locals: SliceLocals): SliceSnapshot {
  // Flat slice: one row per visible issue, in legacy banded order. Worktree
  // rows have no slice rendering and are dropped before ordering.
  const flat = sortUnifiedWorkRows(
    flattenIssueRows(derivation.slice.work),
    locals.coarseNow,
  ).filter((row): row is UnifiedIssueRow => row.kind === 'issue')
  const { pinned, rest } = splitPinnedWork(flat)
  const pinnedIds = pinned.flatMap((row) => (row.kind === 'issue' ? [row.issue.id] : []))
  const restIndex = new Map(rest.map((row, index) => [rowKeyOf(row), index]))
  const groups: SliceGroup[] = groupUnifiedWorkRows(rest, null, false, locals.coarseNow).map(
    (group) => ({
      key: group.key,
      label: group.label,
      rowIds: [...group.rows, ...group.snoozedRows]
        .sort((a, b) => (restIndex.get(rowKeyOf(a)) ?? 0) - (restIndex.get(rowKeyOf(b)) ?? 0))
        .map((row) => rowKeyOf(row)),
      closedIds: group.closedRows.map((row) => row.issue.id),
    }),
  )
  const order: SliceOrder = { pinnedIds, groups }
  const rowsById: Record<string, SliceRow> = {}
  for (const row of flat) {
    rowsById[row.issue.id] = projectRow(row, derivation, locals)
  }
  return { order, rowsById }
}

function rowKeyOf(row: UnifiedWorkRow): string {
  return row.kind === 'issue' ? row.issue.id : row.worktree.path
}

/**
 * POD-4445 — the oracle projection over a LIVE engine store instead of a
 * fixture corpus. Runs the same `worklistSlice.derive` the app publishes and
 * projects it with the same `projectSnapshot` the fixture oracle uses, so an
 * engine-backed arm (or the legacy control) checks parity against exactly what
 * the current app shows for the engine's present state.
 *
 * Model resolution mirrors `runLegacyDerivation`'s store assembly: the shared
 * issue-view cache when a replica and projections are present, else the
 * store's own issue rows (the POD-1053 fallback inside the slice).
 */
export function snapshotFromStore(
  store: Store<PodiumClientApi>,
  locals: SliceLocals,
): SliceSnapshot {
  const replica = store.replica
  const projections = store.issueProjections ?? []
  const models =
    replica !== undefined && replica !== null && projections.length > 0
      ? allIssueViewModels(replica, projections, store.issues)
      : store.issues
  const slice = worklistSlice.derive(store)
  return projectSnapshot(
    {
      slice,
      models,
      sessions: store.sessions,
      allWorktreePaths: slice.allWorktreePaths,
    },
    locals,
  )
}
