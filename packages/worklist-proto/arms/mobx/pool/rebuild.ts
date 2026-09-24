/**
 * POD-4565 (Ma1) — `rebuildFromScratch` (L4b): the slice output recomputed
 * from the feed's CURRENT `snapshot(kind)` tables and `locals.get()`, with no
 * incremental state read or written.
 *
 * It replays the snapshot through the pool's own ingest (`tables.ts`) into
 * fresh plain maps, resolves every relation FROM SCRATCH (`scanRelations`,
 * `enumerate.ts`: the declared resolvers over whole tables, none of the live
 * engine's maintenance), and derives every row with the same `buildRowView`
 * as the live models, with the clock and selection read as plain values. So
 * the checker holds the live pool's incremental relation maintenance to a
 * from-scratch resolution, and its derivations to themselves.
 *
 * VISIBILITY (POD-4569). The rows are the VISIBLE issues, decided from
 * scratch by the same part functions the live nodes memoize
 * (`worklist/visible.ts` `directVisibility`, memoized per id for this one
 * pass), over every row the feed holds, cold ones included; the pinned ids
 * in L1b rank order. So the live collection's maintenance (its reactions,
 * its cold-row reads, its node syncing) is held to a from-scratch answer.
 * Residency no longer shapes the row set: the live `snapshot()` loads every
 * visible cold row and settles first, and every row here reads full data
 * (`loading` is always false). `resident` is accepted and unused (the
 * checker's call shape).
 *
 * ROLL-UPS (POD-4571). The same part functions over the same parts object
 * (`directVisibility` memoizes them for this pass), composing over the nest
 * children inverted from scratch (`directNested`) and the scanned `children`
 * relation: the live pool's maintained nest index and its per-node memos are
 * held to a from-scratch answer. Every row is resident here, so nothing is
 * pending.
 *
 * GROUPS (POD-4570). The rebuild groups its own row views with L1b's pure
 * functions (`groupKeyOf`, `compareClosedFold`, `shared/src/row-view.ts`),
 * with no selection (the oracle's unselected baseline, spec §7), not with the
 * live layout's `layoutOf`: the live pool's placement parts and its layout
 * are held to the contract's own grouping.
 */

import type { LocalsSource, RowSource } from '../../../shared/src/arm'
import {
  compareClosedFold,
  groupKeyOf,
  type RowView,
  sliceRowOf,
} from '../../../shared/src/row-view'
import type {
  SliceGroup,
  SliceIssue,
  SliceSession,
  SliceSnapshot,
} from '../../../shared/src/slice-types'
import { scanRelations } from './enumerate'
import { createPlainTables, ingestOut, ingestRecord } from './tables'
import {
  buildRowView,
  directParts,
  type RepoRow,
  sessionActivityOf,
  type ViewInputs,
} from './views'
import {
  directNested,
  directSessionVisibility,
  directVisibility,
  type IssueVisibility,
  type SessionVisibility,
  sortByRank,
  type VisibleInputs,
} from './worklist/visible'
import { repoLabelOf } from './worklist/groups'

export function rebuildSnapshot(
  source: RowSource,
  locals: LocalsSource,
  _resident?: ReadonlySet<string>,
): SliceSnapshot {
  const tables = createPlainTables()
  const target = { read: tables, write: tables }
  const out = ingestOut()
  const issues = source.snapshot('issue')
  for (const record of source.snapshot('session')) ingestRecord(target, record, out)
  for (const record of issues) ingestRecord(target, record, out)
  for (const record of source.snapshot('worktree')) ingestRecord(target, record, out)

  const { coarseNow, selectedIssueId } = locals.get()
  const inputs: ViewInputs = {
    relations: scanRelations(tables),
    issue: (id) => tables.issue.get(id) as SliceIssue | undefined,
    session: (id) => tables.session.get(id) as SliceSession | undefined,
    sessionActivity: (id) => sessionActivityOf(tables.session.get(id) as SliceSession | undefined),
    repo: (id) => tables.repo.get(id) as RepoRow | undefined,
    present: (entity, id) => tables[entity].has(id),
    loading: () => false,
    parts: (id) => (tables.issue.has(id) ? directParts(inputs, id) : undefined),
    rollup: (id) => (tables.issue.has(id) ? directVisibility(visibleInputs, id, memo).rollup : undefined),
    selected: (id) => id === selectedIssueId,
    reached: (t) => coarseNow >= t,
    passed: (t) => coarseNow > t,
  }
  const memo = new Map<string, IssueVisibility>()
  const sessions = new Map<string, SessionVisibility>()
  let nested: ReadonlyMap<string, readonly string[]> | null = null
  const visibleInputs: VisibleInputs = {
    relations: inputs.relations,
    issueRow: inputs.issue,
    sessionRow: inputs.session,
    issue: (id) => (tables.issue.has(id) ? directVisibility(visibleInputs, id, memo) : undefined),
    session: (id) => {
      let parts = sessions.get(id)
      if (parts === undefined) {
        parts = directSessionVisibility(visibleInputs, id)
        sessions.set(id, parts)
      }
      return parts
    },
    passed: inputs.passed,
    reached: inputs.reached,
    loadedIssue: inputs.issue,
    loadedSession: inputs.session,
    nested: (id) => {
      nested ??= directNested(
        issues.map((record) => record.id),
        (issueId) => directVisibility(visibleInputs, issueId, memo),
      )
      return nested.get(id) ?? []
    },
    counted: () => {},
  }
  const visible = issues
    .map(({ id }) => id)
    .filter((id) => directVisibility(visibleInputs, id, memo).visible)
  const order = sortByRank(visible, (id) => directVisibility(visibleInputs, id, memo).rank)
  const rowsById: SliceSnapshot['rowsById'] = {}
  const pinnedIds: string[] = []
  const groups = new Map<string, { group: SliceGroup; closed: RowView[] }>()
  for (const id of order) {
    const view = buildRowView(inputs, id, directParts(inputs, id))
    if (view === undefined) continue
    rowsById[id] = sliceRowOf(view)
    const placement = groupKeyOf({ ...view, selected: false }, {})
    if (placement.section === 'pinned') {
      pinnedIds.push(id)
      continue
    }
    let entry = groups.get(placement.repoKey)
    if (entry === undefined) {
      const label = repoLabelOf((inputs.issue(id) as SliceIssue).repoPath)
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

/** The visible ids in rank order, from scratch (tests: the live `worklist.order` against it). */
export function rebuildOrder(source: RowSource, locals: LocalsSource): string[] {
  const snapshot = rebuildSnapshot(source, locals)
  return Object.keys(snapshot.rowsById)
}
