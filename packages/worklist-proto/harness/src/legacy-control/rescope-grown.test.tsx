// @vitest-environment happy-dom
/**
 * POD-4715 / POD-4722 — the mounted control holds every grown-scope row.
 *
 * Staged exactly as the browser page stages it (`prepareRescope` +
 * `stageScope` + `fireRescope` in `harness/web/entrylib.ts`, over
 * `harness/src/rescope.ts`), with the control's web list MOUNTED the way the
 * page mounts it.
 *
 * - `holds the full 2x visible set with the list mounted`: with the page's
 *   untimed heal (`healGrownDerivation`, for POD-4722) the mounted control
 *   reaches the full 2x visible set (1,464 rows), and its grown-state oracle
 *   equals the oracle of a pristine engine staged identically but never
 *   mounted (the no-op page's oracle).
 * - Without the heal the mounted control must also hold the full visible set.
 *   Before POD-4722, a synchronous derive inside the facade cascade ran before
 *   issue-view cache invalidation and pinned 735 of 1,464 rows under the grown
 *   store. This assertion guards the production fix without a healing refresh.
 */

import { act } from 'react'
import { describe, expect, it } from 'vitest'
import { diffSnapshots } from '../../../shared/src/gen/check'
import { type ScenarioEngine, startScenarioEngine } from '../../../shared/src/scenarios'
import type { SliceSnapshot } from '@podium/client-graph/shared/slice-types'
import { openFenceFeeds } from '../fence-scenarios'
import { expectedSnapshot, oracleSnapshot } from '../oracle/index'
import { currentScope, fireRescope, scopeOfCorpus, stageRows, stageScans } from '../rescope'
import { legacyControlArmFor } from './arm'

/** JSON with object keys sorted at every level (mirrors entrylib's canonical). */
function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, inner: unknown) =>
    inner !== null && typeof inner === 'object' && !Array.isArray(inner)
      ? Object.fromEntries(
          Object.entries(inner as Record<string, unknown>).sort(([a], [b]) =>
            a < b ? -1 : a > b ? 1 : 0,
          ),
        )
      : inner,
  )
}

/** A mounted control page at the grown state. `heal` mirrors the page's
 *  untimed `healGrownDerivation` (a discovery refresh answering the staged
 *  repos, then settled); without it this directly guards the POD-4722 fix.
 */
async function grownControlPage(heal: boolean): Promise<{
  ctx: ScenarioEngine
  snapshot: SliceSnapshot
  oracle: SliceSnapshot
  truthRows: number
  cleanup: () => Promise<void>
}> {
  const ctx = await startScenarioEngine(1)
  const feeds = openFenceFeeds(ctx, 'overlaid')
  const handle = legacyControlArmFor(ctx.engine).create(feeds.rows.source, feeds.locals.source)
  const container = document.createElement('div')
  document.body.appendChild(container)
  let unmount: () => void = () => {}
  await act(async () => {
    unmount = handle.mountWeb(container)
  })
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
  if (heal) {
    // The page's untimed heal: a fresh store snapshot with no row changes,
    // then settled (the healing re-render lands here, untimed).
    await act(async () => {
      await ctx.engine.access.refreshRepos()
      await new Promise((resolve) => setTimeout(resolve, ctx.settleMs))
      feeds.flush()
    })
  }
  const snapshot = handle.snapshot()
  const oracle = oracleSnapshot(ctx.engine.access)
  const truth = expectedSnapshot(grown.corpus, {
    selectedIssueId: null,
    coarseNow: grown.corpus.fixedNow,
  })
  return {
    ctx,
    snapshot,
    oracle,
    truthRows: Object.keys(truth.rowsById).length,
    cleanup: async () => {
      await act(async () => {
        unmount()
      })
      handle.dispose()
      feeds.dispose()
      container.remove()
      ctx.engine.destroy()
    },
  }
}

describe('control rescope grown state (POD-4715)', () => {
  it('holds the full 2x visible set with the list mounted (healed)', async () => {
    const page = await grownControlPage(true)
    // The pristine oracle: a second engine staged identically but never
    // mounted (nothing derives inside its cascade, as on the no-op page).
    const pristine = await startScenarioEngine(1)
    try {
      const grown = scopeOfCorpus(2)
      await stageScans(pristine, grown.repos)
      await new Promise((resolve) => setTimeout(resolve, pristine.settleMs))
      stageRows(pristine, grown.rows)
      fireRescope(pristine, 2)
      await new Promise((resolve) => setTimeout(resolve, pristine.settleMs))
      const pristineOracle = oracleSnapshot(pristine.engine.access)

      const armRows = Object.keys(page.snapshot.rowsById).length
      const oracleRows = Object.keys(page.oracle.rowsById).length
      console.info(
        `[4715] control grown healed: arm=${armRows} oracle=${oracleRows} truth=${page.truthRows}`,
      )
      expect(diffSnapshots(page.snapshot, page.oracle)).toBeNull()
      expect(armRows).toBe(page.truthRows)
      expect(oracleRows).toBe(page.truthRows)
      // Same grown state (same oracle hash) as the page that never poisoned.
      expect(canonical(page.oracle)).toBe(canonical(pristineOracle))
    } finally {
      pristine.engine.destroy()
      await page.cleanup()
    }
  }, 300_000)

  it('holds the full 2x visible set with the list mounted without the heal (POD-4722)', async () => {
    const page = await grownControlPage(false)
    try {
      const armRows = Object.keys(page.snapshot.rowsById).length
      const oracleRows = Object.keys(page.oracle.rowsById).length
      console.info(
        `[4715] control grown unhealed: arm=${armRows} oracle=${oracleRows} truth=${page.truthRows}`,
      )
      // Arm/oracle parity alone is self-referential: both read the same store.
      // The independent corpus truth must also match the mounted row count.
      expect(diffSnapshots(page.snapshot, page.oracle)).toBeNull()
      expect(armRows).toBe(page.truthRows)
      expect(oracleRows).toBe(page.truthRows)
    } finally {
      await page.cleanup()
    }
  }, 300_000)
})
