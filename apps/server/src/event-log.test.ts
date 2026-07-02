import { describe, expect, it, vi } from 'vitest'
import type { SessionMeta } from '@podium/protocol'
import { SessionStore } from './store'
import { IssueService, type IssueDeps } from './issues'

function harness(sessions: SessionMeta[] = []) {
  const store = new SessionStore(':memory:')
  const deps: IssueDeps = {
    store,
    listSessions: () => sessions,
    getSettings: () => ({ gitWorkflow: { defaultParentBranch: '', mergeStyle: 'ff-only', autoRebaseBeforeMerge: true }, sessionDefaults: { agent: 'claude-code' } }) as never,
    spawnSession: vi.fn(() => ({ sessionId: 's1' })),
    repoOp: vi.fn(async () => ({ ok: true, output: '' })),
    broadcast: vi.fn(),
    now: () => '2026-07-02T00:00:00.000Z',
  }
  return { store, deps, svc: new IssueService(deps) }
}

describe('SessionStore event log', () => {
  it('appendEvent/listEventsSince round-trips payloads and returns ascending ids', () => {
    const store = new SessionStore(':memory:')
    const id1 = store.appendEvent({ ts: 't1', kind: 'a', subject: 's1', payload: { x: 1 } })
    const id2 = store.appendEvent({ ts: 't2', kind: 'b', subject: 's2', repoPath: '/r' })
    expect(id2).toBeGreaterThan(id1)
    const all = store.listEventsSince(0)
    expect(all.map((e) => e.id)).toEqual([id1, id2])
    expect(all[0]).toMatchObject({ ts: 't1', kind: 'a', subject: 's1', repoPath: null, payload: { x: 1 } })
    expect(all[1]).toMatchObject({ kind: 'b', repoPath: '/r', payload: {} })
  })

  it('since-cursor returns only events after the cursor', () => {
    const store = new SessionStore(':memory:')
    const id1 = store.appendEvent({ ts: 't1', kind: 'a', subject: 's' })
    const id2 = store.appendEvent({ ts: 't2', kind: 'a', subject: 's' })
    expect(store.listEventsSince(id1).map((e) => e.id)).toEqual([id2])
    expect(store.listEventsSince(id2)).toEqual([])
  })

  it('filters by kind list, repoPath, and honors limit', () => {
    const store = new SessionStore(':memory:')
    store.appendEvent({ ts: 't', kind: 'a', subject: 's', repoPath: '/r1' })
    store.appendEvent({ ts: 't', kind: 'b', subject: 's', repoPath: '/r2' })
    store.appendEvent({ ts: 't', kind: 'c', subject: 's', repoPath: '/r1' })
    expect(store.listEventsSince(0, { kinds: ['a', 'c'] }).map((e) => e.kind)).toEqual(['a', 'c'])
    expect(store.listEventsSince(0, { repoPath: '/r2' }).map((e) => e.kind)).toEqual(['b'])
    expect(store.listEventsSince(0, { limit: 2 }).length).toBe(2)
  })
})

describe('IssueService event emission', () => {
  it('create emits issue.created with seq/title and the repo path', () => {
    const { svc, store } = harness()
    const w = svc.create({ repoPath: '/r', title: 'A', startNow: false })
    const evs = store.listEventsSince(0, { kinds: ['issue.created'] })
    expect(evs.length).toBe(1)
    expect(evs[0]).toMatchObject({ subject: w.id, repoPath: '/r', payload: { seq: 1, title: 'A' } })
  })

  it('close emits issue.closed AND issue.ready for a dependent whose only blocker closed', () => {
    const { svc, store } = harness()
    const a = svc.create({ repoPath: '/r', title: 'A', startNow: false })
    const b = svc.create({ repoPath: '/r', title: 'B', startNow: false })
    svc.addDep(b.id, a.id, 'blocks')
    svc.close(a.id)
    const closed = store.listEventsSince(0, { kinds: ['issue.closed'] })
    expect(closed.length).toBe(1)
    expect(closed[0]).toMatchObject({ subject: a.id, payload: { seq: a.seq, reason: 'done' } })
    const ready = store.listEventsSince(0, { kinds: ['issue.ready'] })
    expect(ready.length).toBe(1)
    expect(ready[0]).toMatchObject({ subject: b.id, payload: { seq: b.seq, unblockedBy: a.seq } })
  })

  it('close does NOT emit issue.ready for a dependent that is still blocked by another open issue', () => {
    const { svc, store } = harness()
    const a = svc.create({ repoPath: '/r', title: 'A', startNow: false })
    const b = svc.create({ repoPath: '/r', title: 'B', startNow: false })
    const c = svc.create({ repoPath: '/r', title: 'C', startNow: false })
    svc.addDep(c.id, a.id, 'blocks')
    svc.addDep(c.id, b.id, 'blocks')
    svc.close(a.id)
    expect(store.listEventsSince(0, { kinds: ['issue.ready'] })).toEqual([])
  })

  it('stage change emits issue.stage_changed; close does not double-emit it', () => {
    const { svc, store } = harness()
    const a = svc.create({ repoPath: '/r', title: 'A', startNow: false })
    svc.update(a.id, { stage: 'in_progress' })
    svc.update(a.id, { stage: 'in_progress' }) // same value — no event
    svc.close(a.id)
    const staged = store.listEventsSince(0, { kinds: ['issue.stage_changed'] })
    expect(staged.length).toBe(1)
    expect(staged[0]).toMatchObject({
      subject: a.id,
      payload: { seq: a.seq, from: 'backlog', to: 'in_progress' },
    })
    expect(store.listEventsSince(0, { kinds: ['issue.closed'] }).length).toBe(1)
  })

  it('needs-human set/clear emit their events', () => {
    const { svc, store } = harness()
    const a = svc.create({ repoPath: '/r', title: 'A', startNow: false })
    svc.setNeedsHuman(a.id, 'which key?')
    svc.clearNeedsHuman(a.id)
    const flagged = store.listEventsSince(0, { kinds: ['issue.needs_human'] })
    expect(flagged.length).toBe(1)
    expect(flagged[0]).toMatchObject({ subject: a.id, payload: { seq: a.seq, question: 'which key?' } })
    expect(store.listEventsSince(0, { kinds: ['issue.needs_human_cleared'] }).length).toBe(1)
  })

  it('start emits issue.started with branch + worktreePath', async () => {
    const { svc, store } = harness()
    const a = svc.create({ repoPath: '/r', title: 'Fix login', startNow: false })
    await svc.start(a.id)
    const evs = store.listEventsSince(0, { kinds: ['issue.started'] })
    expect(evs.length).toBe(1)
    expect(evs[0]).toMatchObject({
      subject: a.id,
      payload: {
        seq: a.seq,
        branch: 'issue/1-fix-login',
        worktreePath: '/r/.worktrees/issue-1-fix-login',
      },
    })
  })

  it('an appendEvent failure never breaks the mutation', () => {
    const { svc, store } = harness()
    vi.spyOn(store, 'appendEvent').mockImplementation(() => {
      throw new Error('disk full')
    })
    const w = svc.create({ repoPath: '/r', title: 'A', startNow: false })
    expect(svc.close(w.id).stage).toBe('done')
  })
})
