import { referenceState } from '@podium/client-graph/diagnostics/reference-state'
// @vitest-environment happy-dom
/**
 * POD-4582 (Hb1) — a draft's display title at 4x, the hand equivalent of the
 * MobX arm's `arms/mobx/pool/worklist/draft-title.test.tsx` (POD-4572, Mb4).
 * The fixture first has drafts whose lowest-id member is a shell at 4x. The
 * legacy names a draft after `sessionsForIssueNav(...)[0]`, which leaves out
 * shells, archived and headless sessions; both pools filter their sorted
 * member list through the shared `isDraftNameSession` (`shared/src/row-view.ts`).
 * Every visible draft's title equals the oracle's, and the case is exercised:
 * at least one visible draft's lowest-id member is a shell.
 */

import { describe, expect, it } from 'vitest'
import { openFenceFeeds } from '../../../../harness/src/fence-scenarios'
import { oracleSnapshot } from '../../../../harness/src/oracle/index'
import { startScenarioEngine } from '../../../../shared/src/scenarios'
import { harnessHandPoolArm } from '../../../../harness/src/adapters/hand-pool'

describe('a draft wears its first nameable member (4x)', () => {
  it('every visible draft title equals the oracle, shell-first drafts included', async () => {
    const ctx = await startScenarioEngine(4)
    const feeds = openFenceFeeds(ctx, 'pooled')
    const handle = harnessHandPoolArm.create(feeds.rows.source, feeds.locals.source)
    try {
      const got = handle.snapshot()
      const want = oracleSnapshot(referenceState(ctx.engine))
      const { pool } = handle
      const drafts = Object.keys(want.rowsById).filter(
        (id) => pool.visibleInputs.issueRow(id)?.isDraftVessel === true,
      )
      expect(drafts.length, 'visible drafts at 4x').toBeGreaterThan(0)
      const shellFirst = drafts.filter((id) => {
        const first = pool.worklist.issue(id).seatIds[0]
        return first !== undefined && pool.visibleInputs.sessionRow(first)?.agentKind === 'shell'
      })
      expect(shellFirst.length, 'drafts whose lowest-id member is a shell').toBeGreaterThan(0)
      for (const id of drafts) {
        expect(got.rowsById[id]?.title, `${id}.title`).toBe(want.rowsById[id]?.title)
      }
    } finally {
      handle.dispose()
      feeds.dispose()
      ctx.dispose()
    }
  }, 300_000)
})
