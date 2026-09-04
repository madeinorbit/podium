import { afterEach, describe, expect, it } from 'vitest'
import { SessionRegistry } from '../../../relay'
import { openTestStore } from '../../../test-support/open-test-store'

/**
 * THE ISSUE ROW MAP WAITS FOR THE OUTERMOST COMMIT [POD-3366, sites 3 and 4 of
 * POD-3361's audit, and the install half of 6 and 7].
 *
 * `IssueStore.rows` is the authoritative in-memory issue projection. Every
 * persist installed into it on the statement after a `ledger.commit`, and
 * nested inside a caller's span — `IssueAttachOrchestrator` wraps a whole attach
 * in one `transact` — that commit is a SAVEPOINT whose release is not a commit.
 * A rolled-back enclosing span therefore left the map holding a row the database
 * never kept, and the next full-list reconcile would fabricate an upsert for it.
 *
 * WHAT THESE TESTS ASSERT ON, and the trap they are written around: the MAP,
 * read through `IssueService`'s own accessors, with nothing in between that
 * reloads or re-derives. `store.reload()` re-reads the database and would make
 * every one of these pass for a projection that was wrong the whole time, which
 * is exactly the self-healing fixture the brief warns about. The rollback and
 * the assertion are adjacent on purpose.
 *
 * Driven through the full registry, because the fold port is COMPOSITION: an
 * `IssueDeps` without it installs immediately and every assertion here would be
 * vacuous.
 */
