import { asIssueId } from '@podium/model'
import { describe, expect, it } from 'vitest'
import { SessionRegistry } from '../relay'
import { captureLogs } from '../test-support/capture-logs'
import { openTestStore } from '../test-support/open-test-store'

/**
 * `onIssueClosed` (crud.ts) reaches `IssueSessionLifecycle.stopClosedIssue`,
 * whose whole job is to be fire-and-forget: `void this.stopClosedIssueNow(...)`.
 * That tail does store reads and writes, so under the async store executor it
 * JOINS whatever span the close is running inside, as a savepoint — the close's
 * next statement addresses a frame with an open child and is refused, and the
 * cleanup's own reads are then refused as stale and swallowed into a warning.
 * The closed issue's sessions are never stopped [POD-3806].
 *
 * Driven through the REAL composition root, so the wiring under test is the one
 * that ships rather than a stand-in for it.
 */
describe('closed-issue cleanup under the async store (POD-3806)', () => {
  it('a close inside a span neither breaks the span nor strands the cleanup', async () => {
    const store = await openTestStore(':memory:')
    const registry = await SessionRegistry.create(store, undefined, { instanceId: 'default' })
    const logs = captureLogs()
    try {
      const issue = await registry.modules.issues.create({
        repoPath: '/repo',
        title: 'closes inside a span',
        startNow: false,
      })

      await store.transact(async () => {
        await registry.modules.issues.close(issue.id, 'done')
        // The statement the lock bug died on: same span, after the cleanup fired.
        await store.issues.getIssue(asIssueId('iss_after'))
      })

      // Let the deferred cleanup run to its first store read.
      await new Promise((resolve) => setTimeout(resolve, 50))

      expect(logs.text()).not.toContain('closed-issue cleanup could not resolve its issue')
      expect(logs.text()).not.toContain('closed issue cleanup failed')
    } finally {
      logs.restore()
      registry.modules.issueSessionLifecycle.dispose()
    }
  })
})
