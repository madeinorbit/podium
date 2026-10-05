import { referenceState } from '@podium/client-graph/diagnostics/reference-state'

import { allIssueViewModels } from '@podium/client-graph/diagnostics/reference/issue-view-models'
// @vitest-environment happy-dom
/**
 * POD-4563 (L6a) — every fence, on every scenario, for every arm.
 *
 * - The REFERENCE arm (`reference-arm/arm.tsx`) must pass the exact-commit
 *   fence on every scenario: the fence can say YES through a real React tree.
 *   Its changed sets must be non-empty where the scenario changes a visible
 *   row, so a pass is not 0 == 0.
 * - Every ROUND-THREE arm (`roster.ts`) must pass, on every scenario: the
 *   exact-commit fence, parity, and the copy sweep (no row held outside the
 *   wrapped tables). The work a change does is the scale check's
 *   (`work-per-change.test.tsx`, POD-4746), which replaced the per-scenario
 *   reads budgets; the reads cell is still recorded here. An arm's
 *   exception to one fence is a NAMED allowance on its roster entry
 *   (`RosterAllowances`: the issue that removes it), applied here only,
 *   recorded per step in the results cell, and failing the suite when no
 *   step needed it (POD-4572).
 * - The roster and the `arms/<folder>/fence.json` manifests the lint fence
 *   reads name the same folders.
 *
 * The fence's NO is the legacy control's heartbeat (`control.test.tsx`).
 */

import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { diffSnapshots } from '../../shared/src/gen/check'
import { startScenarioEngine } from '../../shared/src/scenarios'
import { assertCommits, mountArmForCounts } from './count-harness'
import {
  engineLocals,
  FENCE_SCENARIOS,
  type FenceStep,
  openFenceFeeds,
  parityLocals,
  runFenceScenarios,
  runFenceStep,
} from './fence-scenarios'
import { rowViewsFromStore, snapshotFromStore } from './oracle/index'
import { referenceArmFor } from './reference-arm/arm'
import { ROUND_THREE_ARMS } from './roster'

// happy-dom rewrites `import.meta.url`; resolve from the lane's cwd instead
// (the root lane runs at the repo root, the package lane in the package).
const PACKAGE_DIR = process.cwd().endsWith(join('packages', 'worklist-proto'))
  ? process.cwd()
  : join(process.cwd(), 'packages', 'worklist-proto')
const ARMS_DIR = join(PACKAGE_DIR, 'arms')

/** Per-scenario cells to the (git-ignored) results folder: the evidence behind a green run. */
function writeResults(name: string, steps: FenceStep[], allowed?: readonly AllowanceCell[]): void {
  const dir = join(PACKAGE_DIR, 'harness', 'browser', 'results')
  mkdirSync(dir, { recursive: true })
  const cells = steps.map(({ result }, index) => ({
    methodology: result.methodology,
    scenario: result.scenario,
    oracleChanged: result.oracleChangedRows,
    drawn: result.drawnRows,
    remounted: result.remountedRows,
    localsNotified: result.locals?.keys ?? null,
    rowsCommitted: result.rowsCommitted,
    visibleRows: result.visibleRows,
    readsPerChange: result.readsPerChange,
    stats: result.stats,
    parity: result.parity,
    ...(allowed === undefined ? {} : { allowed: allowed[index] }),
  }))
  writeFileSync(join(dir, name), `${JSON.stringify({ scale: 1, cells }, null, 2)}\n`)
}

function summary(
  steps: {
    result: { methodology: string; oracleChangedRows: string[] | null; drawnRows: string[] | null }
  }[],
): string {
  return steps
    .map(
      ({ result }) =>
        `${result.methodology}:${result.oracleChangedRows?.length ?? '∅'}/${result.drawnRows?.length ?? '∅'}`,
    )
    .join(' ')
}

