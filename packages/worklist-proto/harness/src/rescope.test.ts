// @vitest-environment happy-dom
/**
 * POD-4572 (Mb4, coordinator ruling 2026-09-24) — the rescope staging
 * (`rescope.ts`) the browser page times (L5e) delivers the grown scope's rows
 * AND its scans, so the grown state is a real 2x state.
 *
 * On the MobX pool, 1x to 2x and back, staged exactly as the page does it:
 * - at the grown state the only issue worktree no scanned lane reports is the
 *   2x corpus's own unscanned-worktree orphan (`i4944`), and the pool's
 *   snapshot equals the oracle's with NO exceptional row (POD-4671 fixed: the
 *   union roots — scanned lanes PLUS every issue's own worktreePath — seat it;
 *   the corpus passed is the grown one);
 * - back at 1x, the same with the 1x orphan (`i3485`).
 * THE NO: the staging before this issue (rows only, discovery left at the
 * page's corpus) still leaves the lanes short (more than the orphan
 * unscanned). Parity holds there too now — the union seats via issue paths,
 * so rows-only cannot fail parity anymore. What keeps the NO meaningful is
 * the plant below: the old scanned-lanes-only R3 rule (no `alsoRoots`) on the
 * same rows-only state leaves the orphan unseated at its issue's path, which
 * is exactly the pre-fix gap that failed parity. No `it.fails`, no skipped
 * assertion: the plant asserts the old rule unseats (green) and the union
 * seats (green).
 */

import { describe, expect, it } from 'vitest'
import { harnessMobxPoolArm } from './adapters/mobx-pool'
import { type ScannableTables, scanRelations } from './adapters/mobx-rebuild'
import { installMobxWarnTrap } from './mobx-trap'
import { diffSnapshots } from '../../shared/src/gen/check'
import { type ScenarioEngine, startScenarioEngine } from '../../shared/src/scenarios'
import { type EntityName, normalizeRootPath, SCHEMA } from '../../shared/src/schema'
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
  /**
   * POD-4671 plant inputs: the corpus orphan's issue path and session, the
   * old scanned-lanes-only seating at that path (must be empty — the old rule
   * fails to seat it) and the union seating (must seat it).
   */
  plant: {
    readonly path: string
    readonly sessionId: string
    readonly oldMany: readonly string[]
    readonly newOne: string | null
    readonly newMany: readonly string[]
  }
}

async function rescopeRun(scans: boolean): Promise<{ grown: ScopeCheck; back: ScopeCheck }> {
  const ctx = await startScenarioEngine(1)
  const feeds = openFenceFeeds(ctx, 'overlaid')
  const handle = harnessMobxPoolArm.create(feeds.rows.source, feeds.locals.source)
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
  const check = (corpus: FixtureCorpus): ScopeCheck => {
    const lanes = new Set(feeds.rows.source.snapshot('worktree').map((row) => row.id))
    const unscanned = corpus.issues
      .filter((issue) => {
        const path = (issue as { worktreePath?: string | null }).worktreePath
        return typeof path === 'string' && path !== '' && !lanes.has(normalizeRootPath(path))
      })
      .map((issue) => issue.id)
      .sort()
    const actual = handle.snapshot()
    const oracle = oracleSnapshot(ctx.engine.getSnapshot())
    // POD-4671 plant tables: the grown/installed rows as whole tables (repo
    // has no feed kind; an empty table keeps the scan honest for R3, which
    // never targets repo).
    const tableOf = (kind: 'issue' | 'session' | 'worktree'): Map<string, unknown> => {
      const table = new Map<string, unknown>()
      for (const record of feeds.rows.source.snapshot(kind)) {
        if (record.value !== undefined) table.set(record.id, record.value)
      }
      return table
    }
    const tables = {
      issue: tableOf('issue'),
      session: tableOf('session'),
      worktree: tableOf('worktree'),
      repo: new Map<string, unknown>(),
    } as unknown as ScannableTables
    // The old scanned-lanes-only R3: the same schema with `alsoRoots` stripped
    // (a test seam over a copy — no arm code edited, nothing to restore).
    const sessionRelations = SCHEMA.session.relations
    const oldSchema = {
      ...SCHEMA,
      session: {
        ...SCHEMA.session,
        relations: {
          ...sessionRelations,
          worktree: { ...sessionRelations.worktree, alsoRoots: [] },
        },
      },
    }
    void oldSchema
    const { issueId, path, sessionId } = corpus.unscannedWorktree
    void issueId
    const oldScan = scanRelations(tables, oldSchema as typeof SCHEMA)
    const newScan = scanRelations(tables, SCHEMA)
    const oldMany = [...oldScan.many('worktree' as EntityName, path, 'sessions')]
    const newMany = [...newScan.many('worktree' as EntityName, path, 'sessions')]
    return {
      unscanned,
      diff: diffSnapshots(actual, oracle),
      plant: {
        path,
        sessionId,
        oldMany,
        newOne: newScan.one('session' as EntityName, sessionId, 'worktree'),
        newMany,
      },
    }
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
  it('leaves only the corpus orphan unscanned, and parity holds with no exceptional row', async () => {
    const { grown, back } = await rescopeRun(true)
    expect(grown.unscanned).toEqual(['i4944'])
    expect(grown.diff).toBeNull()
    expect(back.unscanned).toEqual(['i3485'])
    expect(back.diff).toBeNull()
  }, 300_000)

  it('rows-only staging still leaves the lanes short; the old lanes-only rule fails there (the NO)', async () => {
    const { grown } = await rescopeRun(false)
    // Coverage: without scans more than the orphan stays lane-uncovered.
    expect(grown.unscanned).toContain('i4944')
    expect(grown.unscanned.length).toBeGreaterThan(1)
    // Parity holds even rows-only now (the union seats via issue paths) —
    // no exceptional row, so this cannot be the NO on its own.
    expect(grown.diff).toBeNull()
    // Plant: the old scanned-lanes-only R3 rule on this same rows-only state
    // leaves the orphan unseated at its issue's path (empty — the pre-fix gap
    // that failed parity), while the union seats it there. Proves the union
    // load-bearing; applied through a schema-copy seam, no arm code edited.
    expect(grown.plant.oldMany).toEqual([])
    expect(grown.plant.newOne).toBe(grown.plant.path)
    expect(grown.plant.newMany).toContain(grown.plant.sessionId)
  }, 300_000)
})
