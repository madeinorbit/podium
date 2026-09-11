import { asIssueId, asSessionId } from '@podium/model'
import { normalizeSettings } from '@podium/runtime'
import { describe, expect, it } from 'vitest'
import { SessionRegistry } from '../relay'
import { captureLogs } from '../test-support/capture-logs'
import { openTestStore } from '../test-support/open-test-store'
import { type IssueDeps, IssueService } from './issues/service'
import { issueTestPlumbing } from './issues/service/test-plumbing'
import { sessionReadPorts } from '../test-support/session-facts'

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

/**
 * The same hazard read from the OTHER side of the seam (POD-3820).
 *
 * The test above pins the production wiring. This one pins the CONTRACT: an
 * `onIssueClosed` that touches the store, wired straight onto `IssueService`.
 * The dep used to be typed `=> void`, so the close could not await it even
 * though awaiting is the fix — a nested store write the caller awaits is a
 * savepoint, and one it drops is a sibling frame the executor refuses. `void`
 * was never a description of this dep; it was a prohibition on fixing it.
 */
describe('IssueService.onIssueClosed under the async store (POD-3820)', () => {
  it('a close awaits a hook that opens its own transaction, and the span survives it', async () => {
    const store = await openTestStore(':memory:')
    const closed: string[] = []
    const deps: IssueDeps = {
      store,
      ...sessionReadPorts(() => []),
      getSettings: async () =>
        normalizeSettings({
          gitWorkflow: {
            defaultParentBranch: 'main',
            mergeStyle: 'ff-only',
            autoRebaseBeforeMerge: true,
          },
          sessionDefaults: { agent: 'claude-code' },
        }),
      spawnSession: async () => ({
        sessionId: asSessionId('onclosed-test'),
        machine: 'machine-under-test',
      }),
      repoOp: async () => ({ ok: true, output: '' }),
      // Production-shaped: `IssueSessionLifecycle.stopClosedIssue` reads the
      // issue back and stops its sessions. Nothing here is a mock.
      onIssueClosed: async ({ issueId }) => {
        closed.push(issueId)
        await store.transact(async () => {
          await store.issues.getIssue(issueId)
        })
      },
      ...issueTestPlumbing(),
    }
    const issues = await IssueService.create(deps)
    try {
      const issue = await issues.create({ repoPath: '/repo', title: 'closes', startNow: false })

      await store.transact(async () => {
        await issues.close(issue.id, 'done')
        // The statement the lock bug died on: the same span, after the hook.
        await store.issues.getIssue(asIssueId('iss_after'))
      })

      expect(closed).toEqual([issue.id])
      expect((await store.issues.getIssue(issue.id))?.closedAt).toBeTruthy()
    } finally {
      await store.close()
    }
  })
})
