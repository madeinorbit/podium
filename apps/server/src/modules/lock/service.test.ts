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

function harness(opts?: { alive?: Set<string> }) {
  const store = new SessionStore(':memory:')
  const alive = opts?.alive ?? new Set<string>()
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
    sendMail,
    appendEvent,
  })
  return {
    svc,
    store,
    alive,
    sendMail,
    appendEvent,
    advance: (ms: number) => {
      nowMs += ms
    },
  }
}

const agent = (n: number) => ({
  sessionId: `sess_${n}`,
  issueId: `iss_${n}`,
  label: `issue:#${n}`,
})
const OPERATOR = { sessionId: null, issueId: null, label: 'operator' }

describe('LockService', () => {
  it('grants a free lock with the default TTL and holder identity', () => {
    const { svc } = harness()
    const r = svc.acquire(agent(1), { repoPath: REPO, name: 'merge:main' })
    expect(r.granted).toBe(true)
    if (!r.granted) throw new Error('unreachable')
    expect(r.alreadyHeld).toBe(false)
    expect(r.lock.holder).toEqual({ sessionId: 'sess_1', issueId: 'iss_1', label: 'issue:#1' })
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
    const { svc } = harness()
    svc.acquire(agent(1), { repoPath: REPO, name: 'l' })
    const q2 = svc.acquire(agent(2), { repoPath: REPO, name: 'l' })
    expect(q2).toMatchObject({ granted: false, position: 1 })
    const q3 = svc.acquire(agent(3), { repoPath: REPO, name: 'l' })
    expect(q3).toMatchObject({ granted: false, position: 2 })
    // waiter dedup: same session again → same position, no duplicate row
    const q2again = svc.acquire(agent(2), { repoPath: REPO, name: 'l' })
    expect(q2again).toMatchObject({ granted: false, position: 1 })
    if (q2again.granted) throw new Error('unreachable')
    expect(q2again.lock.queue).toHaveLength(2)
    expect(q2again.lock.holder.label).toBe('issue:#1')
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
    svc.releaseForSession('sess_1')
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

  it('locks are scoped by repo_id: the same name in another repo is independent', () => {
    const { svc } = harness()
    svc.acquire(agent(1), { repoPath: '/repo-a', name: 'merge:main' })
    const other = svc.acquire(agent(2), { repoPath: '/repo-b', name: 'merge:main' })
    expect(other.granted).toBe(true)
  })
})
