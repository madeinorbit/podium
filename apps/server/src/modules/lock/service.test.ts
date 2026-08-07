import { asIssueId, asSessionId } from '@podium/model'
import { describe, expect, it, vi } from 'vitest'
import { SessionStore } from '../../store'
import { DEFAULT_LOCK_TTL_SECONDS, LockService } from './service'

/**
 * LockService + LocksRepository semantics [spec:SP-85d1]: grant, same-session
 * renew, FIFO enqueue + position, release→advance (with dead-waiter pruning),
 * lazy expiry, steal, session-bound release, waiter dedup. Runs over a real
 * in-memory SessionStore so the store aggregate (migration 011) is exercised
 * end-to-end.
 */

const REPO = '/repo'

function harness(opts?: { alive?: Set<string>; workspace?: Map<string, string> }) {
  const store = new SessionStore(':memory:')
  const alive = opts?.alive ?? new Set<string>()
  const workspace = opts?.workspace ?? new Map<string, string>()
  let nowMs = Date.parse('2026-07-13T12:00:00.000Z')
  const sendMail = vi.fn()
  const appendEvent = vi.fn()
  const svc = new LockService({
    locks: store.locks,
    transact: (fn) => store.transact(fn),
    funnel: { run: (op) => op.write() },
    now: () => nowMs,
    resolveRepoId: (repoPath) => `repo:${repoPath}`,
    sessionAlive: (sessionId) => alive.has(sessionId),
    sessionWorkspace: (sessionId) => workspace.get(sessionId) ?? null,
    sendMail,
    appendEvent,
  })
  return {
    svc,
    store,
    alive,
    workspace,
    sendMail,
    appendEvent,
    advance: (ms: number) => {
      nowMs += ms
    },
  }
}

const agent = (n: number, workspace: string | null = null) => ({
  sessionId: asSessionId(`sess_${n}`),
  issueId: asIssueId(`iss_${n}`),
  label: `issue:#${n}`,
  workspace,
})
const OPERATOR = { sessionId: null, issueId: null, label: 'operator', workspace: null }

