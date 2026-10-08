import { compareRecency } from '@podium/client-core/focus'
import { createMobileInboxViews } from '@podium/client-graph/mobile-inbox-views'
import { MobileInbox, ProposalScreening } from '@podium/client-graph/mobile-triage'
import { MobxPool } from '@podium/client-graph/pool'
import { autorun } from 'mobx'
import { expect, it, vi } from 'vitest'
import { resolvePoolWorkMenu, resolveSharedWorkMenu } from './pool-work-menu'
import { reconcileScreeningIds } from '../client/use-inbox-data'
import { workMenuActionIds } from './work-menu'

const stamp = '2026-10-08T12:00:00Z'
const issue = (id: string, patch: object = {}) => ({ id, title: id, repoPath: '/synthetic',
  stage: 'proposed', seq: 1, priority: 2, audience: 'human', createdAt: stamp, updatedAt: stamp,
  blockedByNotes: [], ...patch })
const session = (id: string, patch: object = {}) => ({ sessionId: id, cwd: '/synthetic',
  issueId: 'a', agentKind: 'codex', status: 'live', createdAt: stamp, lastActiveAt: stamp,
  title: id, ...patch })
function fixture(extra = 0) {
  const pool = new MobxPool({ selectedIssueId: null, coarseNow: Date.parse(stamp) })
  pool.sources.register(['mobileInboxState'], { read: () => ({ hasCursor: true }), dispose() {} })
  const issues = [issue('a', { seq: 3 }), issue('b', { seq: 2 }), issue('c')]
  const sessions = [session('ask', { agentState: { phase: 'needs_user', since: stamp } }),
    session('work', { agentState: { phase: 'working', since: stamp } }),
    session('idle', { status: 'hibernated', agentState: { phase: 'working', since: stamp } }),
    session('offer', { offer: { message: 'Decide', actions: [] } }),
    session('shell', { agentKind: 'shell' }), session('headless', { headless: true }),
    session('archived', { archived: true }),
    ...Array.from({ length: extra }, (_, at) => session(`hidden-${at}`, { archived: true }))]
  pool.apply({ type: 'replace', rows: [
    ...issues.map(value => ({ kind: 'issue' as const, id: value.id, value })),
    ...sessions.map(value => ({ kind: 'session' as const, id: value.sessionId, value })),
  ] })
  return { pool, old: createMobileInboxViews(pool), inbox: new MobileInbox(pool) }
}
function oldGroups(old: ReturnType<typeof createMobileInboxViews>) {
  return Object.fromEntries(Object.entries(old.inbox().groups).map(([group, rows]) =>
    [group, rows.map(row => row.sessionId)]))
}

it('compares shared menu facts and actions with the old captured menu on the same fixture', () => {
  const f = fixture()
  try {
    for (const lane of ['live', 'closed', 'snoozed'] as const) {
      const old = resolvePoolWorkMenu(f.pool, 'a', lane)!
      const next = resolveSharedWorkMenu(f.pool, 'a', lane)!
      expect(next.target.issue).toBe(f.pool.model('issue', 'a'))
      for (const key of ['id', 'title', 'displayRef', 'unread', 'childCount', 'childDoneCount'] as const)
        expect(next.target.issue[key]).toEqual(old.target.issue[key])
      expect(next.target.sessionCount).toBe(old.target.sessionCount)
      expect(workMenuActionIds(next.target.issue, lane, { placement: false }))
        .toEqual(workMenuActionIds(old.target.issue, lane, { placement: false }))
    }
  } finally { f.old.dispose(); f.pool.dispose() }
})

it('compares ID groups and displayed session identities with the old inbox on the same fixture', () => {
  const f = fixture()
  const stop = autorun(() => { void f.inbox.groups })
  try {
    expect(f.inbox.groups).toEqual(oldGroups(f.old))
    for (const ids of Object.values(f.inbox.groups)) {
      const models = ids.map(id => f.inbox.session(id))
      expect(models.map(row => row.sessionId)).toEqual(ids)
      expect(models.slice().sort((a, b) => compareRecency(a as never, b as never)).map(row => row.id)).toEqual(ids)
    }
    f.pool.apply({ type: 'update', rows: [{ kind: 'session', id: 'work', value:
      session('work', { agentState: { phase: 'idle', since: stamp, idle: { kind: 'done' } } }) }] })
    expect(f.inbox.groups).toEqual(oldGroups(f.old))
  } finally { stop(); f.old.dispose(); f.pool.dispose() }
})

it('compares stable deck order with old queue/reconciliation through edits, removals and arrivals', () => {
  const f = fixture(), deck = new ProposalScreening(f.pool)
  const close = deck.open()
  let oldOrder = f.old.screening().queue, oldIndex = 0
  try {
    expect(deck.order).toEqual(oldOrder)
    deck.advance(); oldIndex++
    for (const value of [issue('b', { stage: 'backlog' }), issue('z', { priority: 0, seq: 99 }),
      issue('c', { priority: 0 }), issue('a', { stage: 'done' })]) {
      f.pool.apply({ type: 'update', rows: [{ kind: 'issue', id: value.id, value }] })
      const old = reconcileScreeningIds(oldOrder, oldIndex, f.old.screening().queue)
      oldOrder = old.order; oldIndex = old.index
      expect(deck.order).toEqual(oldOrder)
      expect(deck.index).toBe(oldIndex)
    }
    expect(deck.order).toEqual(['a', 'c', 'z'])
  } finally { close(); f.old.dispose(); f.pool.dispose() }
})

for (const scale of [1, 4]) it(`keeps unrelated activity out of groups and off-deck card facts cold at ${scale}x`, () => {
  const f = fixture(32 * scale), deck = new ProposalScreening(f.pool)
  const close = deck.open(), stop = autorun(() => { void f.inbox.groups })
  try {
    const groups = f.inbox.groups
    const reads = vi.spyOn(f.pool, 'row')
    f.pool.apply({ type: 'update', rows: [{ kind: 'session', id: 'hidden-0', value:
      session('hidden-0', { archived: true, lastActiveAt: '2026-10-08T13:00:00Z' }) }] })
    expect(f.inbox.groups).toBe(groups)
    expect(reads.mock.calls.filter(([kind]) => kind === 'session')).toHaveLength(0)
    reads.mockClear()
    for (const id of f.inbox.groups.needsYou) void f.inbox.session(id).title
    expect(new Set(reads.mock.calls.filter(([kind]) => kind === 'session').map(([,id]) => id)))
      .toEqual(new Set(f.inbox.groups.needsYou))
    reads.mockClear()
    const current = deck.current
    if (current && typeof current !== 'symbol') void current.title
    expect(reads.mock.calls.filter(([kind, id, mode]) => kind === 'issue' && mode !== 'summary' && id === 'c'))
      .toHaveLength(0)
  } finally { close(); stop(); f.old.dispose(); f.pool.dispose() }
})
