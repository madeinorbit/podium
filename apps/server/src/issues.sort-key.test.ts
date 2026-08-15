/**
 * POD-168 — manual order via persisted sortKey (POD-100 §4):
 * create mints a key ABOVE its sibling scope's minimum ("new at top" R2),
 * scopes are independent key spaces (top level vs a parent's children),
 * and issues.update round-trips a key while rejecting malformed ones.
 * Exercised through the tRPC command layer, same as the create-provenance suite.
 */
import { SORT_KEY_COMPACT_LEN, SORT_KEY_MAX_LEN, sortKeyBetween } from '@podium/model'
import { describe, expect, it } from 'vitest'
import { resolvePrincipal } from './command-principal'

import { SessionRegistry } from './relay'
import { appRouter } from './router'
import { OPERATOR } from './test-support/capabilities'

const ctx = (registry: SessionRegistry) =>
  appRouter.createCaller({
    registry,
    repos: {} as never,
    superagent: {} as never,
    capability: OPERATOR,
    principal: resolvePrincipal(OPERATOR, { parentSessionOf: () => undefined }),
  })

describe('sortKey minting on create (POD-168)', () => {
  it('each new top-level issue mints above the scope minimum', async () => {
    const reg = new SessionRegistry(undefined, undefined, { instanceId: 'default' })
    try {
      const op = ctx(reg)
      const a = await op.issues.create({ repoPath: '/r', title: 'first', startNow: false })
      const b = await op.issues.create({ repoPath: '/r', title: 'second', startNow: false })
      const c = await op.issues.create({ repoPath: '/r', title: 'third', startNow: false })
      const [ka, kb, kc] = [a.sortKey ?? '', b.sortKey ?? '', c.sortKey ?? '']
      expect(ka).toBeTruthy()
      expect(kb).toBeTruthy()
      expect(kc).toBeTruthy()
      // Ascending key = top of the list: newest created holds the smallest key.
      expect(kc < kb).toBe(true)
      expect(kb < ka).toBe(true)
    } finally {
      reg.dispose()
    }
  })

  it("a parent's children are an independent key space", async () => {
    const reg = new SessionRegistry(undefined, undefined, { instanceId: 'default' })
    try {
      const op = ctx(reg)
      const first = await op.issues.create({ repoPath: '/r', title: 'top A', startNow: false })
      await op.issues.create({ repoPath: '/r', title: 'top B', startNow: false })
      const parent = await op.issues.create({ repoPath: '/r', title: 'parent', startNow: false })
      const c1 = await op.issues.create({
        repoPath: '/r',
        title: 'child one',
        parentId: parent.id,
        startNow: false,
      })
      const c2 = await op.issues.create({
        repoPath: '/r',
        title: 'child two',
        parentId: parent.id,
        startNow: false,
      })
      // The child scope starts from the same empty-scope seed the very first
      // top-level issue got — proof it never saw the top-level keys.
      expect(c1.sortKey).toBe(first.sortKey)
      expect((c2.sortKey ?? '') < (c1.sortKey ?? '~')).toBe(true)
    } finally {
      reg.dispose()
    }
  })

  it('scopes are per repo group at the top level', async () => {
    const reg = new SessionRegistry(undefined, undefined, { instanceId: 'default' })
    try {
      const op = ctx(reg)
      const a = await op.issues.create({ repoPath: '/r1', title: 'repo1 top', startNow: false })
      const b = await op.issues.create({ repoPath: '/r2', title: 'repo2 top', startNow: false })
      // Second repo's first issue seeds fresh — not below repo1's key.
      expect(b.sortKey).toBe(a.sortKey)
    } finally {
      reg.dispose()
    }
  })
})

describe('sortKey update patch (POD-168)', () => {
  it('round-trips through issues.update and persists on the wire', async () => {
    const reg = new SessionRegistry(undefined, undefined, { instanceId: 'default' })
    try {
      const op = ctx(reg)
      const a = await op.issues.create({ repoPath: '/r', title: 'movable', startNow: false })
      const updated = await op.issues.update({ id: a.id, patch: { sortKey: 'x2c' } })
      expect((updated as { sortKey?: string }).sortKey).toBe('x2c')
      const listed = await op.issues.list({ repoPath: '/r' })
      expect(listed.find((i) => i.id === a.id)?.sortKey).toBe('x2c')
    } finally {
      reg.dispose()
    }
  })

  it('rejects malformed keys (uppercase, trailing zero, empty)', async () => {
    const reg = new SessionRegistry(undefined, undefined, { instanceId: 'default' })
    try {
      const op = ctx(reg)
      const a = await op.issues.create({ repoPath: '/r', title: 'guarded', startNow: false })
      await expect(op.issues.update({ id: a.id, patch: { sortKey: 'ABC' } })).rejects.toThrow()
      await expect(op.issues.update({ id: a.id, patch: { sortKey: 'a0' } })).rejects.toThrow()
      await expect(op.issues.update({ id: a.id, patch: { sortKey: '' } })).rejects.toThrow()
    } finally {
      reg.dispose()
    }
  })

  it('pin/unpin leaves the sortKey untouched (unpin returns to its position)', async () => {
    const reg = new SessionRegistry(undefined, undefined, { instanceId: 'default' })
    try {
      const op = ctx(reg)
      const a = await op.issues.create({ repoPath: '/r', title: 'pin me', startNow: false })
      const key = a.sortKey
      const pinned = await op.issues.update({ id: a.id, patch: { pinned: true } })
      expect((pinned as { sortKey?: string }).sortKey).toBe(key)
      const unpinned = await op.issues.update({ id: a.id, patch: { pinned: false } })
      expect((unpinned as { sortKey?: string }).sortKey).toBe(key)
    } finally {
      reg.dispose()
    }
  })
})