describe('exact-commit fence: reference arm (can say YES)', () => {
  it('redraws exactly the oracle-changed rows on every scenario', async () => {
    const ctx = await startScenarioEngine(1)
    const feeds = openFenceFeeds(ctx, 'pooled')
    const mounted = mountArmForCounts(referenceArmFor(ctx.engine), feeds.rows.source, feeds.locals)
    try {
      const steps = await runFenceScenarios(mounted, ctx, feeds.flush, ({ result }) => {
        expect(result.parity, `${result.scenario}: ${result.parityDiff ?? ''}`).toBe(true)
        assertCommits(result)
      })
      console.info(`[fences] reference changed/drawn per scenario: ${summary(steps)}`)
      // POD-4609: the reference arm reads the engine store, never the feed or a
      // fenced table, so it cannot carry a reads YES — it would pass blind.
      // Pinned so the claim is re-examined if that ever changes. The work
      // check's YES and NO are `work-per-change.test.tsx`'s (POD-4746).
      expect(steps.map((step) => step.result.readsPerChange)).toEqual(steps.map(() => 0))
      writeResults('fences-reference-1x.json', steps)
      expect(steps.map((step) => step.result.methodology)).toEqual(
        FENCE_SCENARIOS.map((entry) => entry.methodology),
      )
      // Not 0 == 0: these scenarios change visible rows by construction.
      const changed = Object.fromEntries(
        steps.map(({ result }) => [result.methodology, result.oracleChangedRows?.length ?? 0]),
      )
      for (const methodology of ['#2', '#3', '#4', '#5', '#7', '#8b', '#10']) {
        expect(changed[methodology], `${methodology} must change a visible row`).toBeGreaterThan(0)
      }
      // POD-4608: the locals-only steps reach the arm through the channel,
      // naming only their own keys; the plain tick moves no view.
      const cell = (m: string) => steps.find((step) => step.result.methodology === m)?.result
      expect(cell('#3')?.locals?.keys).toEqual({
        selectedIssueId: 1,
        selectedIssueWasFolded: 0,
        coarseNow: 0,
      })
      expect(cell('#8')?.locals?.keys).toEqual({
        selectedIssueId: 0,
        selectedIssueWasFolded: 0,
        coarseNow: 1,
      })
      expect(cell('#8b')?.locals?.keys).toEqual({
        selectedIssueId: 0,
        selectedIssueWasFolded: 0,
        coarseNow: 1,
      })
      expect(changed['#8']).toBe(0)
      for (const { result } of steps) {
        if (['#3', '#8', '#8b'].includes(result.methodology)) continue
        expect(result.locals?.notifications, `${result.methodology} moved a local`).toBe(0)
      }
    } finally {
      mounted.unmount()
      feeds.dispose()
      ctx.dispose()
    }
  }, 120_000)
})

/** What each named allowance (`roster.ts`) did on one step. */
interface AllowanceCell {
  /** POD-4671-style parity patch: the row taken from the arm, or null. */
  parity: string | null
  /** Rows accepted undrawn by the commit allowance. */
  undrawn: string[]
}

for (const entry of ROUND_THREE_ARMS) {
  describe(`fences: ${entry.name}`, () => {
    it('passes the exact-commit fence, parity and the copy sweep on every scenario', async () => {
      const ctx = await startScenarioEngine(1)
      const feeds = openFenceFeeds(ctx, entry.mode)
      const mounted = mountArmForCounts(entry.armFor(ctx), feeds.rows.source, feeds.locals)
      const allow = entry.allowances ?? {}
      const allowed: AllowanceCell[] = []
      try {
        const steps: FenceStep[] = []
        for (const scenario of FENCE_SCENARIOS) {
          const viewsBefore = rowViewsFromStore(referenceState(ctx.engine), engineLocals(ctx))
          const step = await runFenceStep(mounted, ctx, feeds.flush, scenario)
          const { result } = step
          const at = `${result.methodology} ${result.scenario}`
          const cell: AllowanceCell = { parity: null, undrawn: [] }
          if (!result.parity) {
            if (allow.parity === undefined) {
              expect(result.parity, `${at}: ${result.parityDiff ?? ''}`).toBe(true)
            }
            const actual = mounted.handle.snapshot()
            const oracle = snapshotFromStore(referenceState(ctx.engine), parityLocals(ctx))
            const patched = allow.parity!.accept(ctx.corpus, mounted.handle, oracle, actual)
            expect(
              diffSnapshots(actual, patched.snapshot),
              `${at}: beyond ${allow.parity!.issue}'s parity allowance (${result.parityDiff ?? ''})`,
            ).toBeNull()
            cell.parity = patched.applied
          }
          try {
            assertCommits(result)
          } catch (error) {
            if (allow.undrawn === undefined) throw error
            const viewsAfter = rowViewsFromStore(referenceState(ctx.engine), engineLocals(ctx))
            cell.undrawn = allow.undrawn.accept(result, viewsBefore, viewsAfter)
          }
          mounted.reads.assertNoCopies(mounted.handle)
          steps.push(step)
          allowed.push(cell)
        }
        console.info(`[fences] ${entry.name} changed/drawn per scenario: ${summary(steps)}`)
        writeResults(`fences-${entry.folder}-1x.json`, steps, allowed)
        // A fixed gap takes its allowance with it: one never applied fails.
        if (allow.parity !== undefined) {
          expect(
            allowed.some((cell) => cell.parity !== null),
            `${allow.parity.issue}'s parity allowance was never applied: delete it`,
          ).toBe(true)
        }
        if (allow.undrawn !== undefined) {
          expect(
            allowed.some((cell) => cell.undrawn.length > 0),
            `${allow.undrawn.issue}'s commit allowance was never applied: delete it`,
          ).toBe(true)
        }
      } finally {
        mounted.unmount()
        feeds.dispose()
        ctx.dispose()
      }
    }, 300_000)
  })
}

