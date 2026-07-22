/**
 * POD-168 — manual order via persisted sortKey (POD-100 §4):
 * create mints a key ABOVE its sibling scope's minimum ("new at top" R2),
 * scopes are independent key spaces (top level vs a parent's children),
 * and issues.update round-trips a key while rejecting malformed ones.
 * Exercised through the tRPC command layer, same as the create-provenance suite.
 */
import { describe, expect, it } from 'vitest'
import { OPERATOR } from './issue-authz'
import { SessionRegistry } from './relay'
import { appRouter } from './router'

const ctx = (registry: SessionRegistry) =>
  appRouter.createCaller({
    registry,
    repos: {} as never,
    superagent: {} as never,
    capability: OPERATOR,
  })

describe('sortKey minting on create (POD-168)', () => {
  it('each new top-level issue mints above the scope minimum', async () => {
    const reg = new SessionRegistry()
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
    const reg = new SessionRegistry()
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
    const reg = new SessionRegistry()
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
    const reg = new SessionRegistry()
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
    const reg = new SessionRegistry()
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
    const reg = new SessionRegistry()
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
