/**
 * POD-4578 (Ha1) — `rebuildFromScratch` (L4b): the slice output recomputed
 * from the feed's CURRENT `snapshot(kind)` tables and `locals.get()`, with no
 * incremental state read or written.
 *
 * It replays the snapshot through the pool's own ingest (`tables.ts`) into
 * fresh maps with a fresh relation engine (`PoolRelations`: one replay, so no
 * history), and derives
 * every row with the same rule table (`views.ts` `PART_RULES` through
 * `directParts`, then `buildRowView`) as the live cells, with the clock and
 * selection read as plain values. Only the memo differs (none here, a cell
 * per part there), which is what the checker holds the live pool to.
 *
 * VISIBILITY (POD-4582, Hb1). The rows are the VISIBLE issues in L1b rank
 * order, decided from scratch by the same rule table the live cells run
 * (`worklist/visible.ts` `VISIBLE_RULES` through `directVisibleParts`,
 * memoized for this one pass), over EVERY row the feed holds: a cold row's
 * `flat` is computed from its data here, where the live parts take it from
 * the shared cold rule's bound (schema doc §5.1), so a cold row the rule
 * should have kept shown is a row-set difference. Residency no longer shapes
 * the row set: the live `snapshot()` loads what it reaches and settles
 * first, and every row here reads full data (`loading` is always false).
 * `resident` is accepted and unused (the checker's call shape).
 *
 * GROUPS (POD-4583, Hb2). The rebuild groups its own row views with L1b's
 * pure functions (`groupKeyOf`, `compareClosedFold`, `shared/src/row-view.ts`),
 * with no selection (the oracle's unselected baseline, spec §7), not with the
 * live layout's `layoutOf`: the live pool's placement cells and its layout
 * are held to the contract's own grouping.
 *
 * ROLL-UPS (POD-4584, Hb3). The same part functions over the same parts
 * object (`worklist/rollup.ts` `directRollupParts`, memoized per id for this
 * one pass), composing over the nest children inverted from scratch and the
 * scanned `children` relation: the live pool's maintained filings and its
 * per-node cells are held to a from-scratch answer. Every row is resident
 * here, so nothing is pending.
 *
 * WHOLE VIEWS (POD-4674, H3-F3). `rebuildSnapshot` projects each view to the
 * slice fields (`sliceRowOf`), so the checker never compares `activityAt`,
 * `originTick`, `selected` and the other view-only fields. `rebuildViews` is
 * the same run, keeping each whole `RowView`: the gate holds every visible
 * issue's live view to it at every compared step.
 */

import type { LocalsSource, RowSource } from '../../../shared/src/arm'
import {
  compareClosedFold,
  groupKeyOf,
  type RowView,
  sliceRowOf,
} from '@podium/client-graph/shared/row-view'
import { type ModelSchema, SCHEMA, tableColdRule } from '@podium/client-graph/shared/schema'
import type {
  SliceGroup,
  SliceIssue,
  SliceSession,
  SliceSnapshot,
} from '@podium/client-graph/shared/slice-types'
import type { RowRecord } from '../../../shared/src/stats'
import { PoolRelations } from './relations'
import { createTables, ingestOut, ingestRecord, type Tables } from './tables'
import {
  buildRowView,
  directParts,
  type RepoRow,
  sessionActivityOf,
  type ViewInputs,
} from './views'
import {
  directSessionParts,
  directVisibleParts,
  retainedSeatIdsOf,
  retentionOf,
  type SessionVisibleParts,
  sortByRank,
  type VisibleInputs,
  type VisibleParts,
} from './worklist/visible'
import {
  directRollupParts,
  type RollupInputs,
  type RollupSelf,
  seatVerdictOf,
} from './worklist/rollup'
import { repoLabelOf } from './worklist/groups'

export function rebuildSnapshot(
  source: RowSource,
  locals: LocalsSource,
  _resident?: ReadonlySet<string>,
  schema: ModelSchema = SCHEMA,
): SliceSnapshot {
  const { views, issue } = rebuildViewsWithIssue(source, locals, schema)
  const rowsById: SliceSnapshot['rowsById'] = {}
  const pinnedIds: string[] = []
  const groups = new Map<string, { group: SliceGroup; closed: RowView[] }>()
  for (const [id, view] of views) {
    rowsById[id] = sliceRowOf(view)
    const placement = groupKeyOf({ ...view, selected: false }, {})
    if (placement.section === 'pinned') {
      pinnedIds.push(id)
      continue
    }
    let entry = groups.get(placement.repoKey)
    if (entry === undefined) {
      const label = repoLabelOf((issue(id) as SliceIssue).repoPath)
      entry = { group: { key: placement.repoKey, label, rowIds: [], closedIds: [] }, closed: [] }
      groups.set(placement.repoKey, entry)
    }
    if (placement.lane === 'closed') entry.closed.push(view)
    else entry.group.rowIds.push(id)
  }
  const sliceGroups = [...groups.values()].map(({ group, closed }) => ({
    ...group,
    closedIds: closed.sort(compareClosedFold).map((view) => view.id),
  }))
  return { order: { pinnedIds, groups: sliceGroups }, rowsById }
}

