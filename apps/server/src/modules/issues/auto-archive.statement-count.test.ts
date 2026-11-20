/**
 * THE AUTO-ARCHIVE SWEEP READS ITS CANDIDATES' SESSIONS TOGETHER (POD-7036).
 *
 * The hourly sweep asked each closed, read issue for its member sessions on its
 * own, and each ask restored those sessions with single-id reads of every
 * satellite table (`offers`, `session_drafts`, checkpoints, transcripts, turn
 * states): the POD-7027 audit's `WHERE session_id IN (?)` bursts, on the
 * sweep's hourly beat. Measured before the fix with this fixture: 15 statements
 * at 4 issues, 75 at 24 (six per closed, read issue). Now the statement count
 * does not grow with the number of closed issues.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SessionRegistry } from '../../relay'
import { attachHostDaemon } from '../../test-support/host-daemon'
import { TEST_MACHINE_ID } from '../../test-support/machine-id'
import { openTestStore } from '../../test-support/open-test-store'
import { countStatements } from '../../test-support/statement-count'

const registries: SessionRegistry[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  for (const r of registries.splice(0)) await r.dispose()
})

/** `n` issues, half closed and read; every issue has a parked session that was
 *  active after the read, so the sweep looks at each and archives none. */
async function world(n: number) {
  const store = await openTestStore(':memory:', TEST_MACHINE_ID)
  await store.repos.addRepo('/r', TEST_MACHINE_ID)
  const reg = await SessionRegistry.create(store, undefined, {
    instanceId: 'default',
    sessionResidency: { evictParked: true, sweepIntervalMs: 0 },
  })
  registries.push(reg)
  await attachHostDaemon(reg)
  const w = reg.modules.issues.reports.store.serverWriter
  for (let i = 0; i < n; i++) {
    const issue = await reg.modules.issues.crud.create(w, {
      repoPath: '/r',
      title: `I${i}`,
      startNow: false,
    })
    if (i % 2 === 0) {
      await reg.modules.issues.crud.close(w, issue.id, 'done')
      await reg.modules.issues.crud.markIssueRead(w, issue.id)
    }
    const { sessionId } = await reg.modules.sessions.createSession({
      agentKind: 'claude-code',
      cwd: '/r',
      issueId: issue.id,
    })
    await reg.gateway.routeDaemonFrame(TEST_MACHINE_ID, {
      type: 'agentExit',
      sessionId,
      code: 0,
    })
  }
  await reg.modules.sessions.flushActivity()
  reg.modules.sessions.residency.sweep()
  return { reg, store }
}

describe('auto-archive sweep statement count (POD-7036)', () => {
  it('reads the sessions of every candidate together, whatever their number', async () => {
    const counts: number[] = []
    for (const n of [4, 16]) {
      const { reg, store } = await world(n)
      const asked = vi.spyOn(reg.modules.sessions, 'readSessionFactsByIssues')
      const tally = await countStatements(store, async () => {
        const archived = await reg.modules.issues.attention.sweepAutoArchive(
          Date.now() + 9 * 24 * 3600_000,
        )
        expect(archived).toEqual([])
      })
      // Armed: the sweep reached every closed, read issue.
      expect(asked.mock.calls.flatMap(([issues]) => issues)).toHaveLength(n / 2)
      counts.push(tally.statements)
    }
    expect(counts[1]).toBe(counts[0])
  }, 120_000)
})
