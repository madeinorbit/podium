/**
 * THE REPLICA NEVER REACHES FOR AMBIENT STORAGE (POD-1239).
 *
 * POD-307 specifies the client's persisted store as fail-closed: a store that
 * cannot be attributed to the current principal is DISCARDED and re-bootstrapped,
 * never adopted. POD-377 built the gate (`decideLegacyAdoption`), POD-378 verified
 * it, and no client ever called it — six sites construct a replica over persisted
 * storage and none asks who owns the rows.
 *
 * Fixing those six individually still leaves the hole, because a seventh needs no
 * site at all: `createReplica()` with no storage argument used to resolve
 * `window.localStorage` itself, so a replica could adopt a previous user's rows
 * without any composition root existing to be graded. That is the shape this file
 * pins closed — the ambient REACH, not any one caller.
 *
 * BOTH ARMS ARE DRIVEN. A test that only ever hands the replica a store proves
 * nothing about what it does when handed none: an empty result would be
 * indistinguishable from an ambient store that happened to be empty. So the
 * unattributed arm first PROVES the ambient store is populated (by adopting it
 * through the explicit seam) and only then asserts that the ambient reach refuses
 * it. Without that counterfactual this test passes on a replica that reads
 * localStorage exactly as before.
 */

import type { SessionMeta } from '@podium/model'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createReplica, type ReplicaInit } from './replica'

function session(id: string): SessionMeta {
  return {
    sessionId: id,
    agentKind: 'claude-code',
    title: id,
    cwd: '/w',
    status: 'live',
    controllerId: 'c0',
    geometry: { cols: 80, rows: 24 },
    epoch: 0,
    clientCount: 1,
    createdAt: '2026-07-01T00:00:00.000Z',
    lastActiveAt: '2026-07-01T00:00:00.000Z',
    origin: { kind: 'spawn' },
    archived: false,
    readAt: null,
    unread: false,
  } as unknown as SessionMeta
}

/** Map-backed storage seam (mirrors apps/web/src/app/replica.test.ts). */
function makeStorage(): NonNullable<ReplicaInit['storage']> {
  const data = new Map<string, string>()
  return {
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => void data.set(k, v),
    removeItem: (k) => void data.delete(k),
  }
}

const settle = (): Promise<unknown> => new Promise((r) => setTimeout(r, 0))

/** A store carrying one previous session, under the DEFAULT key prefix — the
 *  prefix an ambient reach would use, so the seed is reachable by both arms. */
async function storeWithAPreviousSession(): Promise<NonNullable<ReplicaInit['storage']>> {
  const storage = makeStorage()
  const seed = createReplica({ storage })
  seed.applySnapshot('sessions', [session('previous-user-session')])
  await settle()
  return storage
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('ambient storage adoption', () => {
  it('adopts a store it was HANDED (the arm that must say yes)', async () => {
    const storage = await storeWithAPreviousSession()
    const hydrated = await createReplica({ storage }).hydrate()
    expect(hydrated.sessions.map((s) => s.sessionId)).toEqual(['previous-user-session'])
  })

  it('refuses a store it was never handed, even when window.localStorage holds it', async () => {
    const storage = await storeWithAPreviousSession()
    vi.stubGlobal('window', {
      localStorage: storage,
      addEventListener: () => {},
      removeEventListener: () => {},
    })

    // COUNTERFACTUAL. Without this the assertion below is vacuous: an empty
    // hydrate is what an EMPTY ambient store yields too, so the test would pass
    // against a replica that still reads localStorage and simply found nothing.
    // Reaching the same bytes through the explicit seam proves they are there
    // and readable, which leaves refusal as the only explanation for the miss.
    const throughTheSeam = await createReplica({
      storage: (globalThis as { window: { localStorage: NonNullable<ReplicaInit['storage']> } })
        .window.localStorage,
    }).hydrate()
    expect(throughTheSeam.sessions.map((s) => s.sessionId)).toEqual(['previous-user-session'])

    const replica = createReplica()
    const hydrated = await replica.hydrate()
    expect(hydrated.sessions).toEqual([])
    expect(hydrated.cursor).toBeNull()
    // And it did not quietly persist into that store either: a replica with no
    // store is a memory replica, which reports itself as non-durable rather
    // than pretending a reload will keep anything.
    expect(replica.persistent).toBe(false)
  })

  it('does not write into ambient window.localStorage either', async () => {
    const storage = await storeWithAPreviousSession()
    const writes: string[] = []
    vi.stubGlobal('window', {
      localStorage: {
        getItem: (k: string) => storage.getItem(k),
        setItem: (k: string, v: string) => {
          writes.push(k)
          storage.setItem(k, v)
        },
        removeItem: (k: string) => storage.removeItem(k),
      },
      addEventListener: () => {},
      removeEventListener: () => {},
    })
    const replica = createReplica()
    replica.applySnapshot('sessions', [session('this-user-session')])
    await settle()
    expect(writes).toEqual([])
    // The previous user's row is still exactly as it was — not merged with,
    // not overwritten by, this replica's state.
    const survivor = await createReplica({ storage }).hydrate()
    expect(survivor.sessions.map((s) => s.sessionId)).toEqual(['previous-user-session'])
  })
})
