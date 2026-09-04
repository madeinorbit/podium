/**
 * The locks aggregate's behaviour as it is TODAY, pinned before the drizzle
 * conversion [POD-3394, spec §6 rule 21, method §3 checklist item 10].
 *
 * WHY THIS FILE EXISTS. The coverage census (POD-3244) puts eleven of
 * `LocksRepository`'s twelve methods in its "executed, but never named in any
 * test file" column: they reach a test only through `modules/lock/service.ts`,
 * so the test that would go red does not mention the method, and a reviewer
 * reading a conversion diff cannot see which test protects it. That is the
 * census's own description of where "an incidental behaviour change can pass" —
 * row order, `undefined` versus `null`, a silently dropped column.
 *
 * WHAT IT PINS, and it is deliberately the SQL's semantics rather than the
 * service's rules. Three of these are places where the obvious drizzle spelling
 * is not the current behaviour, and each has its own test naming the trap:
 *
 *   - `renewLock` matches the holder with `IS ?`, not `= ?`, so it renews an
 *     operator's lease (holder NULL). `eq(locks.holderSessionId, null)` emits
 *     `= NULL`, which matches no row, and the operator could then never renew.
 *   - `listLocksHeldBySession` matches with `= ?` and so deliberately does NOT
 *     see an operator-held lock. The asymmetry with `renewLock` is the thing to
 *     preserve; making both the same would be a behaviour change either way.
 *   - `enqueueWaiter`'s conflict update sets `ttl_seconds` and `note` and
 *     NOTHING else, so a re-acquire keeps the original label, issue and FIFO
 *     position. A conversion that spreads the whole row into `set` would move
 *     the waiter's identity without moving its place in the queue.
 *
 * The lease and queue SEMANTICS (grant, FIFO advance, expiry sweep, steal) are
 * the service's and are not restated here; this file is about what the rows do.
 */

import { asIssueId, asRepoId, type SessionId } from '@podium/model'
import { expect, it } from 'vitest'
import { type LockRow, type LockSessionKey, OPERATOR_LOCK_SESSION } from './locks'
import { openTestStore } from '../test-support/open-test-store'

const repo = asRepoId('repo-1')
const other = asRepoId('repo-2')
const s1 = 'sess-1' as SessionId
const s2 = 'sess-2' as SessionId

function lock(overrides: Partial<LockRow> = {}): LockRow {
  return {
    repoId: repo,
    name: 'build',
    holderSessionId: s1,
    holderIssueId: asIssueId('iss-1'),
    holderLabel: 'the builder',
    note: 'a note',
    acquiredAt: '2026-09-01T00:00:00.000Z',
    expiresAt: '2026-09-01T00:10:00.000Z',
    ...overrides,
  }
}

it('reads a lock back exactly as it was written, and reports a missing one as null', async () => {
  const store = await openTestStore(':memory:')
  try {
    expect(store.locks.getLock(repo, 'build')).toBeNull()

    const row = lock()
    store.locks.upsertLock(row)
    expect(store.locks.getLock(repo, 'build')).toEqual(row)

    // Absent optional columns come back as `null`, never `undefined`: the mapper
    // coalesces, and a conversion that returned the raw column would hand a
    // caller `undefined` for a lock the operator holds with no note.
    store.locks.upsertLock(lock({ name: 'free', holderSessionId: null, holderIssueId: null, note: null }))
    const bare = store.locks.getLock(repo, 'free')
    expect(bare).not.toBeNull()
    expect(bare?.holderSessionId).toBeNull()
    expect(bare?.holderIssueId).toBeNull()
    expect(bare?.note).toBeNull()
  } finally {
    store.close()
  }
})

it('lists one repo’s locks by name, and leaves another repo’s alone', async () => {
  const store = await openTestStore(':memory:')
  try {
    store.locks.upsertLock(lock({ name: 'ship' }))
    store.locks.upsertLock(lock({ name: 'build' }))
    store.locks.upsertLock(lock({ name: 'merge' }))
    store.locks.upsertLock(lock({ repoId: other, name: 'aardvark' }))

    expect(store.locks.listLocks(repo).map((l) => l.name)).toEqual(['build', 'merge', 'ship'])
    expect(store.locks.listLocks(other).map((l) => l.name)).toEqual(['aardvark'])
    expect(store.locks.listLocks(asRepoId('repo-none'))).toEqual([])
  } finally {
    store.close()
  }
})