describe('LockService', () => {
  it('grants a free lock with the default TTL and holder identity', () => {
    const { svc } = harness()
    const r = svc.acquire(agent(1), { repoPath: REPO, name: 'merge:main' })
    expect(r.granted).toBe(true)
    if (!r.granted) throw new Error('unreachable')
    expect(r.alreadyHeld).toBe(false)
    expect(r.lock.holder).toEqual({
      sessionId: asSessionId('sess_1'),
      issueId: 'iss_1',
      label: 'issue:#1',
      alive: false, // harness sessionAlive defaults to empty set
      workspace: null,
    })
    expect(r.lock.secondsLeft).toBe(DEFAULT_LOCK_TTL_SECONDS)
    expect(r.lock.queue).toEqual([])
  })

  it('same-session re-acquire renews (extends expiry, keeps acquired_at, reports already held)', () => {
    const { svc, advance } = harness()
    const first = svc.acquire(agent(1), { repoPath: REPO, name: 'l', ttlSeconds: 60 })
    if (!first.granted) throw new Error('expected grant')
    advance(30_000)
    const again = svc.acquire(agent(1), { repoPath: REPO, name: 'l', ttlSeconds: 60 })
    expect(again.granted).toBe(true)
    if (!again.granted) throw new Error('unreachable')
    expect(again.alreadyHeld).toBe(true)
    expect(again.lock.secondsLeft).toBe(60) // extended from NOW, not from the old expiry
    expect(again.lock.acquiredAt).toBe(first.lock.acquiredAt)
  })

  it('enqueues FIFO with 1-based positions; re-acquire while queued is idempotent', () => {
    const { svc, advance } = harness()
    svc.acquire(agent(1), { repoPath: REPO, name: 'l' })
    const q2 = svc.acquire(agent(2), { repoPath: REPO, name: 'l' })
    expect(q2).toMatchObject({ granted: false, position: 1 })
    advance(1_000)
    const q3 = svc.acquire(agent(3), { repoPath: REPO, name: 'l' })
    expect(q3).toMatchObject({ granted: false, position: 2 })
    // waiter dedup: same session again → same position, no duplicate row
    const q2again = svc.acquire(agent(2), { repoPath: REPO, name: 'l' })
    expect(q2again).toMatchObject({ granted: false, position: 1 })
    if (q2again.granted) throw new Error('unreachable')
    expect(q2again.lock.queue).toHaveLength(2)
    expect(q2again.lock.holder.label).toBe('issue:#1')
    expect(q2again.lock.queue).toEqual([
      {
        position: 1,
        sessionId: asSessionId('sess_2'),
        issueId: asIssueId('iss_2'),
        label: 'issue:#2',
        enqueuedAt: '2026-07-13T12:00:00.000Z',
        alive: false,
        workspace: null,
      },
      {
        position: 2,
        sessionId: asSessionId('sess_3'),
        issueId: asIssueId('iss_3'),
        label: 'issue:#3',
        enqueuedAt: '2026-07-13T12:00:01.000Z',
        alive: false,
        workspace: null,
      },
    ])
  })

  it('status reports per-row liveness from sessionAlive (dead waiters stay visible until advance)', () => {
    const { svc, alive } = harness()
    alive.add('sess_1').add('sess_2') // sess_3 dead
    svc.acquire(agent(1), { repoPath: REPO, name: 'l' })
    svc.acquire(agent(2), { repoPath: REPO, name: 'l' })
    svc.acquire(agent(3), { repoPath: REPO, name: 'l' })
    const status = svc.status({ repoPath: REPO, name: 'l' })[0]!
    expect(status.holder).toMatchObject({ sessionId: 'sess_1', alive: true })
    expect(status.queue).toEqual([
      expect.objectContaining({ sessionId: 'sess_2', alive: true }),
      expect.objectContaining({ sessionId: 'sess_3', alive: false }),
    ])
  })

  it('refuses a sibling on the same issue that already holds or is queued; --allow-sibling opts in', () => {
    const { svc, alive } = harness()
    alive.add('sess_1').add('sess_1b').add('sess_2')
    const a = agent(1)
    const sibling = {
      sessionId: asSessionId('sess_1b'),
      issueId: asIssueId('iss_1'),
      label: 'issue:#1',
      workspace: null,
    }
    const otherIssue = agent(2)
    svc.acquire(a, { repoPath: REPO, name: 'l' })
    // Same issue, different session, holder is sibling → refuse
    expect(() => svc.acquire(sibling, { repoPath: REPO, name: 'l' })).toThrow(
      /sibling sess_1 \(issue:#1\) already holds.*same issue/,
    )
    // Other issue may still queue (different issue + no shared workspace)
    expect(svc.acquire(otherIssue, { repoPath: REPO, name: 'l' })).toMatchObject({
      granted: false,
      position: 1,
    })
    // Sibling still refuses while another issue is queued
    expect(() => svc.acquire(sibling, { repoPath: REPO, name: 'l' })).toThrow(/already holds/)
    // allowSibling queues behind
    const allowed = svc.acquire(sibling, { repoPath: REPO, name: 'l', allowSibling: true })
    expect(allowed).toMatchObject({ granted: false, position: 2 })

    // After holder releases, sibling holds; a third sibling on same issue still
    // refuses when a same-issue waiter exists.
    alive.add('sess_1c')
    svc.release(a, { repoPath: REPO, name: 'l' }) // advances to otherIssue
    // queue was otherIssue then sibling; advance grants otherIssue, sibling remains
    const mid = svc.status({ repoPath: REPO, name: 'l' })[0]!
    expect(mid.holder.sessionId).toBe('sess_2')
    expect(mid.queue.map((w) => w.sessionId)).toEqual([asSessionId('sess_1b')])
    const third = {
      sessionId: asSessionId('sess_1c'),
      issueId: asIssueId('iss_1'),
      label: 'issue:#1',
      workspace: null,
    }
    expect(() => svc.acquire(third, { repoPath: REPO, name: 'l' })).toThrow(
      /sibling sess_1b \(issue:#1\) is already queued/,
    )
    expect(
      svc.acquire(third, { repoPath: REPO, name: 'l', allowSibling: true }),
    ).toMatchObject({ granted: false, position: 2 })
  })

  it('refuses co-located sessions that share a worktree even on different issues', () => {
    // POD-516 incident: many issues in one checkout; issue-keyed refuse misses them.
    const wt = '/repo/.worktrees/issue-516'
    const { svc, alive, workspace } = harness()
    alive.add('sess_516').add('sess_539').add('sess_527')
    workspace.set('sess_516', wt).set('sess_539', wt).set('sess_527', '/repo/.worktrees/issue-527')
    const on516 = {
      sessionId: asSessionId('sess_516'),
      issueId: asIssueId('iss_516'),
      label: 'issue:#516',
      workspace: wt,
    }
    const on539 = {
      sessionId: asSessionId('sess_539'),
      issueId: asIssueId('iss_539'),
      label: 'issue:#539',
      workspace: wt,
    }
    const on527 = {
      sessionId: asSessionId('sess_527'),
      issueId: asIssueId('iss_527'),
      label: 'issue:#527',
      workspace: '/repo/.worktrees/issue-527',
    }
    svc.acquire(on516, { repoPath: REPO, name: 'test:heavy' })
    expect(() => svc.acquire(on539, { repoPath: REPO, name: 'test:heavy' })).toThrow(
      /sharing this worktree/,
    )
    // Different worktree may still queue
    expect(svc.acquire(on527, { repoPath: REPO, name: 'test:heavy' })).toMatchObject({
      granted: false,
      position: 1,
    })
    // Status surfaces the live workspace on each row
    const status = svc.status({ repoPath: REPO, name: 'test:heavy' })[0]!
    expect(status.holder).toMatchObject({ sessionId: 'sess_516', workspace: wt, alive: true })
    expect(status.queue[0]).toMatchObject({
      sessionId: 'sess_527',
      workspace: '/repo/.worktrees/issue-527',
      alive: true,
    })
    // Override still works for genuine concurrent access
    expect(
      svc.acquire(on539, { repoPath: REPO, name: 'test:heavy', allowSibling: true }),
    ).toMatchObject({ granted: false, position: 2 })
  })

  it('re-acquire while already queued is still idempotent and skips the sibling refuse', () => {
    const { svc, alive } = harness()
    alive.add('sess_1').add('sess_1b')
    svc.acquire(agent(1), { repoPath: REPO, name: 'l' })
    const sibling = {
      sessionId: asSessionId('sess_1b'),
      issueId: asIssueId('iss_1'),
      label: 'issue:#1',
      workspace: null,
    }
    const first = svc.acquire(sibling, { repoPath: REPO, name: 'l', allowSibling: true })
    expect(first).toMatchObject({ granted: false, position: 1 })
    // Same session again — position unchanged, no error
    const again = svc.acquire(sibling, { repoPath: REPO, name: 'l' })
    expect(again).toMatchObject({ granted: false, position: 1 })
  })

  it('same-session re-acquire renews (does not queue) — FIFO was never violated by re-hold', () => {
    // Pin POD-527's measurement so nobody re-diagnoses renewal as queue-jumping.
    const { svc, advance } = harness()
    const first = svc.acquire(agent(1), { repoPath: REPO, name: 'l', ttlSeconds: 120 })
    if (!first.granted) throw new Error('expected grant')
    const acquiredAt = first.lock.acquiredAt
    advance(30_000)
    // A foreign waiter sits in the queue
    expect(svc.acquire(agent(2), { repoPath: REPO, name: 'l' })).toMatchObject({
      granted: false,
      position: 1,
    })
    const renewed = svc.acquire(agent(1), { repoPath: REPO, name: 'l', ttlSeconds: 120 })
    expect(renewed).toMatchObject({ granted: true, alreadyHeld: true })
    if (!renewed.granted) throw new Error('unreachable')
    expect(renewed.lock.acquiredAt).toBe(acquiredAt)
    // Waiter is still position 1 — holder did not re-enter the queue ahead of them
    expect(renewed.lock.queue).toHaveLength(1)
    expect(renewed.lock.queue[0]?.sessionId).toBe(asSessionId('sess_2'))
  })

  it('release advances the queue FIFO and mails the new holder; non-holder release errors', () => {
    const { svc, alive, sendMail } = harness()
    alive.add('sess_1').add('sess_2')
    svc.acquire(agent(1), { repoPath: REPO, name: 'l' })
    svc.acquire(agent(2), { repoPath: REPO, name: 'l' })
    expect(() => svc.release(agent(2), { repoPath: REPO, name: 'l' })).toThrow(/not by you/)
    const r = svc.release(agent(1), { repoPath: REPO, name: 'l' })
    expect(r.next?.label).toBe('issue:#2')
    expect(sendMail).toHaveBeenCalledWith(
      'iss_2',
      'lock-manager',
      expect.stringContaining("Lock 'l' granted to you"),
    )
    const status = svc.status({ repoPath: REPO, name: 'l' })
    expect(status[0]?.holder.sessionId).toBe('sess_2')
    // releasing the last holder with an empty queue frees the lock
    svc.release(agent(2), { repoPath: REPO, name: 'l' })
    expect(svc.status({ repoPath: REPO, name: 'l' })).toEqual([])
    expect(() => svc.release(agent(2), { repoPath: REPO, name: 'l' })).toThrow(/not held/)
  })

  it('release prunes waiters whose sessions are gone before granting', () => {
    const { svc, alive, sendMail } = harness()
    alive.add('sess_1').add('sess_3') // sess_2 is dead
    svc.acquire(agent(1), { repoPath: REPO, name: 'l' })
    svc.acquire(agent(2), { repoPath: REPO, name: 'l' })
    svc.acquire(agent(3), { repoPath: REPO, name: 'l' })
    const r = svc.release(agent(1), { repoPath: REPO, name: 'l' })
    expect(r.next?.label).toBe('issue:#3')
    expect(sendMail).toHaveBeenCalledTimes(1)
    const status = svc.status({ repoPath: REPO, name: 'l' })
    expect(status[0]?.queue).toEqual([])
  })

  it('renew extends the lease for the holder only', () => {
    const { svc, advance } = harness()
    svc.acquire(agent(1), { repoPath: REPO, name: 'l', ttlSeconds: 60 })
    advance(50_000)
    const wire = svc.renew(agent(1), { repoPath: REPO, name: 'l', ttlSeconds: 120 })
    expect(wire.secondsLeft).toBe(120)
    expect(() => svc.renew(agent(2), { repoPath: REPO, name: 'l' })).toThrow(/not by you/)
    expect(() => svc.renew(agent(1), { repoPath: REPO, name: 'nope' })).toThrow(/not held/)
  })

  it('lazy expiry: an expired lease is swept on the next op, advancing the queue with mail', () => {
    const { svc, alive, advance, sendMail } = harness()
    alive.add('sess_1').add('sess_2')
    svc.acquire(agent(1), { repoPath: REPO, name: 'l', ttlSeconds: 10 })
    svc.acquire(agent(2), { repoPath: REPO, name: 'l' })
    advance(11_000)
    const status = svc.status({ repoPath: REPO, name: 'l' })
    expect(status[0]?.holder.label).toBe('issue:#2')
    expect(sendMail).toHaveBeenCalledWith(
      'iss_2',
      'lock-manager',
      expect.stringContaining('granted'),
    )
    // an expired lock with NO waiters just frees
    svc.release(agent(2), { repoPath: REPO, name: 'l' })
    svc.acquire(agent(1), { repoPath: REPO, name: 'solo', ttlSeconds: 5 })
    advance(6_000)
    expect(svc.status({ repoPath: REPO })).toEqual([])
  })

  it('steal force-takes, logs an event, and mails the previous holder issue', () => {
    const { svc, sendMail, appendEvent } = harness()
    svc.acquire(agent(1), { repoPath: REPO, name: 'l' })
    svc.acquire(agent(2), { repoPath: REPO, name: 'l' })
    const r = svc.steal(agent(2), { repoPath: REPO, name: 'l' })
    expect(r.previousHolder?.label).toBe('issue:#1')
    expect(r.lock.holder.label).toBe('issue:#2')
    // the stealer's own queue entry is removed; nobody else was queued
    expect(r.lock.queue).toEqual([])
    expect(appendEvent).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'lock.stolen', subject: 'repo:/repo:l' }),
    )
    expect(sendMail).toHaveBeenCalledWith(
      'iss_1',
      'lock-manager',
      expect.stringContaining('stolen'),
    )
    // steal on a free lock is just an acquire
    const free = svc.steal(agent(3), { repoPath: REPO, name: 'other' })
    expect(free.previousHolder).toBeNull()
  })

  it('releaseForSession releases held locks (advancing queues) and prunes queue entries', () => {
    const { svc, alive, sendMail } = harness()
    alive.add('sess_1').add('sess_2').add('sess_3')
    svc.acquire(agent(1), { repoPath: REPO, name: 'a' })
    svc.acquire(agent(2), { repoPath: REPO, name: 'a' })
    svc.acquire(agent(2), { repoPath: REPO, name: 'b' })
    svc.acquire(agent(1), { repoPath: REPO, name: 'b' }) // sess_1 queued on b
    svc.releaseForSession(asSessionId('sess_1'))
    // a: advanced to sess_2 (mailed); b: sess_1's queue entry pruned, sess_2 still holds
    expect(svc.status({ repoPath: REPO, name: 'a' })[0]?.holder.sessionId).toBe('sess_2')
    expect(svc.status({ repoPath: REPO, name: 'b' })[0]?.queue).toEqual([])
    expect(sendMail).toHaveBeenCalledWith('iss_2', 'lock-manager', expect.stringContaining("'a'"))
  })

  it('operator (no session) can hold, renew, and queue via the sentinel', () => {
    const { svc } = harness()
    const r = svc.acquire(OPERATOR, { repoPath: REPO, name: 'l' })
    expect(r.granted).toBe(true)
    const again = svc.acquire(OPERATOR, { repoPath: REPO, name: 'l' })
    expect(again).toMatchObject({ granted: true, alreadyHeld: true })
    const r2 = svc.acquire(agent(1), { repoPath: REPO, name: 'l' })
    expect(r2).toMatchObject({ granted: false, position: 1 })
    const rel = svc.release(OPERATOR, { repoPath: REPO, name: 'l' })
    // agent 1's session is NOT alive in this harness → pruned; lock freed
    expect(rel.next).toBeNull()

    // operator waits behind an agent and is never pruned as "session gone"
    const h2 = harness({ alive: new Set(['sess_1']) })
    h2.svc.acquire(agent(1), { repoPath: REPO, name: 'l' })
    const qOp = h2.svc.acquire(OPERATOR, { repoPath: REPO, name: 'l' })
    expect(qOp).toMatchObject({ granted: false, position: 1 })
    const rel2 = h2.svc.release(agent(1), { repoPath: REPO, name: 'l' })
    expect(rel2.next?.label).toBe('operator')
    expect(rel2.next?.sessionId).toBeNull()
  })

  it('cancel removes the caller from the wait queue; holder/non-queued cancels error', () => {
    const { svc, alive } = harness()
    alive.add('sess_1').add('sess_2').add('sess_3')
    svc.acquire(agent(1), { repoPath: REPO, name: 'l' })
    svc.acquire(agent(2), { repoPath: REPO, name: 'l' })
    svc.acquire(agent(3), { repoPath: REPO, name: 'l' })
    expect(() => svc.cancel(agent(1), { repoPath: REPO, name: 'l' })).toThrow(/use `release`/)
    expect(svc.cancel(agent(2), { repoPath: REPO, name: 'l' })).toEqual({ cancelled: true })
    expect(() => svc.cancel(agent(2), { repoPath: REPO, name: 'l' })).toThrow(/not queued/)
    // FIFO integrity: sess_3 is now first in line
    const r = svc.release(agent(1), { repoPath: REPO, name: 'l' })
    expect(r.next?.label).toBe('issue:#3')
  })

  it('locks are scoped by repo_id: the same name in another repo is independent', () => {
    const { svc } = harness()
    svc.acquire(agent(1), { repoPath: '/repo-a', name: 'merge:main' })
    const other = svc.acquire(agent(2), { repoPath: '/repo-b', name: 'merge:main' })
    expect(other.granted).toBe(true)
  })
})
