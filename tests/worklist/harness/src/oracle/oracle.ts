import { fixtureGitStates, fixtureMarkers } from '../fixture/normalized-issues'
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
import { dedupeSessions } from '@podium/client-graph/diagnostics/reference-state'
import type { ReferenceState as Store } from '@podium/client-graph/diagnostics/reference-state'
import type { Replica } from '@podium/client-core/replica'

import { allIssueViewModels } from '@podium/client-graph/diagnostics/reference/issue-view-models'
import { groupUnifiedWorkRows, indexMissionSessions, issueDisplayTitle, missionRollup, rowHasWorkingSession, rowInClosedFold, rowMotionPhase, rowWaitingCount, splitPinnedWork, type UnifiedIssueRow, type UnifiedWorkRow, unifiedRowBand } from '@podium/client-core/values'
import { worklistSlice } from '@podium/client-graph/diagnostics/reference/worklist'
import {
  type LegacyDerivation,
  legacyDerivationFromStore,
  visibleIssueRows,
} from '@podium/client-graph/diagnostics/legacy'
import type {
  SliceGroup,
  SliceLocals,
  SliceOrder,
  SliceRow,
  SliceSnapshot,
} from '@podium/client-graph/shared/slice-types'
import type { FixtureCorpus } from '../fixture/index'

export {
  type LegacyDerivation,
  legacyDerivationFromStore,
  visibleIssueRows,
} from '@podium/client-graph/diagnostics/legacy'

function stubReplica(corpus: FixtureCorpus): Replica {
  const byKind = {
    issueProjections: corpus.issueProjections,
    issueUserStates: corpus.issueUserStates ?? fixtureMarkers(corpus.issues),
    issueGitStates: corpus.issueGitStates ?? fixtureGitStates(corpus.issues),
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
  // The runtime's session list collapses all-parked resume twins
  // (`runtime.ts:465` and `:1172` through `dedupeSessions`, optimism.ts:875);
  // its replica keeps every row, so the stub replica stays raw (POD-4551).
  const sessions = dedupeSessions(corpus.sessions)
  const store = {
    replica,
    issues: corpus.issues,
    issueProjections: corpus.issueProjections,
    issueUserStates: replica.rows('issueUserStates'),
    repos: corpus.repos,
    machines: corpus.machines,
    sessions,
    pins: corpus.pins,
    coarseNow: locals.coarseNow,
  } as unknown as Store<PodiumClientApi>
  const slice = worklistSlice.derive(store)
  // The same shared model cache the slice derived from: identical inputs, so
  // the progress fallback below reads the same objects, never a rebuild.
  const models = allIssueViewModels(
    replica,
    corpus.issueProjections,
    replica.rows('issueUserStates'),
  )
  return { slice, models, sessions, allWorktreePaths: slice.allWorktreePaths }
}

function projectRow(
  row: UnifiedIssueRow,
  derivation: LegacyDerivation,
  locals: SliceLocals,
  sessionIndex: () => ReturnType<typeof indexMissionSessions>,
): SliceRow {
  const { models, sessions, allWorktreePaths } = derivation
  const rollup = row.missionRollup ?? missionRollup(models, sessions, row.issue.id, sessionIndex())
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
  const flat = visibleIssueRows(derivation, locals)
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
  // The progress fallback's session index, built once per projection: a
  // pure function of the sessions, so one index serves every row. Rebuilt
  // per nested row it cost O(rows x sessions), 76% of the oracle's time on
  // the live-shaped fixture (POD-4635: 460 nested rows at 1x, was 65).
  let index: ReturnType<typeof indexMissionSessions> | undefined
  const sessionIndex = () => {
    index ??= indexMissionSessions(derivation.sessions)
    return index
  }
  for (const row of flat) {
    rowsById[row.issue.id] = projectRow(row, derivation, locals, sessionIndex)
  }
  return { order, rowsById }
}

/**
 * The flat slice: one legacy row per visible issue, in legacy banded order.
 * Worktree rows have no slice rendering and are dropped before ordering. The
 * row-view oracle (`row-views.ts`) projects the same rows.
 */
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
 * ONE CLOCK (POD-4559): `locals.coarseNow`, for the derivation AND the
 * projection. It used to derive with `store.coarseNow` and project with the
 * caller's, so a caller whose clock differed from the store's got a snapshot
 * built on two clocks (`one-clock.test.ts`).
 */
export function snapshotFromStore(
  store: Store<PodiumClientApi>,
  locals: SliceLocals,
): SliceSnapshot {
  return projectSnapshot(legacyDerivationFromStore(store, locals.coarseNow), locals)
}

/**
 * The legacy derivation over a LIVE engine store (`snapshotFromStore` and the
 * row-view oracle project it), at `coarseNow` (default: the store's own
 * clock). Model resolution mirrors `runLegacyDerivation`'s store assembly: the
 * shared issue-view cache when a replica and projections are present, else the
 * store's own issue rows (the POD-1053 fallback inside the slice).
 */
/**
 * POD-4556 (L4b) — the parity oracle over a live store at the store's own
 * clock, unselected baseline (spec §7).
 */
export function oracleSnapshot(store: Store<PodiumClientApi>): SliceSnapshot {
  return snapshotFromStore(store, { selectedIssueId: null, coarseNow: store.coarseNow })
}

/** The store fields the derivation reads as whole collections. */
const STORE_COLLECTIONS = new Set([
  'issues',
  'issueProjections',
  'repos',
  'machines',
  'sessions',
  'pins',
])

/**
 * POD-4556 (L4b) — {@link snapshotFromStore} with every legacy memo bypassed:
 * the same derivation and projection over COPIES of the store's collections and a fresh stub
 * replica holding copies of the live replica's rows. The per-replica issue
 * view-model cache (`issue-view-cache.ts`, reused row by row since POD-1053)
 * therefore starts empty, and no cache keyed on a collection's identity can
 * hit. Row objects are shared: they are server truth, not derived state. This
 * is the legacy control's `rebuildFromScratch`. One clock, `locals.coarseNow`,
 * as `snapshotFromStore`.
 */
export function rebuiltSnapshotFromStore(
  store: Store<PodiumClientApi>,
  locals: SliceLocals,
): SliceSnapshot {
  const live = store.replica
  const liveRows = (kind: string): readonly unknown[] | undefined =>
    (live?.rows as ((k: string) => readonly unknown[] | undefined) | undefined)?.call(live, kind)
  const rowCopies = new Map<string, unknown[]>()
  const replica = {
    rows: (kind: string) =>
      rowCopies.get(kind) ?? rowCopies.set(kind, [...(liveRows(kind) ?? [])]).get(kind),
    subscribeRows: () => () => {},
    batch: <T>(fn: () => T): T => fn(),
    persistent: true,
  } as unknown as Replica
  // One copy per collection, so two reads inside the derivation agree.
  const copies = new Map<string, unknown[]>()
  const fresh = new Proxy(store, {
    get(target, key, receiver) {
      if (key === 'replica') return replica
      if (key === 'coarseNow') return locals.coarseNow
      const value: unknown = Reflect.get(target, key, receiver)
      if (typeof key !== 'string' || !STORE_COLLECTIONS.has(key) || !Array.isArray(value))
        return value
      let copy = copies.get(key)
      if (copy === undefined) {
        copy = [...value]
        copies.set(key, copy)
      }
      return copy
    },
  })
  return projectSnapshot(legacyDerivationFromStore(fresh), locals)
}
