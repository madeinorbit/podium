import { autorun, observable, runInAction } from 'mobx'
import { describe, expect, it } from 'vitest'
import { MobxPool } from '../pool'
import { LOADING } from './rollup'
import { worklistView } from './view-model'
import { WorklistIssueBefore } from './issue-before.test-helper'
import type { WorklistIssue } from './issue'

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
  timing: (r: WorklistIssue) => r.timing,
  working: (r: WorklistIssue) => r.visibleWorking,
  asking: (r: WorklistIssue) => r.visibleAsking,
  originTick: (r: WorklistIssue) => r.origin,
  decision: (r: WorklistIssue) => r.decision,
  mergeCommits: (r: WorklistIssue) => r.mergeCommits,
  progress: (r: WorklistIssue) => r.progress,
  fromChildren: (r: WorklistIssue) => r.hasChildProgress,
  statusFromChildren: (r: WorklistIssue) => r.showsChildProgress,
  gitState: (r: WorklistIssue) => r.issue.gitState,
  unread: (r: WorklistIssue) => r.visibleUnread,
  errorClass: (r: WorklistIssue) => r.errorClass,
  internal: (r: WorklistIssue) => r.issue.audience === 'agent',
  unsnoozed: (r: WorklistIssue) => r.returnedFromDefer,
  deferred: (r: WorklistIssue) => r.issue.deferred,
  awaitsTuck: (r: WorklistIssue) => r.canTuck,
  canBringBack: (r: WorklistIssue) => r.canBringBack,
  draftAgentOnly: (r: WorklistIssue) => r.sessionOnlyDraft,
  firstSessionId: (r: WorklistIssue) => r.firstSessionId,
  continuation: (r: WorklistIssue) => r.continuation,
  fleet: (r: WorklistIssue) => r.visibleFleet,
  sessions: (r: WorklistIssue) => r.sessions.map(session => session.row),
  aggregateSessionIds: (r: WorklistIssue) => r.visibleSessionIds,
  awaitingFirstPrompt: (r: WorklistIssue) => r.awaitingFirstPrompt,
}
const mobileFields = {
  id: (r: WorklistIssue) => r.issue.id,
  kind: (r: WorklistIssue) => r.issue.entity,
  label: (r: WorklistIssue) => r.title,
  progress: (r: WorklistIssue) => r.progress,
  originSeq: (r: WorklistIssue) => r.origin?.seq ?? null,
  timing: (r: WorklistIssue) => r.timing,
  working: (r: WorklistIssue) => r.visibleWorking,
  waitingCount: (r: WorklistIssue) => r.waitingCount,
  decision: (r: WorklistIssue) => r.decision,
  unread: (r: WorklistIssue) => r.emphasizeUnread,
  draftOnly: (r: WorklistIssue) => r.sessionOnlyDraft,
  draftQuiet: (r: WorklistIssue) => r.quietDraft,
  color: (r: WorklistIssue) => r.issue.color ?? null,
  internal: (r: WorklistIssue) => r.issue.audience === 'agent',
  pinned: (r: WorklistIssue) => r.issue.pinned === true,
  snoozed: (r: WorklistIssue) => r.issue.deferred,
  unsnoozed: (r: WorklistIssue) => r.returnedFromDefer,
  tuckable: (r: WorklistIssue) => r.canTuck,
  fleet: (r: WorklistIssue) => r.visibleFleet,
  branch: (r: WorklistIssue) => r.issue.branch ?? null,
  gitState: (r: WorklistIssue) => r.issue.gitState,
  suppressAhead: (r: WorklistIssue) => r.decision === 'merge',
  attentionAction: (r: WorklistIssue) => r.attentionAction,
  navigation: (r: WorklistIssue) => r.navigation,
  sessions: (r: WorklistIssue) => r.sessions.map(session => session.row),
  activityAt: (r: WorklistIssue) => r.visibleActivityAt,
}
const cases = ['next-message', 'working', 'waiting', 'folded-parent', 'merge', 'awaiting-merge', 'quiet-draft', 'snoozed', 'origin'] as const
function fixture(name: typeof cases[number]) {
  const pool = new MobxPool({ selectedIssueId: 'root', coarseNow: Date.parse(stamp) })
  const patch = name === 'next-message' ? { deferUntil: 'next-message' } : name === 'awaiting-merge' ? { stage: 'done', branch: 'issue/merge', gitState: { ahead: 3, shared: false, merged: false } } : name === 'merge' ? { stage: 'done', gitState: { ahead: 3, merged: false } }
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
        : (name === 'merge' || name === 'awaiting-merge') ? { status: 'exited', agentState: { phase: 'done', since: stamp } } : {}) as never },
  ] })
  return pool
}
for (const name of cases) describe(name, () => {
  for (const [platform, fields] of [['sidebar', sidebarFields], ['mobile', mobileFields]] as const) {
    for (const [field, read] of Object.entries(fields)) it(`${platform}.${field} equals its old port`, () => {
      const pool = fixture(name), row = worklistView(pool).row(pool.issueObject('root'))
      const before = new WorklistIssueBefore(row.issue, row.worklist)
      const stop = autorun(() => { void before.sidebar; void before.mobile; void row.ready })
      try {
        const port = before[platform]
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
    expect(cold.ready).toBe(LOADING)
    expect(worklistView(pool).mobileRow({ id: 'cold', kind: 'issue' })).toBe(LOADING)
    const missing = worklistView(pool).row(pool.issueObject('missing'))
    expect(missing.ready).toBeUndefined()
    expect(worklistView(pool).mobileRow({ id: 'missing', kind: 'issue' })).toBeUndefined()
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

const internalFields = [["own.closed","settledClosed"],["own.dismissed","settledDismissed"],["rowBelow","visibleChildIds"],["rowNested","visibleDescendantIds"],["rowAggregate","visibleAttention"],["rowSeatActivity","visibleSessionActivity"],["rowParts","visibleParts"],["rowTip","continuationTip"],["laneMemberIds","laneMemberIds"],["memberIds","memberIds"],["laneRetainedSeatIds","laneRetainedSeatIds"],["retainedSeatIds","retainedSeatIds"],["rosterIds","rosterIds"],["childIds","childIds"],["spinOffIds","spinOffIds"],["nestBelow","nestBelow"],["nested","nested"],["rowIssue.id", "issue.id"], ["rowIssue.parentId", "issue.parentId"], ["rowIssue.seq", "issue.seq"], ["rowIssue.createdAt", "issue.createdAt"], ["rowIssue.updatedAt", "issue.updatedAt"], ["rowIssue.closedAt", "issue.closedAt"], ["rowIssue.deletedAt", "issue.deletedAt"], ["rowIssue.archived", "issue.archived"], ["rowIssue.stage", "issue.stage"], ["rowIssue.type", "issue.type"], ["rowIssue.closedReason", "issue.closedReason"], ["rowIssue.audience", "issue.audience"], ["rowIssue.isDraftVessel", "issue.isDraftVessel"], ["rowIssue.pinned", "issue.pinned"], ["rowIssue.sortKey", "issue.sortKey"], ["rowIssue.deferUntil", "issue.deferUntil"], ["rowIssue.tuckedAt", "issue.tuckedAt"], ["rowIssue.repoId", "issue.repoId"], ["rowIssue.repoPath", "issue.repoPath"], ["rowIssue.worktreePath", "issue.worktreePath"], ["rowIssue.coordinatorSessionId", "issue.coordinatorSessionId"], ["rowIssue.startedBySession", "issue.startedBySession"], ["rowIssue.deps", "issue.deps"], ["rowIssue.needsHuman", "issue.needsHuman"], ["rowIssue.blocked", "issue.blocked"], ["rowIssue.readAt", "issue.readAt"], ["rowIssue.title", "issue.title"], ["rowIssue.linearIdentifier", "issue.linearIdentifier"], ["rowIssue.color", "issue.color"], ["rowIssue.branch", "issue.branch"], ["rowIssue.parentBranch", "issue.parentBranch"], ["rowIssue.gitState", "issue.gitState"], ["rowIssue.intentOrigin", "issue.intentOrigin"], ["rowIssue.asked", "issue.asked"], ["rowIssue.supersededBy", "issue.supersededBy"], ["rowIssue.duplicateOf", "issue.duplicateOf"], ["rowIssue.displayRef", "issue.displayRef"], ["rowIssue.unread", "unread"], ["standing.excluded", "issue.excluded"], ["standing.finished", "issue.finished"], ["standing.agent", "issue.audience"], ["standing.activeHuman", "activeHuman"], ["standing.awaitingMerge", "issue.awaitingMerge"], ["standing.sessionless", "sessionless"], ["standing.rescuable", "rescuable"], ["standing.parentId", "issue.parentRef"], ["standing.startedBy", "startedBy"], ["standing.draftVessel", "issue.isDraftVessel"], ["standing.finishedMs", "issue.finishedMs"], ["standing.updatedMs", "issue.updatedMs"], ["standing.replicaActivityMs", "lastSessionActivity"], ["standing.headlessStaffed", "issue.headlessStaffed"], ["standing.deleted", "issue.deletedAt"], ["standing.pinned", "issue.pinned"], ["standing.formalParent", "issue.formalParent"], ["own.band", "band"], ["own.repoKey", "repoKey"], ["own.pinned", "issue.pinned"], ["own.sortKey", "issue.sortKey"], ["own.createdAt", "issue.createdAt"], ["own.seq", "issue.seq"], ["own.foldAt", "foldAt"], ["label.displayRef", "issue.displayRef"], ["label.displayTitle", "title"], ["label.seq", "issue.seq"], ["ownAttention.cold", "sessionsLoading"], ["ownAttention.workingSince", "sessionsWorkingSince"], ["ownAttention.firstSessionId", "firstSessionId"], ["ownAttention.sessionIds", "attentionSessionIds"], ["ownAttention.updatedAt", "sessionsUpdatedAt"], ["ownAttention.order", "sessionOrder"], ["ownAttention.decidingAt", "decisionAt"], ["ownAttention.seated", "hasSessions"], ["ownAttention.working", "sessionsWorking"], ["ownAttention.deciding", "needsDecision"], ["ownAttention.pending", "pendingSessions"], ["ownAttention.railWaiting.open", "waitingOpenSessions"], ["ownAttention.railWaiting.finished", "waitingFinishedSessions"], ["ownAttention.railWaiting.decisions", "waitingDecisions"], ["ownAttention.open.waiting", "openSessionsWaiting"], ["ownAttention.open.working", "openSessionsWorking"], ["ownAttention.open.allDone", "openSessionsDone"], ["ownAttention.finished.waiting", "finishedSessionsWaiting"], ["ownAttention.finished.working", "finishedSessionsWorking"], ["ownAttention.finished.allDone", "finishedSessionsDone"], ["ownAttention.sidebarFacts.fleet", "sessionFleet"], ["ownAttention.sidebarFacts.working", "workingTimer"], ["ownAttention.sidebarFacts.waitingOpen", "waitingOpenTimer"], ["ownAttention.sidebarFacts.waitingFinished", "waitingFinishedTimer"], ["ownAttention.sidebarFacts.doneSince", "sessionsDoneSince"], ["ownAttention.sidebarFacts.totalMs", "sessionsWorkingMs"], ["ownAttention.sidebarFacts.errorClass", "sessionErrorClass"], ["ownAttention.sidebarFacts.allUnstarted", "sessionsUnstarted"]] as const
for (const name of cases) describe(`${name} internal fields`, () => {
  for (const [oldName, newName] of [...internalFields, ['rowOwn', 'loadedIssue'], ['rowOrigin', 'loadedOrigin']]) it(`${oldName} equals ${newName}`, () => {
    const pool = fixture(name), view = worklistView(pool), row = view.row(pool.issueObject('root'))
    const before = new WorklistIssueBefore(row.issue, view)
    const read = (value: object, path: string): unknown => path.split('.').reduce<unknown>((next, field) =>
      next == null ? undefined : Reflect.get(next as object, field), value)
    try {
      let expected = read(before, oldName), actual = read(row, newName)
      if ((newName === 'loadedIssue' || newName === 'loadedOrigin') && actual && actual !== LOADING && 'entity' in (actual as object)) {
        actual = Reflect.get(actual as object, 'row')
      }
      if (oldName === 'standing.agent') actual = actual === 'agent'
      if (oldName === 'standing.deleted') actual = actual != null
      if (oldName === 'standing.draftVessel') actual = actual === true && !row.issue.worktreePath
      if (oldName === 'standing.pinned' || oldName === 'own.pinned') actual = actual === true
      if (oldName === 'own.sortKey') actual ??= null
      if (process.env.POD5822_MUTATE === '1') actual = '__wrong_answer__'
      const plain = (value: unknown): unknown => typeof value === 'function' ? undefined
        : Array.isArray(value) ? value.map(plain) : value && typeof value === 'object'
          ? Object.fromEntries(Object.keys(value).filter(key => typeof Reflect.get(value, key) !== 'function')
            .map(key => [key, plain(Reflect.get(value, key))])) : value
      expect(plain(actual)).toEqual(plain(expected))
    } finally { pool.dispose() }
  })
})

it('an until-next-message issue is deferred and is not ready on the shared model', () => {
  const pool = fixture('next-message'), model = pool.issueObject('root')
  try { expect(model.deferred).toBe(true); expect(model.ready).toBe(false) }
  finally { pool.dispose() }
})