/** The rebuild's rows as whole views: the visible issues, keyed by id, in rank order. */
export function rebuildViews(
  source: RowSource,
  locals: LocalsSource,
  schema: ModelSchema = SCHEMA,
): Map<string, RowView> {
  return rebuildViewsWithIssue(source, locals, schema).views
}

/**
 * Every RESIDENT issue's whole view from scratch (POD-4598, H3): the same
 * replayed tables and rule inputs as the snapshot rebuild, but over the ids
 * the pool holds (`resident`) rather than the visible order — cold rows the
 * pool never loaded stay out, exactly as the live `view(id)` they are held
 * to. The review probes' independent full-view check; never the live pool's
 * lazy cells.
 */
export function rebuildResidentViews(
  source: RowSource,
  locals: LocalsSource,
  resident: ReadonlySet<string>,
  schema: ModelSchema = SCHEMA,
): Map<string, RowView> {
  const { tables, relations, issues } = replayTables(source, schema)
  const { coarseNow, selectedIssueId } = locals.get()
  const { inputs } = directScope({ tables, relations, issues, coarseNow, selectedIssueId })
  const cold = tableColdRule(schema, (entity) => tables[entity], coarseNow)
  const views = new Map<string, RowView>()
  for (const { id } of issues) {
    if (!resident.has(id) && cold('issue', id)) continue
    const view = buildRowView(inputs, id, directParts(inputs, id))
    if (view !== undefined) views.set(id, view)
  }
  return views
}

/**
 * The from-scratch rule inputs over replayed tables: the `ViewInputs` the
 * live cells and the probes both run (`buildRowView`, `directParts`), with
 * the roll-up and visibility compositions computed directly (memoized for
 * the one pass), never through the live pool's lazy cells.
 */
interface DirectScope {
  readonly inputs: ViewInputs
  readonly visible: VisibleInputs
  rollupPartsOf(id: string): RollupSelf
  visiblePartsOf(id: string): VisibleParts
}

