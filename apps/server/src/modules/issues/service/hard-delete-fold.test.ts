import { afterEach, describe, expect, it } from 'vitest'
import { SessionRegistry } from '../../../relay'
import { openTestStore } from '../../../test-support/open-test-store'

/**
 * THE HARD DELETE [POD-3366, site 5 of POD-3361's audit — the one whose install
 * did not fit the deferral shape].
 *
 * `purgeEmptyDraft` finished with `store.reload()`: a WHOLE-MAP re-read, run
 * from inside the enclosing span. That reads the database through the open
 * savepoint, so it installed the enclosing span's uncommitted truth as the
 * committed map — and not merely for the row being purged, because a reload
 * drops the whole map and rebuilds it. An outer rollback left every row derived
 * from rolled-back state.
 *
 * It is genuinely reachable: `deleteIfEmptyDraft` is called from
 * `attachSession`, which `IssueAttachOrchestrator` wraps in one `transact`.
 *
 * The install is now a targeted staged REMOVAL, and the full-list reconcile
 * stays inside the span because it appends change rows durably. The last test
 * here is the one that ties those two halves together: the reconcile reads
 * `allWire()` off the map, so a removal that were merely deferred rather than
 * visible in-window would make the full-truth diff declare the purged issue
 * still present.
 */
describe('the hard delete waits for the outermost commit (POD-3366)', () => {
  const registries: SessionRegistry[] = []
  afterEach(() => {
    for (const registry of registries.splice(0)) registry.dispose()
  })

  async function build() {
    const store = await openTestStore(':memory:')
    const registry = SessionRegistry.create(store, undefined, { instanceId: 'default' })
    registries.push(registry)
    return { store, registry }
  }

  const draft = (registry: SessionRegistry, title: string) =>
    registry.issues.create({ repoPath: '/repo', title, draft: true, startNow: false })

  it('does not purge from memory when the enclosing span rolls back', async () => {
    const { store, registry } = await build()
    const doomed = draft(registry, 'the abandoned vessel')

    expect(() =>
      store.transact(() => {
        registry.issues.purgeEmptyDraft(doomed.id)
        // In-window the purge must be visible to its own span: the full-list
        // reconcile below it reads the map, and would otherwise re-declare the
        // row it just deleted.
        expect(registry.issues.get(doomed.id)).toBeNull()
        throw new Error('enclosing span failed')
      }),
    ).toThrow('enclosing span failed')

    // The DELETE rolled back, so the row is there again — and the map has to
    // agree. Nothing reloads between the rollback and this read, which is the
    // whole point: a reload would repopulate from the database and report a
    // pass for a map that was wrong.
    expect((await store.issues.listIssueRows()).map((row) => row.id)).toContain(doomed.id)
    expect(registry.issues.get(doomed.id)).not.toBeNull()
  })

  it('still purges when the enclosing span commits', async () => {
    const { store, registry } = await build()
    const doomed = draft(registry, 'the abandoned vessel')

    await store.transact(() => {
      registry.issues.purgeEmptyDraft(doomed.id)
    })

    expect(registry.issues.get(doomed.id)).toBeNull()
    expect((await store.issues.listIssueRows()).map((row) => row.id)).not.toContain(doomed.id)
  })

  it('does not let a rolled-back purge take OTHER rows with it', async () => {
    // THE DEFECT THAT WAS SPECIFIC TO THIS SITE, and the reason a targeted
    // removal replaced the reload rather than merely being deferred. `reload()`
    // rebuilt the WHOLE map from a database read taken inside the span, so a
    // rolled-back enclosing span corrupted rows that had nothing to do with the
    // purge — including writes made earlier in that same span.
    const { store, registry } = await build()
    const doomed = draft(registry, 'the abandoned vessel')
    const bystander = registry.issues.create({
      repoPath: '/repo',
      title: 'committed title',
      startNow: false,
    })

    expect(() =>
      store.transact(() => {
        registry.issues.update(bystander.id, { title: 'written in the same span' })
        registry.issues.purgeEmptyDraft(doomed.id)
        throw new Error('enclosing span failed')
      }),
    ).toThrow('enclosing span failed')

    expect(registry.issues.get(bystander.id)?.title).toBe('committed title')
    expect(registry.issues.get(doomed.id)).not.toBeNull()
  })

  it('rolls the in-memory cascade back with the purge', async () => {
    // The cascade has its own rollback arm. `deleteIssue` clears
    // `parent_id` / `superseded_by` / `duplicate_of` on other rows through the
    // engine's ON DELETE SET NULL, and this method mirrors that in memory — so
    // the mirrored clear has to be staged with the removal and rolled back with
    // it, or a failed purge leaves children orphaned in memory while the
    // database still has their parent.
    const { store, registry } = await build()
    const parent = draft(registry, 'the abandoned vessel')
    const child = registry.issues.create({
      repoPath: '/repo',
      title: 'a child pointing at it',
      parentId: parent.id,
      startNow: false,
    })
    expect(registry.issues.get(child.id)?.parentId).toBe(parent.id)

    expect(() =>
      store.transact(() => {
        registry.issues.purgeEmptyDraft(parent.id)
        // In-window the child's reference is cleared, matching what the engine
        // did inside the savepoint.
        expect(registry.issues.get(child.id)?.parentId).toBeFalsy()
        throw new Error('enclosing span failed')
      }),
    ).toThrow('enclosing span failed')

    expect(registry.issues.get(child.id)?.parentId).toBe(parent.id)
    expect(
      (await store.issues.listIssueRows()).find((row) => row.id === child.id)?.parentId,
    ).toBe(parent.id)
  })

  it('leaves the map and the database agreeing after a rolled-back purge', async () => {
    const { store, registry } = await build()
    const doomed = draft(registry, 'the abandoned vessel')
    registry.issues.create({ repoPath: '/repo', title: 'committed issue', startNow: false })

    expect(() =>
      store.transact(() => {
        registry.issues.purgeEmptyDraft(doomed.id)
        throw new Error('enclosing span failed')
      }),
    ).toThrow('enclosing span failed')

    const inMemory = registry.issues
      .list()
      .map((issue) => issue.id)
      .sort()
    const inDatabase = (await store.issues
      .listIssueRows())
      .map((row) => row.id)
      .sort()
    expect(inMemory).toEqual(inDatabase)
  })
})
