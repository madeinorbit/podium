import { autorun, observable, runInAction } from 'mobx'
import { describe, expect, it } from 'vitest'
import { MobxPool } from '../pool'
import { LOADING } from './rollup'
import { worklistView } from './view-model'
import type { WorklistIssue } from './issue'
import { NO_SIDEBAR_SESSIONS } from './sidebar-row'

const stamp = '2026-10-08T12:00:00Z'
const issue = (id: string, patch: object = {}) => ({ id, seq: 1, title: id,
  stage: 'planning', audience: 'human', repoPath: '/synthetic', createdAt: stamp, updatedAt: stamp, ...patch })
const session = (id: string, owner: string, patch: object = {}) => ({ sessionId: id, issueId: owner,
  cwd: '/synthetic', agentKind: 'codex', status: 'live', archived: false, lastActiveAt: stamp,
  agentState: { phase: 'working', since: stamp }, ...patch })

/** Direct reads to which drawing is moving. Before removing the ports each
 * entry is compared to that port on the SAME row, and saved independently.
 * The snapshots retain the old answers once production adapters are deleted. */
const sidebarFields = {
  idNumber: (r: WorklistIssue) => r.issue.seq,
  color: (r: WorklistIssue) => r.issue.color ?? null,
  title: (r: WorklistIssue) => r.title,
  timing: (r: WorklistIssue) => r.rowTiming,
  working: (r: WorklistIssue) => r.rowWorking,
  asking: (r: WorklistIssue) => r.rowAsking,
  originTick: (r: WorklistIssue) => r.rowOriginTick,
  decision: (r: WorklistIssue) => r.rowDecision,
  mergeCommits: (r: WorklistIssue) => r.rowDecision === 'merge' ? r.issue.gitState?.ahead ?? 0 : 0,
  progress: (r: WorklistIssue) => r.rowProgress,
  fromChildren: (r: WorklistIssue) => r.rowFromChildren,
  statusFromChildren: (r: WorklistIssue) => r.rowStatusFromChildren,
  gitState: (r: WorklistIssue) => r.issue.gitState,
  unread: (r: WorklistIssue) => r.rowUnread,
  errorClass: (r: WorklistIssue) => r.rowErrorClass,
  internal: (r: WorklistIssue) => r.issue.audience === 'agent',
  unsnoozed: (r: WorklistIssue) => r.rowUnsnoozed,
  deferred: (r: WorklistIssue) => r.issue.deferred,
  awaitsTuck: (r: WorklistIssue) => r.rowAwaitsTuck,
  canBringBack: (r: WorklistIssue) => r.rowCanBringBack,
  draftAgentOnly: (r: WorklistIssue) => r.rowDraftAgentOnly,
  firstSessionId: (r: WorklistIssue) => r.rowFirstSessionId,
  continuation: (r: WorklistIssue) => r.rowContinuation,
  fleet: (r: WorklistIssue) => (r.rowAggregate.sidebarFacts ?? NO_SIDEBAR_SESSIONS).fleet,
  sessions: (r: WorklistIssue) => r.rowSessions,
  aggregateSessionIds: (r: WorklistIssue) => r.rowAggregate.sessionIds ?? [],
  awaitingFirstPrompt: (r: WorklistIssue) => r.rowAwaitingFirstPrompt,
}
const mobileFields = {
  id: (r: WorklistIssue) => r.issue.id,
  kind: (r: WorklistIssue) => r.issue.entity,
  label: (r: WorklistIssue) => r.title,
  progress: (r: WorklistIssue) => r.rowProgress,
  originSeq: (r: WorklistIssue) => r.rowOriginTick?.seq ?? null,
  timing: (r: WorklistIssue) => r.rowTiming,
  working: (r: WorklistIssue) => r.rowWorking,
  waitingCount: (r: WorklistIssue) => r.mobileWaitingCount,
  decision: (r: WorklistIssue) => r.rowDecision,
  unread: (r: WorklistIssue) => r.mobileUnread,
  draftOnly: (r: WorklistIssue) => r.rowDraftAgentOnly,
  draftQuiet: (r: WorklistIssue) => r.mobileDraftQuiet,
  color: (r: WorklistIssue) => r.issue.color ?? null,
  internal: (r: WorklistIssue) => r.issue.audience === 'agent',
  pinned: (r: WorklistIssue) => r.issue.pinned === true,
  snoozed: (r: WorklistIssue) => r.issue.deferred,
  unsnoozed: (r: WorklistIssue) => r.rowUnsnoozed,
  tuckable: (r: WorklistIssue) => r.rowAwaitsTuck,
  fleet: (r: WorklistIssue) => (r.rowAggregate.sidebarFacts ?? NO_SIDEBAR_SESSIONS).fleet,
  branch: (r: WorklistIssue) => r.issue.branch ?? null,
  gitState: (r: WorklistIssue) => r.issue.gitState,
  suppressAhead: (r: WorklistIssue) => r.rowDecision === 'merge',
  attentionAction: (r: WorklistIssue) => r.mobileAttentionAction,
  navigation: (r: WorklistIssue) => r.mobileNavigation,
  sessions: (r: WorklistIssue) => r.rowSessions,
  activityAt: (r: WorklistIssue) => r.rowActivityAt,
}
const cases = ['working', 'waiting', 'folded-parent', 'merge', 'quiet-draft', 'snoozed', 'origin'] as const
function fixture(name: typeof cases[number]) {
  const pool = new MobxPool({ selectedIssueId: 'root', coarseNow: Date.parse(stamp) })
  const patch = name === 'merge' ? { stage: 'done', gitState: { ahead: 3, merged: false } }
    : name === 'quiet-draft' ? { isDraftVessel: true }
      : name === 'snoozed' ? { deferUntil: '2026-10-09T12:00:00Z' }
        : name === 'origin' ? { deps: [{ id: 'origin', type: 'discovered-from' }] } : {}
  pool.apply({ type: 'replace', rows: [
    { kind: 'issue', id: 'root', value: issue('root', patch) },
    { kind: 'issue', id: 'origin', value: issue('origin', { seq: 8 }) },
    ...(name === 'folded-parent' ? [{ kind: 'issue' as const, id: 'child',
      value: issue('child', { parentId: 'root', stage: 'done', tuckedAt: stamp, closedAt: stamp }) }] : []),
    { kind: 'session', id: 'seat', value: session('seat', 'root', name === 'waiting'
      ? { agentState: { phase: 'needs_user', since: stamp }, unread: true }
      : name === 'quiet-draft' ? { title: 'Draft agent', agentState: { phase: 'unknown' } }
        : name === 'merge' ? { status: 'exited', agentState: { phase: 'done', since: stamp } } : {}) as never },
  ] })
  return pool
}
for (const name of cases) describe(name, () => {
  for (const [platform, fields] of [['sidebar', sidebarFields], ['mobile', mobileFields]] as const) {
    for (const [field, read] of Object.entries(fields)) it(`${platform}.${field} equals its old port`, () => {
      const pool = fixture(name), row = worklistView(pool).row(pool.issueObject('root'))
      const stop = autorun(() => { void row.sidebar; void row.mobile })
      try {
        const port = row[platform]
        expect(port).not.toBe(LOADING)
        expect(port).toBeDefined()
        const actual = process.env.POD5822_MUTATE === '1' ? '__wrong_answer__' : read(row)
        expect(actual).toEqual(Reflect.get(port as object, field))
        expect(actual).toMatchSnapshot()
      } finally { stop(); pool.dispose() }
    })
  }
})

