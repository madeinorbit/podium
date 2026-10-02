/** Plain, transient evaluation of the hand arm's worklist rule tables.
 * Only the compact result survives a filing run; getter memos are discarded. */
import type { RowView } from '@podium/client-graph/shared/row-view'
import type { SliceIssue, SliceSession } from '@podium/client-graph/shared/slice-types'
import { buildRowView, directParts, sessionActivityOf, type ViewInputs, type RepoRow } from '../../hand/pool/views'
import { directSessionParts, directVisibleParts, retainedSeatIdsOf, retentionOf, sortByRank, type SessionVisibleParts, type VisibleParts, type VisibleInputs, type HiddenIssue } from '../../hand/pool/worklist/visible'
import { directRollupParts, seatVerdictOf, type RollupInputs, type RollupSelf } from '../../hand/pool/worklist/rollup'
import { LOADING, type LeanPool } from './pool'
import { SCHEMA, allRelations } from '@podium/client-graph/shared/schema'
import { isLinkSpec, relationRef } from '../../hand/pool/relations'

function scopeOf(pool: LeanPool) {
  const tables = pool.fenced
  // A transient fold over DECLARED cold summaries supplies formal progress.
  // No unloaded row is inserted in the pool's maintained relation indexes;
  // these summary groups die with this filing run (they are not in its result).
  const summaryGroups = new Map<string, Map<string, Set<string>>>()
  const summaryForward = new Map<string, Map<string, string>>()
  for (const { from, name, relation } of allRelations()) {
    if (!isLinkSpec(relation) || relation.kind === 'prefix') continue
    const groups = new Map<string, Set<string>>()
    const forward = new Map<string, string>()
    for (const id of pool.residency.ids(from)) {
      const summary = pool.row(from, id, 'summary') as Record<string, unknown> | undefined
      if (!summary || (relation.where && !relation.where.test(summary))) continue
      const target = relationRef(relation, summary, SCHEMA)
      if (target === null) continue
      forward.set(id, target)
      const members = groups.get(target) ?? new Set<string>()
      members.add(id); groups.set(target, members)
    }
    summaryGroups.set(`${relation.to}.${relation.inverse}`, groups)
    summaryForward.set(`${from}.${name}`, forward)
  }
  const relations: ViewInputs['relations'] = {
    one: (from, id, name) => pool.relations.one(from, id, name) ?? summaryForward.get(`${from}.${name}`)?.get(id) ?? null,
    many: (from, id, name) => new Set([...pool.relations.many(from, id, name), ...(summaryGroups.get(`${from}.${name}`)?.get(id) ?? [])]),
    size: (from, id, name) => pool.relations.size(from, id, name) + (summaryGroups.get(`${from}.${name}`)?.get(id)?.size ?? 0),
    subset: (from, id, name, subset) => pool.relations.subset(from, id, name, subset),
  }
  const issues = [...tables.issue.keys()].map((id) => ({ id }))
  const { coarseNow, selectedIssueId } = pool.locals.get()
  const inputs: ViewInputs = {
    relations,
    issue: (id) => pool.row('issue', id, 'summary') as SliceIssue | undefined,
    session: (id) => pool.row('session', id, 'summary') as SliceSession | undefined,
    repo: (id) => pool.row('repo', id, 'summary') as RepoRow | undefined,
    sessionActivity: (id) => sessionActivityOf(pool.row('session', id, 'summary') as SliceSession | undefined),
    present: (entity, id) => tables[entity].has(id),
    loading: (entity, id) => { const value = pool.row(entity, id); return value === LOADING },
    parts: (id) => (pool.known('issue', id) ? directParts(inputs, id) : undefined),
    rollup: (id) => (pool.known('issue', id) ? rollupPartsOf(id).rollup : undefined),
    retainedSeats: (id) =>
      pool.known('issue', id)
        ? retainedSeatIdsOf(visible, id, directVisibleParts(visible, id, memo), false)
        : [],
    selected: (id) => id === selectedIssueId,
    reached: (t) => coarseNow >= t,
    passed: (t) => coarseNow > t,
  }
  const memo = new Map<string, VisibleParts>()
  const rollupMemo = new Map<string, RollupSelf>()
  const sessions = new Map<string, SessionVisibleParts>()
  let nested: ReadonlyMap<string, readonly string[]> | null = null
  const rollupInputs: RollupInputs = {
    loadedIssue: (id) => pool.row('issue', id, 'summary') as SliceIssue | undefined,
    progressFacts: (id) => {
      const row = pool.row('issue', id, 'summary') as SliceIssue | undefined
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
      pool.known('issue', id) ? directVisibleParts(visible, id, memo).childIds : [],
    rollupNode: (id) => (pool.known('issue', id) ? rollupPartsOf(id) : undefined),
    seat: (id) => {
      const row = pool.row('session', id, 'summary') as SliceSession | undefined
      return row === undefined ? undefined : seatVerdictOf(row)
    },
    seatActivity: (id) =>
      sessionActivityOf(pool.row('session', id, 'summary') as SliceSession | undefined),
    presence: (id) => {
      const retention = retentionOf(pool.row('session', id, 'summary') as SliceSession | undefined)
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
    hidden: (id) => pool.residency.hidden('issue', id) ? pool.row('issue', id, 'summary') as HiddenIssue : undefined,
    loadIssue: (id) => { pool.row('issue', id) },
    sessionRow: inputs.session,
    issue: (id) => (pool.known('issue', id) ? directVisibleParts(visible, id, memo) : undefined),
    session: (id) => {
      if (!pool.known('session', id)) return undefined
      let parts = sessions.get(id)
      if (parts === undefined) {
        parts = directSessionParts(visible, id)
        sessions.set(id, parts)
      }
      return parts
    },
    sessionActivity: inputs.sessionActivity,
    own: (id) => directParts(inputs, id).own,
    passed: inputs.passed,
  }
  return { inputs, visible, rollupPartsOf, visiblePartsOf: (id: string) => directVisibleParts(visible, id, memo) }
}

/** One filing derivation, with plain facts for whole-list consumers. */
export function derive(pool: LeanPool): { order: readonly string[]; views: Map<string, RowView> } {
  const scope = scopeOf(pool)
  const order = sortByRank([...pool.fenced.issue.keys()].filter((id) => scope.visiblePartsOf(id).visible), (id) => scope.visiblePartsOf(id).rank)
  const views = new Map<string, RowView>()
  for (const id of pool.mounted.keys()) {
    const view = buildRowView(scope.inputs, id, directParts(scope.inputs, id))
    if (view) views.set(id, view)
  }
  return { order, views }
}

function directNested(ids: Iterable<string>, partsOf: (id: string) => VisibleParts): ReadonlyMap<string, readonly string[]> {
  const nested = new Map<string, string[]>()
  for (const id of ids) {
    const parent = partsOf(id).nestParent
    if (parent === null) continue
    const children = nested.get(parent)
    if (children) children.push(id)
    else nested.set(parent, [id])
  }
  return nested
}