describe('the issue row map waits for the outermost commit (POD-3366)', () => {
  const registries: SessionRegistry[] = []
  afterEach(() => {
    for (const registry of registries.splice(0)) registry.dispose()
  })

  async function build() {
    const store = await openTestStore(':memory:')
    const registry = SessionRegistry.create(store, undefined, { instanceId: 'default' })
    registries.push(registry)
    return { store, issues: registry.issues }
  }

  const seed = (issues: SessionRegistry['issues'], title: string) =>
    issues.create({ repoPath: '/repo', title, description: '', startNow: false })

  it('drops a row a rolled-back enclosing span installed (site 3)', async () => {
    const { store, issues } = await build()
    const created = seed(issues, 'original title')

    expect(() =>
      store.transact(() => {
        issues.update(created.id, { title: 'renamed inside the span' })
        // The savepoint is released and the map is already installed today.
        // The in-window reader must see the write…
        expect(issues.get(created.id)?.title).toBe('renamed inside the span')
        throw new Error('enclosing span failed')
      }),
    ).toThrow('enclosing span failed')

    // …and the database rolled it back, so the map must hold the committed
    // title again. Read with nothing reloaded in between.
    expect(issues.get(created.id)?.title).toBe('original title')
    expect((await store.issues.listIssueRows()).find((row) => row.id === created.id)?.title).toBe(
      'original title',
    )
  })

  it('keeps a row whose enclosing span commits (site 3)', async () => {
    const { store, issues } = await build()
    const created = seed(issues, 'original title')

    await store.transact(() => {
      issues.update(created.id, { title: 'renamed and kept' })
    })

    expect(issues.get(created.id)?.title).toBe('renamed and kept')
  })

  it('a second write to the same issue in one span sees the first (the in-window reader)', async () => {
    // WHY THIS TEST EXISTS, and it is this map's own argument. `rows` is read
    // constantly between a nested write and the enclosing commit — the next
    // command in the same orchestrated span resolves the issue through it. With
    // a bare deferral the second update would read the PRE-span row, and its
    // own write would carry the first update's field back out.
    const { store, issues } = await build()
    const created = seed(issues, 'original title')

    await store.transact(() => {
      issues.update(created.id, { title: 'first write' })
      issues.update(created.id, { description: 'second write' })
    })

    const after = issues.get(created.id)
    expect(after?.title).toBe('first write')
    expect(after?.description).toBe('second write')
  })

  it('does not leave a deleted row visible after a rolled-back delete (sites 6 and 7)', async () => {
    const { store, issues } = await build()
    const created = seed(issues, 'to be deleted')

    expect(() =>
      store.transact(() => {
        issues.update(created.id, { title: 'touched before the failure' })
        throw new Error('enclosing span failed')
      }),
    ).toThrow('enclosing span failed')

    // The row survives with its committed fields; nothing staged leaked.
    expect(issues.get(created.id)?.title).toBe('to be deleted')
  })

  it('does not serve an orphaned row to a LATER write that opens its own span', async () => {
    // THE HAZARD A BOOLEAN CANNOT SEE [POD-3366]. `spanOpen()` answers "is ANY
    // write span open", so a staged row orphaned by a rollback and then read
    // from inside a LATER commit's own transaction sees `true` and survives.
    // This map has no entry point where a holder could ask on the way in — it is
    // read from `toWire`'s scans inside `ledger.commit`'s own `write()`.
    //
    // POD-3366 read that as needing a unit IDENTITY on the fold port. It is
    // LIVENESS that closes it [POD-3364]: identity cannot separate a savepoint
    // that released from one that rolled back, because both close their frame,
    // and only the registration knows which happened.
    const { store, issues } = await build()
    const survivor = seed(issues, 'the survivor')

    expect(() =>
      store.transact(() => {
        issues.create({ repoPath: '/repo', title: 'orphaned by the rollback', startNow: false })
        throw new Error('enclosing span failed')
      }),
    ).toThrow('enclosing span failed')

    // A later, unrelated top-level write. Its own span is open while the issue
    // service reads the row map to build the wire.
    issues.update(survivor.id, { title: 'a later unrelated write' })

    const titles = issues.list().map((issue) => issue.title)
    expect(titles).not.toContain('orphaned by the rollback')
    expect(titles.sort()).toEqual(
      (await store.issues
        .listIssueRows())
        .map((row) => row.title)
        .sort(),
    )
  })

  it('a rolled-back span leaves the list agreeing with the database (the reconcile trap)', async () => {
    // The consequence the audit names for this site: a phantom row in the map is
    // not merely stale, it makes the next FULL-LIST reconcile declare an upsert
    // for an issue the database does not have. Compare the two directly.
    const { store, issues } = await build()
    seed(issues, 'committed issue')

    expect(() =>
      store.transact(() => {
        issues.create({ repoPath: '/repo', title: 'never committed', startNow: false })
        throw new Error('enclosing span failed')
      }),
    ).toThrow('enclosing span failed')

    const inMemory = issues
      .list()
      .map((issue) => issue.title)
      .sort()
    const inDatabase = (await store.issues
      .listIssueRows())
      .map((row) => row.title)
      .sort()
    expect(inMemory).toEqual(inDatabase)
    expect(inMemory).not.toContain('never committed')
  })

  it('still serves an in-window read what a RELEASED middle span staged', async () => {
    // THE OTHER HALF OF THE FRAME RULE, and the reason it is keyed on the
    // REGISTRATION rather than on the frame [POD-3364]. A savepoint that
    // releases closes its frame exactly as one that rolls back does, so
    // "is the frame that staged this still live" answers false for both. Its
    // work is still pending in the parent's registry, though, and a reader in
    // the outer span must still see it — a middle span whose release dropped
    // its own staged row would be the lost-update this layer exists to stop.
    const { store, issues } = await build()
    const created = seed(issues, 'original title')
    let seenInsideTheWindow: string | undefined

    await store.transact(() => {
      store.transact(() => {
        issues.update(created.id, { title: 'staged by the middle span' })
      })
      seenInsideTheWindow = issues.get(created.id)?.title
    })

    expect(seenInsideTheWindow).toBe('staged by the middle span')
    expect(issues.get(created.id)?.title).toBe('staged by the middle span')
  })

  it('does not shadow an in-window read with a row a MIDDLE span rolled back', async () => {
    // THE RESIDUE POD-3328 LEFT AND POD-3366 CARRIED FORWARD [POD-3364]. The
    // staged layer drops an orphan when NO span is open, and a middle span that
    // rolls back inside a committing outer one never reaches that state:
    // `spanOpen()` still answers true for the OUTER frame, so the entry the
    // inner frame staged survives in the pending layer and shadows every read
    // for the rest of the outer span.
    //
    // The assertion is INSIDE the outer span on purpose. Read after it commits
    // and the next top-level operation has already freshened the orphan away —
    // which is the self-healing fixture that hides exactly this state.
    const { store, issues } = await build()
    seed(issues, 'the survivor')
    let seenInsideTheWindow: string[] = []

    await store.transact(() => {
      expect(() =>
        store.transact(() => {
          issues.create({ repoPath: '/repo', title: 'orphaned by the inner rollback', startNow: false })
          throw new Error('inner span failed')
        }),
      ).toThrow('inner span failed')

      // The outer span carries on and will COMMIT. A reader here decides against
      // rows the database has already thrown away.
      seenInsideTheWindow = issues.list().map((issue) => issue.title)
    })

    expect(seenInsideTheWindow).not.toContain('orphaned by the inner rollback')
  })
})