/**
 * POD-1102 — a long-lived repo used to reorder itself into a corner.
 *
 * "New at top" mints below the scope minimum on EVERY create, so the minimum
 * grows a character every five issues, without bound. The create never notices
 * (it mints inside the service, past the wire schema); the DRAG does, because
 * the key a client plans against those rows is the one thing that has to travel
 * back over `issues.update` — and at 128 characters the schema refuses it. The
 * operator sees a row snap home under an error toast, on a board that has done
 * nothing wrong except last a while.
 */
describe('sortKey scope compaction (POD-1102)', () => {
  /** Enough head-inserts to drive a scope's minimum past `n` characters. */
  const createsToReach = (n: number): number => {
    let key: string | null = null
    let creates = 0
    while ((key?.length ?? 0) < n) {
      key = sortKeyBetween(null, key)
      creates += 1
    }
    return creates
  }

  it('keeps a long scope writable, in the order the operator is looking at', async () => {
    const reg = new SessionRegistry(undefined, undefined, { instanceId: 'default' })
    try {
      const op = ctx(reg)
      const ids: string[] = []
      // Past the point where the minimum reaches the compaction threshold, so
      // the repair has had to fire at least once.
      for (let i = 0; i < createsToReach(SORT_KEY_COMPACT_LEN) + 20; i++) {
        const issue = await op.issues.create({
          repoPath: '/r',
          title: `task ${i}`,
          startNow: false,
        })
        ids.push(issue.id)
      }
      const rows = (await op.issues.list({ repoPath: '/r' }))
        .slice()
        .sort((a, b) => (a.sortKey ?? '').localeCompare(b.sortKey ?? ''))
      const keys = rows.map((r) => r.sortKey ?? '')
      expect(keys.every((k) => k.length > 0)).toBe(true)
      // The property the client depends on: every key is one the wire will take
      // back, so a reorder planned against ANY pair of these rows lands rather
      // than coming home as a 400 under an error toast.
      expect(Math.max(...keys.map((k) => k.length))).toBeLessThan(SORT_KEY_MAX_LEN)
      // Compaction happened, rather than the scope staying small by luck.
      expect(Math.max(...keys.map((k) => k.length))).toBeLessThanOrEqual(SORT_KEY_COMPACT_LEN)
      // Newest first is what these keys have always meant; a renumber that
      // reshuffled the column would be worse than the long keys it replaces.
      expect(rows.map((r) => r.id)).toEqual([...ids].reverse())
    } finally {
      reg.dispose()
    }
  }, 60_000)

  it('a reorder into a long scope compacts it, keeping the drop where it was dropped', async () => {
    const reg = new SessionRegistry(undefined, undefined, { instanceId: 'default' })
    try {
      const op = ctx(reg)
      const ids: string[] = []
      for (let i = 0; i < createsToReach(SORT_KEY_COMPACT_LEN); i++) {
        const issue = await op.issues.create({
          repoPath: '/r',
          title: `task ${i}`,
          startNow: false,
        })
        ids.push(issue.id)
      }
      const before = (await op.issues.list({ repoPath: '/r' }))
        .slice()
        .sort((a, b) => (a.sortKey ?? '').localeCompare(b.sortKey ?? ''))
      // Drag the bottom row up between the 2nd and 3rd, exactly as the sidebar
      // plans it: the midpoint of its NEW neighbours' current keys.
      const moved = before.at(-1)!
      const target = sortKeyBetween(before[1]?.sortKey ?? null, before[2]?.sortKey ?? null)
      await op.issues.update({ id: moved.id, patch: { sortKey: target } })
      const after = (await op.issues.list({ repoPath: '/r' }))
        .slice()
        .sort((a, b) => (a.sortKey ?? '').localeCompare(b.sortKey ?? ''))
      expect(after[2]?.id).toBe(moved.id)
      expect(after.map((r) => r.id)).toEqual([
        before[0]?.id,
        before[1]?.id,
        moved.id,
        ...before.slice(2, -1).map((r) => r.id),
      ])
      // ...and the scope came out of it short, so the next drag is a fast path.
      expect(Math.max(...after.map((r) => (r.sortKey ?? '').length))).toBeLessThanOrEqual(
        SORT_KEY_COMPACT_LEN,
      )
    } finally {
      reg.dispose()
    }
  })

  it('leaves a young scope alone — compaction is a repair, not a policy', async () => {
    const reg = new SessionRegistry(undefined, undefined, { instanceId: 'default' })
    try {
      const op = ctx(reg)
      const a = await op.issues.create({ repoPath: '/r', title: 'one', startNow: false })
      const b = await op.issues.create({ repoPath: '/r', title: 'two', startNow: false })
      await op.issues.create({ repoPath: '/r', title: 'three', startNow: false })
      const rows = await op.issues.list({ repoPath: '/r' })
      expect(rows.find((r) => r.id === a.id)?.sortKey).toBe(a.sortKey)
      expect(rows.find((r) => r.id === b.id)?.sortKey).toBe(b.sortKey)
    } finally {
      reg.dispose()
    }
  })
})
