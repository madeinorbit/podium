import { afterEach, describe, expect, it } from 'vitest'
import { SessionRegistry } from '../../../relay'
import { openTestStore } from '../../../test-support/open-test-store'

/**
 * THE DELETE/RESTORE EVENT APPEND RIDES THE COMMIT [POD-3505].
 *
 * `prepareSoftDelete`/`prepareRestore` returned a plan whose `apply()` was
 * `async` and did `installRow(...)` then `await emitEvent('issue.deleted', ...)`.
 * `apply()` is called from the ledger's SYNCHRONOUS commit-application callback
 * — `apply: (_result, changes) => { ... }` — which cannot await it, so the
 * returned promise was dropped and the append landed on a later tick. The row
 * install was ordered with the commit; the event that reports it was not.
 *
 * WHY THESE ASSERTIONS AND NOT A GOING-RED TEST. A test that merely turns red
 * is not evidence for this shape: the leak is an ORDERING fault, and almost any
 * assertion taken after the whole call settles sees the event arrive eventually
 * and passes either way. Two assertions, doing different jobs:
 *
 *   1. THE DISCRIMINATOR — the event row is readable INSIDE the enclosing span,
 *      before it commits. False for every implementation that appends anywhere
 *      but this transaction: the dropped-promise shape this issue removed, and
 *      equally an `afterCommit` append, which would be the other tempting fix.
 *      Checked by restoring the old shape: the probe fails `expected [] to have
 *      a length of 1`.
 *   2. THE INVARIANT — a rolled-back span leaves NO event row, so the log can
 *      never claim a deletion the database did not keep. This one does NOT
 *      discriminate on its own and is not claimed to: under the old shape the
 *      escaped append also left no row, either swallowed by `emitEvent`'s
 *      `catch {}` or killed by the executor's stale-transaction guard. It is
 *      here because it is the property that matters, and because an append that
 *      escaped onto a connection outside the guard would land and be caught.
 *
 * These probes read the event table directly and never go through `emitEvent`,
 * whose `catch {}` would otherwise let them pass vacuously.
 */
describe('issue delete/restore events commit with the row (POD-3505)', () => {
  const registries: SessionRegistry[] = []
  afterEach(() => {
    for (const registry of registries.splice(0)) registry.dispose()
  })

  async function build() {
    const store = await openTestStore(':memory:')
    const registry = await SessionRegistry.create(store, undefined, { instanceId: 'default' })
    registries.push(registry)
    return { store, registry }
  }

  const eventsFor = async (
    store: Awaited<ReturnType<typeof openTestStore>>,
    kind: string,
    subject: string,
  ) => await store.events.listEventsSince(0, { kinds: [kind], subject })

  /** Drain the microtask AND macrotask queues, which is where a dropped promise
   *  runs. Without this the "no row after a rollback" assertions would be racing
   *  the very escape they exist to detect and could pass for the wrong reason. */
  const settle = async () => {
    for (let i = 0; i < 3; i++) await new Promise((resolve) => setTimeout(resolve, 0))
  }

  it('makes issue.deleted readable inside the span that deletes', async () => {
    const { store, registry } = await build()
    const issue = await registry.issues.create({
      repoPath: '/repo',
      title: 'Doomed vessel',
      startNow: false,
    })

    await store.transact(async () => {
      await registry.modules.issueSessionLifecycle.deleteIssue(issue.id)
      // IN-WINDOW, and this is the whole assertion: the enclosing span has not
      // committed yet, and the event the delete reports is already durable
      // inside it. An append deferred to a later tick has written nothing here.
      const seen = await eventsFor(store, 'issue.deleted', issue.id)
      expect(seen).toHaveLength(1)
      expect(seen[0]?.payload).toMatchObject({ seq: issue.seq })
    })

    expect(await eventsFor(store, 'issue.deleted', issue.id)).toHaveLength(1)
  })

  it('leaves no issue.deleted row when the enclosing span rolls back', async () => {
    const { store, registry } = await build()
    const issue = await registry.issues.create({
      repoPath: '/repo',
      title: 'Doomed vessel',
      startNow: false,
    })

    await expect(
      store.transact(async () => {
        await registry.modules.issueSessionLifecycle.deleteIssue(issue.id)
        throw new Error('enclosing span failed')
      }),
    ).rejects.toThrow('enclosing span failed')
    await settle()

    // The tombstone rolled back, so the log must not claim the issue was
    // deleted. An append that escapes the span writes this row against state
    // the database never kept.
    expect(await eventsFor(store, 'issue.deleted', issue.id)).toHaveLength(0)
    expect((await store.issues.getIssue(issue.id))?.deletedAt ?? null).toBeNull()
  })

  it('makes issue.restored readable inside the span that restores', async () => {
    const { store, registry } = await build()
    const issue = await registry.issues.create({
      repoPath: '/repo',
      title: 'Recoverable',
      startNow: false,
    })
    await registry.modules.issueSessionLifecycle.deleteIssue(issue.id)

    await store.transact(async () => {
      await registry.modules.issueSessionLifecycle.restoreIssue(issue.id)
      const seen = await eventsFor(store, 'issue.restored', issue.id)
      expect(seen).toHaveLength(1)
    })

    expect(await eventsFor(store, 'issue.restored', issue.id)).toHaveLength(1)
  })

  it('leaves no issue.restored row when the enclosing span rolls back', async () => {
    const { store, registry } = await build()
    const issue = await registry.issues.create({
      repoPath: '/repo',
      title: 'Recoverable',
      startNow: false,
    })
    await registry.modules.issueSessionLifecycle.deleteIssue(issue.id)

    await expect(
      store.transact(async () => {
        await registry.modules.issueSessionLifecycle.restoreIssue(issue.id)
        throw new Error('enclosing span failed')
      }),
    ).rejects.toThrow('enclosing span failed')
    await settle()

    expect(await eventsFor(store, 'issue.restored', issue.id)).toHaveLength(0)
    expect((await store.issues.getIssue(issue.id))?.deletedAt).toBeTruthy()
  })
})
