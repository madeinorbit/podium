// @vitest-environment happy-dom
/**
 * POD-4715 — the control page's grown state holds half the rows.
 *
 * Staged exactly as the browser page stages it (`prepareRescope` +
 * `stageScope` + `fireRescope` in `harness/web/entrylib.ts`, over
 * `harness/src/rescope.ts`), with the control's web list MOUNTED the way the
 * page mounts it. At the grown state the control's snapshot — and the oracle
 * over the same store — must hold the full 2x visible set, the same set the
 * fixture oracle computes over the grown corpus (what the MobX/hand pages
 * and the count lane hold). At the current tip the mounted control holds
 * ~half (735 of 1,464): the in-cascade legacy derive runs against
 * not-yet-invalidated issue views (see the issue), and every later derive
 * reuses the partial result.
 */

import { act } from 'react'
import { describe, expect, it } from 'vitest'
import { diffSnapshots } from '../../../shared/src/gen/check'
import { startScenarioEngine } from '../../../shared/src/scenarios'
import { openFenceFeeds } from '../fence-scenarios'
import { expectedSnapshot, oracleSnapshot } from '../oracle/index'
import {
  currentScope,
  fireRescope,
  scopeOfCorpus,
  stageRows,
  stageScans,
} from '../rescope'
import { legacyControlArmFor } from './arm'

describe('control rescope grown state (POD-4715)', () => {
  it('holds the full 2x visible set with the list mounted', async () => {
    const ctx = await startScenarioEngine(1)
    const feeds = openFenceFeeds(ctx, 'overlaid')
    const handle = legacyControlArmFor(ctx.engine).create(feeds.rows.source, feeds.locals.source)
    const container = document.createElement('div')
    document.body.appendChild(container)
    let unmount: () => void = () => {}
    await act(async () => {
      unmount = handle.mountWeb(container)
    })
    try {
      // The page's prepareRescope(2): the grown scope and the page's own.
      const grown = scopeOfCorpus(2)
      const base = currentScope(ctx, ctx.corpus)
      void base
      // The page's stageScope(grown): scans published and settled, then rows.
      await stageScans(ctx, grown.repos)
      await new Promise((resolve) => setTimeout(resolve, ctx.settleMs))
      stageRows(ctx, grown.rows)
      // The page's timed install.
      fireRescope(ctx, 2)
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, ctx.settleMs))
        feeds.flush()
      })

      const armSnapshot = handle.snapshot()
      const oracle = oracleSnapshot(ctx.engine.getSnapshot())
      const armRows = Object.keys(armSnapshot.rowsById).length
      const oracleRows = Object.keys(oracle.rowsById).length
      const truth = expectedSnapshot(grown.corpus, {
        selectedIssueId: null,
        coarseNow: grown.corpus.fixedNow,
      })
      const truthRows = Object.keys(truth.rowsById).length
      console.info(
        `[4715] control grown: arm=${armRows} oracle=${oracleRows} truth=${truthRows}`,
      )
      // Mid-run parity is self-referential (arm and oracle read the same
      // store) and passes either way; it must still pass.
      expect(diffSnapshots(armSnapshot, oracle)).toBeNull()
      // The grown state is the full 2x visible set — the count the other
      // pages hold. Fails at the tip (735 of 1,464).
      expect(armRows).toBe(truthRows)
      expect(oracleRows).toBe(truthRows)
    } finally {
      await act(async () => {
        unmount()
      })
      handle.dispose()
      feeds.dispose()
      container.remove()
      ctx.engine.destroy()
    }
  }, 300_000)
})