it('treats a lease expiring exactly at the sweep instant as expired, and one a millisecond later as live', async () => {
  const store = await openTestStore(':memory:')
  try {
    const now = '2026-09-01T00:10:00.000Z'
    store.locks.upsertLock(lock({ name: 'past', expiresAt: '2026-09-01T00:09:59.999Z' }))
    store.locks.upsertLock(lock({ name: 'exactly', expiresAt: now }))
    store.locks.upsertLock(lock({ name: 'future', expiresAt: '2026-09-01T00:10:00.001Z' }))

    // BOTH EDGES, because the comparison is `<=` and a conversion to `lt` would
    // leave the boundary lock held forever by exactly one millisecond.
    const expired = store.locks.listExpiredLocks(repo, now).map((l) => l.name).sort()
    expect(expired).toEqual(['exactly', 'past'])
  } finally {
    store.close()
  }
})

it('finds the locks a session holds across repos, and does not count an operator lock as anyone’s', async () => {
  const store = await openTestStore(':memory:')
  try {
    store.locks.upsertLock(lock({ name: 'build', holderSessionId: s1 }))
    store.locks.upsertLock(lock({ repoId: other, name: 'ship', holderSessionId: s1 }))
    store.locks.upsertLock(lock({ name: 'merge', holderSessionId: s2 }))
    store.locks.upsertLock(lock({ name: 'operator-held', holderSessionId: null }))

    const held = store.locks.listLocksHeldBySession(s1)
    expect(held.map((l) => `${l.repoId}/${l.name}`).sort()).toEqual(['repo-1/build', 'repo-2/ship'])

    // `holder_session_id = ?` never matches NULL, so the session-exit sweep
    // leaves an operator's lease alone. That is the current contract and the
    // reason this repository's two holder predicates are spelled differently.
    expect(store.locks.listLocksHeldBySession(null as unknown as LockSessionKey)).toEqual([])
    expect(store.locks.listLocksHeldBySession(OPERATOR_LOCK_SESSION)).toEqual([])
  } finally {
    store.close()
  }
})

it('replaces every lease column on a second acquire of the same lock', async () => {
  const store = await openTestStore(':memory:')
  try {
    store.locks.upsertLock(lock())
    const taken = lock({
      holderSessionId: s2,
      holderIssueId: null,
      holderLabel: 'the shipper',
      note: null,
      acquiredAt: '2026-09-01T00:05:00.000Z',
      expiresAt: '2026-09-01T00:15:00.000Z',
    })
    store.locks.upsertLock(taken)

    expect(store.locks.getLock(repo, 'build')).toEqual(taken)
    // One row, not two: the conflict target is the whole primary key.
    expect(store.locks.listLocks(repo)).toHaveLength(1)
  } finally {
    store.close()
  }
})

it('renews only for the session that holds the lock, and for the operator whose holder is null', async () => {
  const store = await openTestStore(':memory:')
  try {
    store.locks.upsertLock(lock())
    const later = '2026-09-01T00:20:00.000Z'

    expect(store.locks.renewLock(repo, 'build', s2, later)).toBe(false)
    expect(store.locks.renewLock(repo, 'build', null, later)).toBe(false)
    expect(store.locks.getLock(repo, 'build')?.expiresAt).toBe('2026-09-01T00:10:00.000Z')

    expect(store.locks.renewLock(repo, 'build', s1, later)).toBe(true)
    expect(store.locks.getLock(repo, 'build')?.expiresAt).toBe(later)

    // THE `IS ?` CASE. An operator's lease has a NULL holder, and `= NULL`
    // matches nothing, so a conversion that reaches for `eq` here would make
    // the operator's lock unrenewable and silently expire it.
    store.locks.upsertLock(lock({ name: 'operator-held', holderSessionId: null }))
    expect(store.locks.renewLock(repo, 'operator-held', null, later)).toBe(true)
    expect(store.locks.getLock(repo, 'operator-held')?.expiresAt).toBe(later)

    // A lock that is not there renews as false rather than throwing.
    expect(store.locks.renewLock(repo, 'absent', s1, later)).toBe(false)
  } finally {
    store.close()
  }
})

it('deletes one lock and leaves the rest, and deleting an absent lock is not an error', async () => {
  const store = await openTestStore(':memory:')
  try {
    store.locks.upsertLock(lock({ name: 'build' }))
    store.locks.upsertLock(lock({ name: 'ship' }))
    store.locks.upsertLock(lock({ repoId: other, name: 'build' }))

    store.locks.deleteLock(repo, 'build')
    expect(store.locks.listLocks(repo).map((l) => l.name)).toEqual(['ship'])
    expect(store.locks.listLocks(other).map((l) => l.name)).toEqual(['build'])

    expect(() => store.locks.deleteLock(repo, 'build')).not.toThrow()
  } finally {
    store.close()
  }
})

