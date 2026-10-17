import { afterEach, describe, expect, it } from 'vitest'
import { SessionRegistry } from '../../../relay'
import { openTestStore } from '../../../test-support/open-test-store'

/**
 * THE HARD DELETE [POD-3366, site 5 of POD-3361's audit].
 *
 * `purgeEmptyDraft` deletes a row, and with it (ON DELETE SET NULL) the
 * references other rows hold to it, then reconciles the full truth inside the
 * same span, because the reconcile appends change rows durably. It is reachable
 * inside a wider span: `deleteIfEmptyDraft` is called from `attachSession`,
 * which `IssueAttachOrchestrator` wraps in one `transact`.
 *
 * These cases were written against the in-memory issue map, which had to stage
 * the removal and its cascade where the in-span reconcile could see them;
 * POD-6158 deleted the map, so the reconcile reads the database inside the
 * span. They stay as the regression for what a reader and the reconcile see,
 * committed and rolled back.
 */
describe('the hard delete waits for the outermost commit (POD-3366)', () => {
  const registries: SessionRegistry[] = []
  afterEach(async () => {
    for (const registry of registries.splice(0)) await registry.dispose()
  })

  async function build() {
    const store = await openTestStore(':memory:')
    // Issues are placed on a machine that reported their repo (2b803efb5 refuses
    // implicit placement), so the fixture's repo is reported by the host machine.
    await store.repos.addRepo('/repo', store.hostMachineId)
    const registry = await SessionRegistry.create(store, undefined, { instanceId: 'default' })
    registries.push(registry)
    return { store, registry }
  }

  const draft = async (registry: SessionRegistry, title: string) =>
    await registry.issues.crud.create({ repoPath: '/repo', title, draft: true, startNow: false })

  it('does not purge from memory when the enclosing span rolls back', async () => {
    const { store, registry } = await build()
    const doomed = await draft(registry, 'the abandoned vessel')

    await expect(store.transact(async () => {
        await registry.issues.crud.purgeEmptyDraft(doomed.id)
        // In-window the purge must be visible to its own span: the full-list
        // reconcile below it reads the map, and would otherwise re-declare the
        // row it just deleted.
        expect(await registry.issues.reports.get(doomed.id)).toBeNull()
        throw new Error('enclosing span failed')
      }),
    ).rejects.toThrow('enclosing span failed')

    // The DELETE rolled back, so the row is there again — and the map has to
    // agree. Nothing reloads between the rollback and this read, which is the
    // whole point: a reload would repopulate from the database and report a
    // pass for a map that was wrong.
    expect((await store.issues.listIssueRows()).map((row) => row.id)).toContain(doomed.id)
    expect(await registry.issues.reports.get(doomed.id)).not.toBeNull()
  })

  it('still purges when the enclosing span commits', async () => {
    const { store, registry } = await build()
    const doomed = await draft(registry, 'the abandoned vessel')

    await store.transact(async () => {
      await registry.issues.crud.purgeEmptyDraft(doomed.id)
    })

    expect(await registry.issues.reports.get(doomed.id)).toBeNull()
    expect((await store.issues.listIssueRows()).map((row) => row.id)).not.toContain(doomed.id)
  })

  it('does not let a rolled-back purge take OTHER rows with it', async () => {
    // THE DEFECT THAT WAS SPECIFIC TO THIS SITE, and the reason a targeted
    // removal replaced the reload rather than merely being deferred. `reload()`
    // rebuilt the WHOLE map from a database read taken inside the span, so a
    // rolled-back enclosing span corrupted rows that had nothing to do with the
    // purge — including writes made earlier in that same span.
    const { store, registry } = await build()
    const doomed = await draft(registry, 'the abandoned vessel')
    const bystander = await registry.issues.crud.create({
      repoPath: '/repo',
      title: 'committed title',
      startNow: false,
    })

    await expect(store.transact(async () => {
        await registry.issues.crud.update(bystander.id, { title: 'written in the same span' })
        await registry.issues.crud.purgeEmptyDraft(doomed.id)
        throw new Error('enclosing span failed')
      }),
    ).rejects.toThrow('enclosing span failed')

    expect((await registry.issues.reports.get(bystander.id))?.title).toBe('committed title')
    expect(await registry.issues.reports.get(doomed.id)).not.toBeNull()
  })

  it('rolls the in-memory cascade back with the purge', async () => {
    // The cascade has its own rollback arm. `deleteIssue` clears
    // `parent_id` / `superseded_by` / `duplicate_of` on other rows through the
    // engine's ON DELETE SET NULL, and this method mirrors that in memory — so
    // the mirrored clear has to be staged with the removal and rolled back with
    // it, or a failed purge leaves children orphaned in memory while the
    // database still has their parent.
    const { store, registry } = await build()
    const parent = await draft(registry, 'the abandoned vessel')
    const child = await registry.issues.crud.create({
      repoPath: '/repo',
      title: 'a child pointing at it',
      parentId: parent.id,
      startNow: false,
    })
    expect((await registry.issues.reports.get(child.id))?.parentId).toBe(parent.id)

    await expect(store.transact(async () => {
        await registry.issues.crud.purgeEmptyDraft(parent.id)
        // In-window the child's reference is cleared, matching what the engine
        // did inside the savepoint.
        expect((await registry.issues.reports.get(child.id))?.parentId).toBeFalsy()
        throw new Error('enclosing span failed')
      }),
    ).rejects.toThrow('enclosing span failed')

    expect((await registry.issues.reports.get(child.id))?.parentId).toBe(parent.id)
    expect(
      (await store.issues.listIssueRows()).find((row) => row.id === child.id)?.parentId,
    ).toBe(parent.id)
  })

  it('leaves the map and the database agreeing after a rolled-back purge', async () => {
    const { store, registry } = await build()
    const doomed = await draft(registry, 'the abandoned vessel')
    await registry.issues.crud.create({ repoPath: '/repo', title: 'committed issue', startNow: false })

    await expect(store.transact(async () => {
        await registry.issues.crud.purgeEmptyDraft(doomed.id)
        throw new Error('enclosing span failed')
      }),
    ).rejects.toThrow('enclosing span failed')

    const inMemory = (await registry.issues.reports
      .list())
      .map((issue) => issue.id)
      .sort()
    const inDatabase = (await store.issues
      .listIssueRows())
      .map((row) => row.id)
      .sort()
    expect(inMemory).toEqual(inDatabase)
  })
})
