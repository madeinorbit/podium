// @vitest-environment happy-dom
/**
 * POD-4572 (Mb4, coordinator ruling 2026-09-24) — the rescope staging
 * (`rescope.ts`) the browser page times (L5e) delivers the grown scope's rows
 * AND its scans, so the grown state is a real 2x state.
 *
 * On the MobX pool, 1x to 2x and back, staged exactly as the page does it:
 * - at the grown state the only issue worktree no scanned lane reports is the
 *   2x corpus's own unscanned-worktree orphan (`i4944`), and the pool's
 *   snapshot equals the oracle's with NO patch (POD-4671 fixed: the union
 *   roots seat it; the corpus passed is the grown one);
 * - back at 1x, the same with the 1x orphan (`i3485`).
 * THE NO: the staging before this issue (rows only, discovery left at the
 * page's corpus) leaves more worktrees unscanned and fails parity.
 */

import { describe, expect, it } from 'vitest'
import { mobxPoolArm } from '../../arms/mobx/pool/arm'
import { installMobxWarnTrap } from '../../arms/mobx/pool/mobx-trap'
import { diffSnapshots } from '../../shared/src/gen/check'
import { type ScenarioEngine, startScenarioEngine } from '../../shared/src/scenarios'
import { normalizeRootPath } from '../../shared/src/schema'
import { openFenceFeeds } from './fence-scenarios'
import type { FixtureCorpus } from './fixture/index'
import { oracleSnapshot } from './oracle/index'
import {
  currentScope,
  fireRescope,
  type StagedScope,
  scopeOfCorpus,
  stageRows,
  stageScans,
} from './rescope'

installMobxWarnTrap()

interface ScopeCheck {
  /** Issues of the installed corpus whose own worktree no scanned lane reports. */
  unscanned: string[]
  /** The snapshot against the oracle (POD-4671 fixed: no patch); null when equal. */
  diff: string | null
  applied: string | null
}

async function rescopeRun(scans: boolean): Promise<{ grown: ScopeCheck; back: ScopeCheck }> {
  const ctx = await startScenarioEngine(1)
  const feeds = openFenceFeeds(ctx, 'overlaid')
  const handle = mobxPoolArm.create(feeds.rows.source, feeds.locals.source)
  let seq = 1
  const install = async (scope: StagedScope): Promise<void> => {
    if (scans) await stageScans(ctx, scope.repos)
    stageRows(ctx, scope.rows)
    seq += 1
    fireRescope(ctx, seq)
    await new Promise((resolve) => setTimeout(resolve, ctx.settleMs))
    feeds.flush()
    handle.settleLoads()
  }
  const check = (_corpus: FixtureCorpus): ScopeCheck => {
    const lanes = new Set(feeds.rows.source.snapshot('worktree').map((row) => row.id))
    const unscanned = _corpus.issues
      .filter((issue) => {
        const path = (issue as { worktreePath?: string | null }).worktreePath
        return typeof path === 'string' && path !== '' && !lanes.has(normalizeRootPath(path))
      })
      .map((issue) => issue.id)
      .sort()
    const actual = handle.snapshot()
    const oracle = oracleSnapshot(ctx.engine.getSnapshot())
    return { unscanned, diff: diffSnapshots(actual, oracle), applied: null }
  }
  try {
    const base = currentScope(ctx as ScenarioEngine, ctx.corpus)
    const grownScope = scopeOfCorpus(2)
    await install(grownScope)
    const grown = check(grownScope.corpus)
    await install(base)
    return { grown, back: check(ctx.corpus) }
  } finally {
    handle.dispose()
    feeds.dispose()
    ctx.engine.destroy()
  }
}

describe('rescope staging: rows and scans (L5e)', () => {
  it('leaves only the corpus orphan unscanned, and parity holds with its one row', async () => {
    const { grown, back } = await rescopeRun(true)
    expect(grown.unscanned).toEqual(['i4944'])
    expect(grown.applied).toBe('i4944')
    expect(grown.diff).toBeNull()
    expect(back.unscanned).toEqual(['i3485'])
    expect(back.applied).toBe('i3485')
    expect(back.diff).toBeNull()
  }, 300_000)

  it('the rows-only staging it replaced fails both checks (the NO)', async () => {
    const { grown } = await rescopeRun(false)
    console.info(`[rescope] rows only: unscanned at the grown state ${grown.unscanned.length}`)
    expect(grown.unscanned.length).toBeGreaterThan(1)
    expect(grown.diff).not.toBeNull()
  }, 300_000)
})