it('keeps cold rows LOADING and unknown rows absent on both drawing paths', () => {
  const pool = new MobxPool({ selectedIssueId: null, coarseNow: Date.parse(stamp) }, undefined, {
    load: () => undefined, schedule: () => () => {},
  })
  pool.apply({ type: 'replace', rows: [{ kind: 'issue', id: 'cold', value: issue('cold', {
    stage: 'done', closedAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
  }) }] })
  try {
    const cold = worklistView(pool).row(pool.issueObject('cold'))
    expect(cold.sidebar).toBe(LOADING)
    expect(cold.mobile).toBe(LOADING)
    const missing = worklistView(pool).row(pool.issueObject('missing'))
    expect(missing.sidebar).toBeUndefined()
    expect(missing.mobile).toBeUndefined()
  } finally { pool.dispose() }
})

it('compares selection to its old keyed answer before and after replica eviction', () => {
  const pool = fixture('working'), view = worklistView(pool), row = view.row(pool.issueObject('root'))
  const exits = observable.map<string, 'evicted' | 'removed'>()
  pool.sources.register(['issueExit'], { read: (_kind, id) => ({ kind: exits.get(id) }), dispose() {} })
  try {
    expect(row.selected).toBe(view.selectedId === row.id)
    runInAction(() => {
      exits.set('root', 'evicted')
      pool.apply({ type: 'update', rows: [{ kind: 'issue', id: 'root', value: undefined }] })
    })
    expect(view.selectionGone).toBe(true)
    expect(row.selected).toBe(view.selectedId === row.id)
    view.select(null)
    expect(view.selectionGone).toBe(false)
  } finally { pool.dispose() }
})