function directScope(args: {
  tables: Tables
  relations: PoolRelations
  issues: readonly RowRecord[]
  coarseNow: number
  selectedIssueId: string | null
}): DirectScope {
  const { tables, relations, issues, coarseNow, selectedIssueId } = args
  const inputs: ViewInputs = {
    relations,
    issue: (id) => tables.issue.get(id) as SliceIssue | undefined,
    session: (id) => tables.session.get(id) as SliceSession | undefined,
    repo: (id) => tables.repo.get(id) as RepoRow | undefined,
    sessionActivity: (id) => sessionActivityOf(tables.session.get(id) as SliceSession | undefined),
    present: (entity, id) => tables[entity].has(id),
    loading: () => false,
    parts: (id) => (tables.issue.has(id) ? directParts(inputs, id) : undefined),
    rollup: (id) => (tables.issue.has(id) ? rollupPartsOf(id).rollup : undefined),
    retainedSeats: (id) =>
      tables.issue.has(id)
        ? retainedSeatIdsOf(visible, id, directVisibleParts(visible, id, memo), false)
        : [],
    // POD-4708 — from scratch over the scanned relation (the live pool reads
    // its maintained SORTED mirror). The rebuild never counts; values equal
    // the live derivations' (both sorted), so L4b holds the maintenance to it.
    seats: (id) => relations.many('issue', id, 'sessions'),
    seatList: (id) => [...relations.many('issue', id, 'sessions')].sort(),
    selected: (id) => id === selectedIssueId,
    reached: (t) => coarseNow >= t,
    passed: (t) => coarseNow > t,
  }
  const memo = new Map<string, VisibleParts>()
  const rollupMemo = new Map<string, RollupSelf>()
  const sessions = new Map<string, SessionVisibleParts>()
  let nested: ReadonlyMap<string, readonly string[]> | null = null
  const rollupInputs: RollupInputs = {
    loadedIssue: (id) => tables.issue.get(id) as SliceIssue | undefined,
    progressFacts: (id) => {
      const row = tables.issue.get(id) as SliceIssue | undefined
      return row === undefined ? undefined : { stage: row.stage, closedReason: row.closedReason }
    },
    spinOffCount: (id) => relations.size('issue', id, 'spinOffs'),
    nested: (id) => {
      nested ??= directNested(
        issues.map(({ id }) => id),
        (issueId) => directVisibleParts(visible, issueId, memo),
      )
      return nested.get(id) ?? []
    },
    // The scanned `children` relation, from scratch (the live pool files each node's parent slot).
    formalChildren: (id) =>
      tables.issue.has(id) ? directVisibleParts(visible, id, memo).childIds : [],
    rollupNode: (id) => (tables.issue.has(id) ? rollupPartsOf(id) : undefined),
    seat: (id) => {
      const row = tables.session.get(id) as SliceSession | undefined
      return row === undefined ? undefined : seatVerdictOf(row)
    },
    seatActivity: (id) =>
      sessionActivityOf(tables.session.get(id) as SliceSession | undefined),
    presence: (id) => {
      const retention = retentionOf(tables.session.get(id) as SliceSession | undefined)
      return retention === null
        ? null
        : { issueId: retention.issueId, open: !retention.archived && !retention.exited }
    },
    spinOffIds: (id) => [...relations.many('issue', id, 'spinOffs')].sort(),
    counted: () => {},
  }
  function rollupPartsOf(id: string): RollupSelf {
    const parts = directVisibleParts(visible, id, memo)
    return directRollupParts(
      rollupInputs,
      id,
      rollupMemo,
      {
        present: parts.present,
        finished: parts.standing?.finished,
        rosterIds: retainedSeatIdsOf(visible, id, parts, true),
        seatIds: parts.seatIds,
      },
    )
  }
  const visible: VisibleInputs = {
    relations,
    resident: (entity, id) => tables[entity].has(id),
    issueRow: inputs.issue,
    sessionRow: inputs.session,
    issue: (id) => (tables.issue.has(id) ? directVisibleParts(visible, id, memo) : undefined),
    session: (id) => {
      if (!tables.session.has(id)) return undefined
      let parts = sessions.get(id)
      if (parts === undefined) {
        parts = directSessionParts(visible, id)
        sessions.set(id, parts)
      }
      return parts
    },
    sessionActivity: inputs.sessionActivity,
    own: (id) => directParts(inputs, id).own,
    // POD-4708 — from scratch (the live pool reads its maintained SORTED
    // mirror). The rebuild never counts; L4b holds the maintenance to it.
    seats: (id) => relations.many('issue', id, 'sessions'),
    seatList: (id) => [...relations.many('issue', id, 'sessions')].sort(),
    passed: inputs.passed,
  }
  return { inputs, visible, rollupPartsOf, visiblePartsOf: (id) => directVisibleParts(visible, id, memo) }
}

function replayTables(
  source: RowSource,
  schema: ModelSchema,
): { tables: Tables; relations: PoolRelations; issues: RowRecord[] } {
  const tables = createTables()
  const relations = new PoolRelations({
    schema,
    rows: tables,
    roots: tables,
    present: (entity, id) => tables[entity].has(id),
  })
  const target = { read: tables, write: tables, relations }
  const out = ingestOut()
  const issues = source.snapshot('issue')
  for (const record of source.snapshot('session')) ingestRecord(target, record, out)
  for (const record of issues) ingestRecord(target, record, out)
  for (const record of source.snapshot('worktree')) ingestRecord(target, record, out)
  return { tables, relations, issues }
}

function rebuildViewsWithIssue(
  source: RowSource,
  locals: LocalsSource,
  schema: ModelSchema = SCHEMA,
): { views: Map<string, RowView>; issue: ViewInputs['issue'] } {
  const { tables, relations, issues } = replayTables(source, schema)
  const { coarseNow, selectedIssueId } = locals.get()
  const scope = directScope({ tables, relations, issues, coarseNow, selectedIssueId })
  const { inputs } = scope
  const order = sortByRank(
    issues.map(({ id }) => id).filter((id) => scope.visiblePartsOf(id).visible),
    (id) => scope.visiblePartsOf(id).rank,
  )
  const views = new Map<string, RowView>()
  for (const id of order) {
    const view = buildRowView(inputs, id, directParts(inputs, id))
    if (view !== undefined) views.set(id, view)
  }
  return { views, issue: inputs.issue }
}

/**
 * The nest children of every present issue, from scratch: each issue's
 * `nestParent`, inverted. The live pool files each node's parent the same
 * way, one move at a time.
 */
function directNested(
  ids: Iterable<string>,
  partsOf: (id: string) => VisibleParts,
): ReadonlyMap<string, readonly string[]> {
  const nested = new Map<string, string[]>()
  for (const id of ids) {
    const parent = partsOf(id).nestParent
    if (parent === null) continue
    const children = nested.get(parent)
    if (children === undefined) nested.set(parent, [id])
    else children.push(id)
  }
  return nested
}
