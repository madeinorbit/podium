import { SORT_KEY_MAX_LEN } from '@podium/model'
import { afterAll, describe, expect, it } from 'vitest'
import { resolvePrincipal } from './command-principal'
import { SessionRegistry } from './relay'
import { appRouter } from './router'
import { OPERATOR } from './test-support/capabilities'

const registries: SessionRegistry[] = []
afterAll(async () => {
  for (const registry of registries.splice(0)) await registry.dispose()
})

async function fixture() {
  const registry = await SessionRegistry.create(undefined, undefined, { instanceId: 'default' })
  registries.push(registry)
  await registry.sessionStore.repos.addRepo('/r', registry.sessionStore.hostMachineId, undefined, 'POD')
  await registry.sessionStore.repos.addRepo('/other', registry.sessionStore.hostMachineId, undefined, 'OTH')
  const op = appRouter.createCaller({
    registry,
    repos: {} as never,
    superagent: {} as never,
    capability: OPERATOR,
    principal: resolvePrincipal(OPERATOR, { parentSessionOf: () => undefined }),
  })
  const create = (title: string, parentId?: string, repoPath = '/r') =>
    op.issues.create({ repoPath, title, parentId, startNow: false })
  const parent = await create('parent')
  const a = await create('a', parent.id)
  const b = await create('b', parent.id)
  const c = await create('c', parent.id)
  const d = await create('d', parent.id)
  const siblings = async () => (await op.issues.list({ repoPath: '/r' }))
    .filter((row) => row.parentId === parent.id)
    .sort((a, b) => (a.sortKey ?? '') < (b.sortKey ?? '') ? -1 : 1)
  const order = async () => (await siblings()).map((row) => row.title)
  return { registry, op, create, parent, a, b, c, d, siblings, order }
}

describe('sibling-relative issue moves', () => {
  it('moves before/after at the ends and between siblings, preserving all other keys and activity', async () => {
    const { registry, op, a, b, c, d, siblings, order } = await fixture()
    await registry.issues.crud.markIssueRead(a.id)
    const before = await siblings()
    expect(await order()).toEqual(['d', 'c', 'b', 'a'])
    const moved = await op.issues.move({ id: a.id, before: d.id })
    expect(await order()).toEqual(['a', 'd', 'c', 'b'])
    expect(moved.updatedAt).toBe(a.updatedAt)
    expect(await registry.issues.reports.unreadFor(a.id)).toBe(false)
    expect((await registry.sessionStore.issues.getIssue(a.id))?.sortKey).toBe(moved.sortKey)
    for (const sibling of (await siblings()).filter((row) => row.id !== a.id)) {
      expect(sibling.sortKey).toBe(before.find((row) => row.id === sibling.id)?.sortKey)
    }
    await op.issues.move({ id: a.id, after: b.id })
    expect(await order()).toEqual(['d', 'c', 'b', 'a'])
    await op.issues.move({ id: a.id, before: c.id })
    expect(await order()).toEqual(['d', 'a', 'c', 'b'])
    await op.issues.move({ id: a.id, after: c.id })
    expect(await order()).toEqual(['d', 'c', 'a', 'b'])
    await op.issues.move({ id: a.id, after: c.id })
    expect(await order()).toEqual(['d', 'c', 'a', 'b'])
  })

  it('resolves prefixed and numeric references, including top-level siblings', async () => {
    const { op, create, parent } = await fixture()
    const other = await create('other root')
    const moved = await op.issues.move({ id: `POD-${parent.seq}`, before: String(other.seq) })
    expect(moved.id).toBe(parent.id)
    expect(moved.parentId).toBeUndefined()
    expect(moved.sortKey! < other.sortKey!).toBe(true)
  })

  it('refuses different parents, different top-level repositories, self and unknown references without writes', async () => {
    const { op, create, parent, a, b, siblings } = await fixture()
    const root = await create('root')
    const nested = await create('nested', b.id)
    const otherRepo = await create('other repository', undefined, '/other')
    const before = await siblings()
    for (const reference of [parent.id, root.id, nested.id]) {
      await expect(op.issues.move({ id: a.id, before: reference })).rejects.toThrow(/same parent/)
    }
    await expect(op.issues.move({ id: root.id, after: otherRepo.id })).rejects.toThrow(/repository/)
    await expect(op.issues.move({ id: a.id, after: `POD-${a.seq}` })).rejects.toThrow(/itself/)
    await expect(op.issues.move({ id: a.id, before: 'POD-99999' })).rejects.toThrow()
    await expect(op.issues.move({ id: 'POD-99999', before: b.id })).rejects.toThrow()
    expect(await siblings()).toEqual(before)
  })

  it('refuses deleted move targets and references', async () => {
    const { op, a, b } = await fixture()
    await op.issues.delete({ id: b.id })
    await expect(op.issues.move({ id: a.id, before: b.id })).rejects.toThrow(/deleted/)
    await expect(op.issues.move({ id: b.id, before: a.id })).rejects.toThrow(/deleted/)
  })

  it('repairs duplicate keys brought together by reparenting while preserving fallback order', async () => {
    const { op, a, b, c, d, order } = await fixture()
    for (const row of [b, c, d]) await op.issues.update({ id: row.id, patch: { sortKey: 'h' } })
    await op.issues.move({ id: a.id, before: c.id })
    expect(await order()).toEqual(['d', 'a', 'c', 'b'])
  })

  it('repairs legacy missing keys without treating an unkeyed reference as an open bound', async () => {
    const { registry, op, a, c, d, order } = await fixture()
    for (const row of [c, d]) {
      const stored = (await registry.sessionStore.issues.getIssue(row.id))!
      await registry.sessionStore.issues.upsertIssue({ ...stored, sortKey: null })
    }
    expect(await registry.issues.reports.getMeta(c.id)).toMatchObject({ sortKey: null })
    await op.issues.move({ id: a.id, after: d.id })
    expect(await order()).toEqual(['b', 'd', 'a', 'c'])
  })

  it('compacts at the wire ceiling and keeps pinned siblings in the same key space', async () => {
    const { op, a, d, siblings, order } = await fixture()
    await op.issues.update({ id: d.id, patch: { sortKey: `${'0'.repeat(SORT_KEY_MAX_LEN - 1)}1`, pinned: true } })
    await op.issues.move({ id: a.id, before: d.id })
    expect(await order()).toEqual(['a', 'd', 'c', 'b'])
    expect((await siblings()).every((row) => (row.sortKey?.length ?? 0) < SORT_KEY_MAX_LEN)).toBe(true)
    await op.issues.update({ id: d.id, patch: { pinned: false } })
    expect(await order()).toEqual(['a', 'd', 'c', 'b'])
  })

  it('serializes concurrent relative moves so both receive distinct positions', async () => {
    const { op, a, b, d, siblings, order } = await fixture()
    await Promise.all([
      op.issues.move({ id: a.id, before: d.id }),
      op.issues.move({ id: b.id, before: d.id }),
    ])
    expect((await order()).slice(0, 2).sort()).toEqual(['a', 'b'])
    expect((await order()).slice(2)).toEqual(['d', 'c'])
    const keys = (await siblings()).map((row) => row.sortKey)
    expect(new Set(keys).size).toBe(keys.length)
  })

  it('honors expected revision preconditions', async () => {
    const { op, a, b, order } = await fixture()
    await op.issues.update({ id: a.id, patch: { title: 'renamed' } })
    await expect(op.issues.move({ id: a.id, before: b.id, expectedRevision: a.revision })).rejects.toThrow(/revision|stale|conflict/i)
    expect(await order()).toEqual(['d', 'c', 'b', 'renamed'])
  })
})
