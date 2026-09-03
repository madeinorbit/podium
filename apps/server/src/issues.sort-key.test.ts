/**
 * POD-168 — manual order via persisted sortKey (POD-100 §4):
 * create mints a key ABOVE its sibling scope's minimum ("new at top" R2),
 * scopes are independent key spaces (top level vs a parent's children),
 * and issues.update round-trips a key while rejecting malformed ones.
 * Exercised through the tRPC command layer, same as the create-provenance suite.
 */
import { isSortKey, SORT_KEY_COMPACT_LEN, SORT_KEY_MAX_LEN, sortKeyBetween } from '@podium/model'
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
    const reg = SessionRegistry.create(undefined, undefined, { instanceId: 'default' })
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
    const reg = SessionRegistry.create(undefined, undefined, { instanceId: 'default' })
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
    const reg = SessionRegistry.create(undefined, undefined, { instanceId: 'default' })
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
    const reg = SessionRegistry.create(undefined, undefined, { instanceId: 'default' })
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
    const reg = SessionRegistry.create(undefined, undefined, { instanceId: 'default' })
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
    const reg = SessionRegistry.create(undefined, undefined, { instanceId: 'default' })
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
    const reg = SessionRegistry.create(undefined, undefined, { instanceId: 'default' })
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

  it('a reorder lands where it was dropped and does NOT renumber the scope', async () => {
    // The asymmetry, pinned as behaviour: only CREATE lengthens keys, so only
    // create shortens them. A drag re-keys one row between two neighbours and
    // cannot move the scope's minimum, so making it pay for a whole-scope
    // renumber bought nothing and cost 2.5 seconds mid-gesture on a real board.
    const reg = SessionRegistry.create(undefined, undefined, { instanceId: 'default' })
    try {
      const op = ctx(reg)
      for (let i = 0; i < 12; i++) {
        await op.issues.create({ repoPath: '/r', title: `task ${i}`, startNow: false })
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
      // Every other row kept the exact key it had: one write, not a renumber.
      for (const row of after) {
        if (row.id === moved.id) continue
        expect(row.sortKey).toBe(before.find((r) => r.id === row.id)?.sortKey)
      }
    } finally {
      reg.dispose()
    }
  }, 60_000)

  it('accepts the drop at the TOP of a board whose keys are already long', async () => {
    // THE CASE THAT WAS ACTUALLY BROKEN, and the reason the wire ceiling had to
    // move. A board carrying keys the OLD mint grew is exactly the state an
    // operator is in when this lands, and the drop they make is the one at the
    // top — where the planned key is a character longer than anything in the
    // scope. A 128-character cap refused it at the schema, and refusing is all
    // it could do: the writer that grew those keys mints inside the service and
    // never meets a schema, so the only party the cap could ever punish was the
    // drag. Now it lands, and the row goes where it was dropped.
    const reg = SessionRegistry.create(undefined, undefined, { instanceId: 'default' })
    try {
      const op = ctx(reg)
      for (let i = 0; i < 12; i++) {
        await op.issues.create({ repoPath: '/r', title: `task ${i}`, startNow: false })
      }
      const before = (await op.issues.list({ repoPath: '/r' }))
        .slice()
        .sort((a, b) => (a.sortKey ?? '').localeCompare(b.sortKey ?? ''))
      const moved = before[8]!
      // Written directly, because the create path cannot produce these any more
      // — which is the point.
      const legacyTop = `${'0'.repeat(140)}1`
      expect(isSortKey(legacyTop)).toBe(true)
      expect(legacyTop.length).toBeGreaterThan(128)
      const target = sortKeyBetween(null, legacyTop)
      expect(target.length).toBeGreaterThan(128)
      expect(target.length).toBeLessThan(SORT_KEY_MAX_LEN)
      await expect(
        op.issues.update({ id: moved.id, patch: { sortKey: target } }),
      ).resolves.toBeTruthy()

      const after = (await op.issues.list({ repoPath: '/r' }))
        .slice()
        .sort((a, b) => (a.sortKey ?? '').localeCompare(b.sortKey ?? ''))
      expect(after[0]?.id).toBe(moved.id)
      expect(after.slice(1).map((r) => r.id)).toEqual(
        before.filter((r) => r.id !== moved.id).map((r) => r.id),
      )
      // The next CREATE is what shortens the scope back down — and it must not
      // disturb where that drop put the row.
      await op.issues.create({ repoPath: '/r', title: 'fresh', startNow: false })
      const healed = (await op.issues.list({ repoPath: '/r' }))
        .slice()
        .sort((a, b) => (a.sortKey ?? '').localeCompare(b.sortKey ?? ''))
      expect(Math.max(...healed.map((r) => (r.sortKey ?? '').length))).toBeLessThanOrEqual(
        SORT_KEY_COMPACT_LEN,
      )
      expect(healed[0]?.title).toBe('fresh')
      expect(healed[1]?.id).toBe(moved.id)
    } finally {
      reg.dispose()
    }
  }, 60_000)

  it('renumbers pinned rows too, so unpinning still lands where it used to', async () => {
    // Caught against this workspace's real data, not reasoned out: the first
    // compaction skipped pinned rows, because it borrowed the scope the MINT
    // measures — and the mint skips them on purpose. Four pinned rows kept
    // their 105-character keys while 916 others dropped to three, so the four
    // sorted straight to the top of a list they were not at the top of.
    //
    // Pin/unpin leaves `sortKey` untouched precisely so unpinning returns the
    // row to its position. That only holds while the two are comparable.
    const reg = SessionRegistry.create(undefined, undefined, { instanceId: 'default' })
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
      const order = (await op.issues.list({ repoPath: '/r' }))
        .slice()
        .sort((a, b) => (a.sortKey ?? '').localeCompare(b.sortKey ?? ''))
        .map((r) => r.id)
      // Pin one from the middle, then let the next create compact the scope.
      const pinnedId = order[5]!
      await op.issues.update({ id: pinnedId, patch: { pinned: true } })
      await op.issues.create({ repoPath: '/r', title: 'trigger', startNow: false })

      const after = await op.issues.list({ repoPath: '/r' })
      // Nothing in the space is left long — the pinned row included.
      expect(Math.max(...after.map((r) => (r.sortKey ?? '').length))).toBeLessThanOrEqual(
        SORT_KEY_COMPACT_LEN,
      )
      // Unpinned, it comes back exactly where it was: still after order[4] and
      // still before order[6].
      await op.issues.update({ id: pinnedId, patch: { pinned: false } })
      const restored = (await op.issues.list({ repoPath: '/r' }))
        .slice()
        .sort((a, b) => (a.sortKey ?? '').localeCompare(b.sortKey ?? ''))
        .map((r) => r.id)
      const at = restored.indexOf(pinnedId)
      expect(restored[at - 1]).toBe(order[4])
      expect(restored[at + 1]).toBe(order[6])
    } finally {
      reg.dispose()
    }
  }, 60_000)

  it('leaves a young scope alone — compaction is a repair, not a policy', async () => {
    const reg = SessionRegistry.create(undefined, undefined, { instanceId: 'default' })
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