it('keeps the waiter queue in arrival order, per lock', async () => {
  const store = await openTestStore(':memory:')
  try {
    const waiter = (sessionId: LockSessionKey, name = 'build') => ({
      repoId: repo,
      name,
      sessionId,
      issueId: null,
      label: String(sessionId),
      ttlSeconds: 120,
      note: null,
      enqueuedAt: '2026-09-01T00:00:00.000Z',
    })
    store.locks.enqueueWaiter(waiter(s1))
    store.locks.enqueueWaiter(waiter(s2))
    store.locks.enqueueWaiter(waiter('sess-3' as SessionId))
    store.locks.enqueueWaiter(waiter(s1, 'ship'))

    const queue = store.locks.listWaiters(repo, 'build')
    expect(queue.map((w) => w.sessionId)).toEqual([s1, s2, 'sess-3'])
    // FIFO is the rowid, so the ids ascend with arrival.
    expect(queue.map((w) => w.id)).toEqual([...queue.map((w) => w.id)].sort((a, b) => a - b))
    expect(store.locks.listWaiters(repo, 'ship').map((w) => w.sessionId)).toEqual([s1])
    expect(store.locks.listWaiters(repo, 'none')).toEqual([])
  } finally {
    store.close()
  }
})

it('re-queueing a waiter updates its ttl and note in place and moves nothing else', async () => {
  const store = await openTestStore(':memory:')
  try {
    const first = {
      repoId: repo,
      name: 'build',
      sessionId: s1 as LockSessionKey,
      issueId: asIssueId('iss-1'),
      label: 'the first label',
      ttlSeconds: 120,
      note: 'the first note',
      enqueuedAt: '2026-09-01T00:00:00.000Z',
    }
    store.locks.enqueueWaiter(first)
    store.locks.enqueueWaiter({ ...first, sessionId: s2, label: 'behind' })
    const before = store.locks.listWaiters(repo, 'build')
    expect(before.map((w) => w.sessionId)).toEqual([s1, s2])

    store.locks.enqueueWaiter({
      ...first,
      issueId: asIssueId('iss-changed'),
      label: 'a later label',
      ttlSeconds: 600,
      note: 'a later note',
      enqueuedAt: '2026-09-01T00:09:00.000Z',
    })

    const after = store.locks.listWaiters(repo, 'build')
    expect(after).toHaveLength(2)
    // Still first in the queue, and still the same row.
    expect(after[0]?.id).toBe(before[0]?.id)
    expect(after[0]?.sessionId).toBe(s1)
    // Updated by the conflict clause.
    expect(after[0]?.ttlSeconds).toBe(600)
    expect(after[0]?.note).toBe('a later note')
    // NOT updated: the conflict clause names two columns and only two.
    expect(after[0]?.label).toBe('the first label')
    expect(after[0]?.issueId).toBe(asIssueId('iss-1'))
    expect(after[0]?.enqueuedAt).toBe('2026-09-01T00:00:00.000Z')
  } finally {
    store.close()
  }
})

it('removes a waiter by row id and by session, and lists every lock a session waits on', async () => {
  const store = await openTestStore(':memory:')
  try {
    const waiter = (sessionId: LockSessionKey, name: string, repoId = repo) => ({
      repoId,
      name,
      sessionId,
      issueId: null,
      label: 'w',
      ttlSeconds: 120,
      note: null,
      enqueuedAt: '2026-09-01T00:00:00.000Z',
    })
    store.locks.enqueueWaiter(waiter(s1, 'build'))
    store.locks.enqueueWaiter(waiter(s2, 'build'))
    store.locks.enqueueWaiter(waiter(s1, 'ship'))
    store.locks.enqueueWaiter(waiter(s1, 'build', other))

    expect(store.locks.listWaitsBySession(s1).map((w) => `${w.repoId}/${w.name}`)).toEqual([
      'repo-1/build',
      'repo-1/ship',
      'repo-2/build',
    ])

    const target = store.locks.listWaiters(repo, 'build').find((w) => w.sessionId === s2)
    expect(target).toBeDefined()
    if (target) store.locks.removeWaiter(target.id)
    expect(store.locks.listWaiters(repo, 'build').map((w) => w.sessionId)).toEqual([s1])

    // By session removes one lock's waiter, not every wait that session holds.
    store.locks.removeWaiterBySession(repo, 'build', s1)
    expect(store.locks.listWaiters(repo, 'build')).toEqual([])
    expect(store.locks.listWaitsBySession(s1).map((w) => `${w.repoId}/${w.name}`)).toEqual([
      'repo-1/ship',
      'repo-2/build',
    ])
  } finally {
    store.close()
  }
})
