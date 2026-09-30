// @vitest-environment happy-dom
import { act } from 'react'
import { describe, expect, it } from 'vitest'
import { awaitingMergeOf } from '../../shared/src/schema'
import { startScenarioEngine } from '../../shared/src/scenarios'
import { diffSnapshots } from '../../shared/src/gen/check'
import type { SliceIssue, SliceSnapshot } from '../../shared/src/slice-types'
import { harnessHandPoolArm } from './adapters/hand-pool'
import { assertCommits, mountArmForCounts } from './count-harness'
import {
  FENCE_SCENARIOS,
  openFenceFeeds,
  parityLocals,
  runFenceStep,
} from './fence-scenarios'
import { snapshotFromStore } from './oracle/index'

describe('Hand merge verdict on an unrelated heartbeat', () => {
  it('has parity before the heartbeat and redraws only changed row views', async () => {
    const ctx = await startScenarioEngine(1)
    const feeds = openFenceFeeds(ctx, 'overlaid')
    const mounted = mountArmForCounts(harnessHandPoolArm, feeds.rows.source, feeds.locals)
    try {
      const merging = feeds.rows.source.snapshot('issue').filter((row) =>
        row.value !== undefined && awaitingMergeOf(row.value as SliceIssue),
      )
      expect(merging.length, 'the fixture exercises the merge verdict').toBeGreaterThan(0)
      const expected = snapshotFromStore(ctx.engine.getSnapshot(), parityLocals(ctx))
      let actual!: SliceSnapshot
      await act(async () => {
        actual = mounted.handle.snapshot()
      })
      expect(
        diffSnapshots(actual, expected),
        'parity before any heartbeat',
      ).toBeNull()
      const heartbeat = FENCE_SCENARIOS.find((entry) => entry.scenario === 'unrelatedHeartbeat')!
      const { result } = await runFenceStep(mounted, ctx, feeds.flush, heartbeat)
      expect(result.parity, result.parityDiff ?? 'parity after the heartbeat').toBe(true)
      expect(result.oracleChangedRows, 'the unrelated heartbeat changes no visible row').toEqual([])
      assertCommits(result)
      expect(result.rowsCommitted).toBe(0)
    } finally {
      mounted.unmount()
      feeds.dispose()
      ctx.engine.destroy()
    }
  }, 120_000)
})
