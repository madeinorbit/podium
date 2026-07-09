import { normalizeSettings } from '@podium/core'
import { describe, expect, it, vi } from 'vitest'
import type { SessionMeta } from '@podium/protocol'
import { SessionStore } from './store'
import { IssueService, type IssueDeps } from './issues'
import { SessionRegistry } from './relay'

function harness(sessions: SessionMeta[] = []) {
  const store = new SessionStore(':memory:')
  const deps: IssueDeps = {
    store,
    listSessions: () => sessions,
    getSettings: () => normalizeSettings({ gitWorkflow: { defaultParentBranch: '', mergeStyle: 'ff-only', autoRebaseBeforeMerge: true }, sessionDefaults: { agent: 'claude-code' } }),
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

describe('SessionStore event log retention (pruneEvents)', () => {
  const daysAgo = (n: number) => new Date(Date.now() - n * 24 * 60 * 60 * 1000).toISOString()

  it('deletes rows older than maxAgeDays and returns the deleted count', () => {
    const store = new SessionStore(':memory:')
    store.appendEvent({ ts: daysAgo(30), kind: 'old', subject: 's' })
    store.appendEvent({ ts: daysAgo(20), kind: 'old', subject: 's' })
    const keep = store.appendEvent({ ts: daysAgo(1), kind: 'new', subject: 's' })
    expect(store.pruneEvents({ maxAgeDays: 14, maxRows: 100 })).toBe(2)
    expect(store.listEventsSince(0).map((e) => e.id)).toEqual([keep])
  })

  it('row cap deletes the oldest rows beyond maxRows even when young', () => {
    const store = new SessionStore(':memory:')
    const ids = [1, 2, 3, 4, 5].map(() =>
      store.appendEvent({ ts: daysAgo(0), kind: 'k', subject: 's' }),
    )
    expect(store.pruneEvents({ maxAgeDays: 14, maxRows: 2 })).toBe(3)
    expect(store.listEventsSince(0).map((e) => e.id)).toEqual(ids.slice(3))
  })

  it('a cursor pointing into a pruned range still works — returns only retained rows', () => {
    const store = new SessionStore(':memory:')
    const id1 = store.appendEvent({ ts: daysAgo(30), kind: 'k', subject: 's' })
    const id2 = store.appendEvent({ ts: daysAgo(30), kind: 'k', subject: 's' })
    const id3 = store.appendEvent({ ts: daysAgo(1), kind: 'k', subject: 's' })
    const id4 = store.appendEvent({ ts: daysAgo(0), kind: 'k', subject: 's' })
    store.pruneEvents({ maxAgeDays: 14, maxRows: 100 })
    // Cursor sits below the oldest retained row (id1) and mid-gap (id2): both
    // simply resume at the first retained row above them — no error, no skip
    // of anything that still exists.
    expect(store.listEventsSince(id1).map((e) => e.id)).toEqual([id3, id4])
    expect(store.listEventsSince(id2).map((e) => e.id)).toEqual([id3, id4])
  })

  it('maxEventId tracks the newest retained row; ids never rewind after a full prune', () => {
    const store = new SessionStore(':memory:')
    store.appendEvent({ ts: daysAgo(30), kind: 'k', subject: 's' })
    const top = store.appendEvent({ ts: daysAgo(0), kind: 'k', subject: 's' })
    store.pruneEvents({ maxAgeDays: 14, maxRows: 100 })
    expect(store.maxEventId()).toBe(top)
    // AUTOINCREMENT: even after deleting EVERY row, the next id continues past
    // the old max — pruned ids are never reused, so cursors stay monotonic.
    store.pruneEvents({ maxAgeDays: 14, maxRows: 0 })
    expect(store.maxEventId()).toBe(0)
    const next = store.appendEvent({ ts: daysAgo(0), kind: 'k', subject: 's' })
    expect(next).toBeGreaterThan(top)
  })

  it('returns 0 when nothing qualifies for pruning', () => {
    const store = new SessionStore(':memory:')
    store.appendEvent({ ts: daysAgo(1), kind: 'k', subject: 's' })
    expect(store.pruneEvents({ maxAgeDays: 14, maxRows: 100 })).toBe(0)
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

  // Attention-state transitions S3 renders (issue #124).
  it('markIssueRead emits issue.read', () => {
    const { svc, store } = harness()
    const a = svc.create({ repoPath: '/r', title: 'A', startNow: false })
    svc.markIssueRead(a.id)
    const evs = store.listEventsSince(0, { kinds: ['issue.read'] })
    expect(evs.length).toBe(1)
    expect(evs[0]).toMatchObject({ subject: a.id, payload: { seq: a.seq } })
  })

  it('pin change emits issue.pinned with the new value (both directions)', () => {
    const { svc, store } = harness()
    const a = svc.create({ repoPath: '/r', title: 'A', startNow: false })
    svc.update(a.id, { pinned: true })
    svc.update(a.id, { pinned: true }) // no change — no duplicate event
    svc.update(a.id, { pinned: false })
    const evs = store.listEventsSince(0, { kinds: ['issue.pinned'] })
    expect(evs.length).toBe(2)
    expect(evs[0]).toMatchObject({ subject: a.id, payload: { seq: a.seq, pinned: true } })
    expect(evs[1]).toMatchObject({ subject: a.id, payload: { seq: a.seq, pinned: false } })
  })

  it('defer/undefer emit issue.snoozed / issue.unsnoozed', () => {
    const { svc, store } = harness()
    const a = svc.create({ repoPath: '/r', title: 'A', startNow: false })
    svc.defer(a.id, '2999-01-01')
    svc.defer(a.id, null)
    const snoozed = store.listEventsSince(0, { kinds: ['issue.snoozed'] })
    expect(snoozed.length).toBe(1)
    expect(snoozed[0]).toMatchObject({ subject: a.id, payload: { seq: a.seq, until: '2999-01-01' } })
    const unsnoozed = store.listEventsSince(0, { kinds: ['issue.unsnoozed'] })
    expect(unsnoozed.length).toBe(1)
    expect(unsnoozed[0]).toMatchObject({ subject: a.id, payload: { seq: a.seq } })
  })

  it('archive emits issue.archived once (on the false->true flip)', () => {
    const { svc, store } = harness()
    const a = svc.create({ repoPath: '/r', title: 'A', startNow: false })
    svc.archive(a.id)
    svc.archive(a.id) // already archived — no duplicate event
    const evs = store.listEventsSince(0, { kinds: ['issue.archived'] })
    expect(evs.length).toBe(1)
    expect(evs[0]).toMatchObject({ subject: a.id, payload: { seq: a.seq } })
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

  it('update --stage done (board drag / CLI path) emits issue.closed + the ready fanout', () => {
    const { svc, store } = harness()
    const a = svc.create({ repoPath: '/r', title: 'A', startNow: false })
    const b = svc.create({ repoPath: '/r', title: 'B', startNow: false })
    svc.addDep(b.id, a.id, 'blocks')
    svc.update(a.id, { stage: 'done' })
    const closed = store.listEventsSince(0, { kinds: ['issue.closed'] })
    expect(closed.length).toBe(1)
    expect(closed[0]).toMatchObject({ subject: a.id, payload: { seq: a.seq, reason: 'done' } })
    expect(store.listEventsSince(0, { kinds: ['issue.stage_changed'] })).toEqual([])
    const ready = store.listEventsSince(0, { kinds: ['issue.ready'] })
    expect(ready.length).toBe(1)
    expect(ready[0]).toMatchObject({ subject: b.id, payload: { seq: b.seq, unblockedBy: a.seq } })
  })

  it('supersede and duplicate emit issue.closed with their reasons', () => {
    const { svc, store } = harness()
    const old = svc.create({ repoPath: '/r', title: 'Old', startNow: false })
    const canon = svc.create({ repoPath: '/r', title: 'New', startNow: false })
    const dup = svc.create({ repoPath: '/r', title: 'Dup', startNow: false })
    svc.supersede(old.id, canon.id)
    svc.duplicate(dup.id, canon.id)
    const closed = store.listEventsSince(0, { kinds: ['issue.closed'] })
    expect(closed.map((e) => [e.subject, (e.payload as { reason: string }).reason])).toEqual([
      [old.id, 'superseded'],
      [dup.id, 'duplicate'],
    ])
  })

  it('double-close emits exactly one issue.closed', () => {
    const { svc, store } = harness()
    const a = svc.create({ repoPath: '/r', title: 'A', startNow: false })
    svc.close(a.id)
    svc.close(a.id, 'wontfix')
    svc.update(a.id, { closedReason: 'obsolete' }) // still closed — no re-emit
    expect(store.listEventsSince(0, { kinds: ['issue.closed'] }).length).toBe(1)
  })

  it('a fanout read error after the close persisted does not break close()', () => {
    const { svc, store } = harness()
    const a = svc.create({ repoPath: '/r', title: 'A', startNow: false })
    const b = svc.create({ repoPath: '/r', title: 'B', startNow: false })
    svc.addDep(b.id, a.id, 'blocks')
    // Arm the failure only once the issue.closed row landed, so persist/broadcast
    // succeed and the throw hits exactly the ready fanout's read path.
    const origAppend = store.appendEvent.bind(store)
    const origDeps = store.listIssueDeps.bind(store)
    let armed = false
    vi.spyOn(store, 'appendEvent').mockImplementation((e) => {
      const id = origAppend(e)
      if (e.kind === 'issue.closed') armed = true
      return id
    })
    vi.spyOn(store, 'listIssueDeps').mockImplementation((fromId) => {
      if (armed) throw new Error('boom')
      return origDeps(fromId)
    })
    expect(svc.close(a.id).stage).toBe('done')
    expect(store.getIssue(a.id)?.stage).toBe('done')
    expect(store.listEventsSince(0, { kinds: ['issue.closed'] }).length).toBe(1)
    expect(store.listEventsSince(0, { kinds: ['issue.ready'] })).toEqual([])
  })

  it('re-flagging needs-human emits once; re-clearing likewise', () => {
    const { svc, store } = harness()
    const a = svc.create({ repoPath: '/r', title: 'A', startNow: false })
    svc.clearNeedsHuman(a.id) // never flagged — nothing to log
    svc.setNeedsHuman(a.id, 'q1')
    svc.setNeedsHuman(a.id, 'q2')
    expect(store.listEventsSince(0, { kinds: ['issue.needs_human'] }).length).toBe(1)
    svc.clearNeedsHuman(a.id)
    svc.clearNeedsHuman(a.id)
    expect(store.listEventsSince(0, { kinds: ['issue.needs_human_cleared'] }).length).toBe(1)
  })
})

describe('SessionRegistry session.phase events', () => {
  const st = (phase: string, idle?: { kind: string }) =>
    ({ phase, since: 't', openTaskCount: 0, ...(idle ? { idle } : {}) }) as never

  it('skips the prev-undefined seed and logs only real phase transitions', () => {
    const store = new SessionStore(':memory:')
    const reg = new SessionRegistry(store)
    reg.attachDaemon('local', () => {})
    const { sessionId } = reg.createSession({ agentKind: 'claude-code', cwd: '/proj' })
    // First state after boot/spawn: prev is undefined → no phantom row.
    reg.onDaemonMessageFrom('local', { type: 'agentState', sessionId, state: st('working') })
    expect(store.listEventsSince(0, { kinds: ['session.phase'] })).toEqual([])
    reg.onDaemonMessageFrom('local', {
      type: 'agentState',
      sessionId,
      state: st('idle', { kind: 'question' }),
    })
    // Same-phase refresh → no second row.
    reg.onDaemonMessageFrom('local', { type: 'agentState', sessionId, state: st('idle') })
    const evs = store.listEventsSince(0, { kinds: ['session.phase'] })
    expect(evs.length).toBe(1)
    expect(evs[0]).toMatchObject({
      subject: sessionId,
      payload: { phase: 'idle', verdict: 'question', agentKind: 'claude-code', cwd: '/proj' },
    })
  })
})