/**
 * Coordinator (from L4a): mark-read overlays stamp `Date.now()`, so a PAINTED
 * `readAt` differs between runs. No compared field is `readAt` (neither
 * `RowView` nor `SliceRow` carries it); it can reach a comparison only through
 * legacy visibility of FINISHED child issues. This proves the #9 cells and the
 * whole row-view output do not depend on the wall clock: the same steps under
 * two system clocks years apart give identical views, cells and parity.
 */
describe('wall-clock independence of the #9 steps', () => {
  async function optimismUnder(systemTime: string) {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date(systemTime))
    const ctx = await startScenarioEngine(1)
    const feeds = openFenceFeeds(ctx, 'pooled')
    const mounted = mountArmForCounts(referenceArmFor(ctx.engine), feeds.rows.source, feeds.locals)
    try {
      const cells = []
      const views = []
      const readAts: (string | null | undefined)[] = []
      for (const entry of FENCE_SCENARIOS.filter((candidate) =>
        candidate.methodology.startsWith('#9'),
      )) {
        const { result } = await runFenceStep(mounted, ctx, feeds.flush, entry)
        assertCommits(result)
        cells.push({
          methodology: result.methodology,
          changed: result.oracleChangedRows,
          drawn: result.drawnRows,
          visible: result.visibleRows,
          parity: result.parity,
        })
        views.push(rowViewsFromStore(referenceState(ctx.engine), engineLocals(ctx)))
        readAts.push(
          allIssueViewModels(
            ctx.replica,
            referenceState(ctx.engine).issueProjections,
            referenceState(ctx.engine).issueUserStates,
          ).find((issue) => issue.id === ctx.targets.markReadId)?.readAt,
        )
      }
      return { cells, views, readAts }
    } finally {
      mounted.unmount()
      feeds.dispose()
      ctx.dispose()
      vi.useRealTimers()
    }
  }

  it('gives identical row views and cells under two wall clocks', async () => {
    const early = await optimismUnder('2026-09-21T00:00:00Z')
    const late = await optimismUnder('2031-03-01T00:00:00Z')
    expect(early.cells).toHaveLength(3)
    expect(late.cells).toEqual(early.cells)
    expect(late.views).toEqual(early.views)
    // Not vacuous: the press really painted the wall clock into readAt.
    console.info(
      `[fences] #9 readAt early=${JSON.stringify(early.readAts)} late=${JSON.stringify(late.readAts)}`,
    )
    expect(early.readAts[0]).toMatch(/^2026-09-21/)
    expect(late.readAts[0]).toMatch(/^2031-03-01/)
  }, 120_000)
})

/**
 * Arm folders that carry a fence manifest (so the lint fence covers them) but
 * are not on the roster yet, each with the issue that adds the entry and
 * removes the exception. (The MobX pool's, from POD-4565, was removed by
 * POD-4572 (Mb4), which put the pool on the roster; the hand pool's, from
 * POD-4585, by POD-4934, which put it on the roster as a measured arm.)
 */
const PENDING_ROSTER: Readonly<Record<string, string>> = { lean: 'POD-5353' }

describe('roster', () => {
  it('names exactly the arm folders that carry a fence manifest, less the named pending ones', () => {
    const manifests = readdirSync(ARMS_DIR, { withFileTypes: true })
      .filter(
        (dirent) => dirent.isDirectory() && existsSync(join(ARMS_DIR, dirent.name, 'fence.json')),
      )
      .map((dirent) => dirent.name)
      .sort()
    const rostered = ROUND_THREE_ARMS.map((entry) => entry.folder).sort()
    expect(rostered).toEqual(manifests.filter((folder) => !(folder in PENDING_ROSTER)))
    // An exception must name a real manifest that is not on the roster.
    for (const folder of Object.keys(PENDING_ROSTER)) {
      expect(manifests, `pending ${folder} has no fence.json`).toContain(folder)
      expect(rostered, `pending ${folder} is already on the roster`).not.toContain(folder)
    }
    // POD-4934: measuredOnly is the pre-rework hand arm's alone — MobX stays fully armed.
    expect(
      ROUND_THREE_ARMS.find((entry) => entry.folder === 'mobx')?.measuredOnly ?? false,
      'MobX is never measured-only',
    ).toBe(false)
  })
})
