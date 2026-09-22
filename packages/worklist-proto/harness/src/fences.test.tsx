// @vitest-environment happy-dom
/**
 * POD-4563 (L6a) — every fence, on every scenario, for every arm.
 *
 * - The REFERENCE arm (`reference-arm/arm.tsx`) must pass the exact-commit
 *   fence on every scenario: the fence can say YES through a real React tree.
 *   Its changed sets must be non-empty where the scenario changes a visible
 *   row, so a pass is not 0 == 0.
 * - Every ROUND-THREE arm (`roster.ts`) must pass, on every scenario: the
 *   exact-commit fence, parity, the reads budget (every step has one), and
 *   the copy sweep (no row held outside the wrapped tables).
 * - The roster and the `arms/<folder>/fence.json` manifests the lint fence
 *   reads name the same folders.
 *
 * The fence's NO is the legacy control's heartbeat (`control.test.tsx`).
 */

import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { startScenarioEngine } from '../../shared/src/scenarios'
import { assertCommits, assertReads, mountArmForCounts } from './count-harness'
import {
  engineLocals,
  FENCE_SCENARIOS,
  type FenceStep,
  openFenceFeeds,
  runFenceScenarios,
  runFenceStep,
} from './fence-scenarios'
import { rowViewsFromStore } from './oracle/index'
import { referenceArmFor } from './reference-arm/arm'
import { ROUND_THREE_ARMS } from './roster'

// happy-dom rewrites `import.meta.url`; resolve from the lane's cwd instead
// (the root lane runs at the repo root, the package lane in the package).
const PACKAGE_DIR = process.cwd().endsWith(join('packages', 'worklist-proto'))
  ? process.cwd()
  : join(process.cwd(), 'packages', 'worklist-proto')
const ARMS_DIR = join(PACKAGE_DIR, 'arms')

/** Per-scenario cells to the (git-ignored) results folder: the evidence behind a green run. */
function writeResults(name: string, steps: FenceStep[]): void {
  const dir = join(PACKAGE_DIR, 'harness', 'browser', 'results')
  mkdirSync(dir, { recursive: true })
  const cells = steps.map(({ result, readsBudget }) => ({
    methodology: result.methodology,
    scenario: result.scenario,
    oracleChanged: result.oracleChangedRows,
    drawn: result.drawnRows,
    remounted: result.remountedRows,
    localsNotified: result.locals?.keys ?? null,
    rowsCommitted: result.rowsCommitted,
    visibleRows: result.visibleRows,
    readsPerChange: result.readsPerChange,
    readsBudget,
    parity: result.parity,
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
    const feeds = openFenceFeeds(ctx, 'overlaid')
    const mounted = mountArmForCounts(referenceArmFor(ctx.engine), feeds.rows.source, feeds.locals)
    try {
      const steps = await runFenceScenarios(mounted, ctx, feeds.flush, ({ result }) => {
        expect(result.parity, `${result.scenario}: ${result.parityDiff ?? ''}`).toBe(true)
        assertCommits(result)
      })
      console.info(`[fences] reference changed/drawn per scenario: ${summary(steps)}`)
      // POD-4609: the reference arm reads the engine store, never the feed or a
      // fenced table, so it cannot carry a reads YES — it would meet any budget
      // blind. Pinned so the claim is re-examined if that ever changes; the
      // reads YES is `reads-budgets.test.tsx`'s shape arm.
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
      ctx.engine.destroy()
    }
  }, 120_000)
})

for (const entry of ROUND_THREE_ARMS) {
  describe(`fences: ${entry.name}`, () => {
    it('passes the exact-commit fence, parity, the reads budgets and the copy sweep on every scenario', async () => {
      const ctx = await startScenarioEngine(1)
      const feeds = openFenceFeeds(ctx, entry.mode)
      const mounted = mountArmForCounts(entry.armFor(ctx), feeds.rows.source, feeds.locals)
      try {
        const steps = await runFenceScenarios(
          mounted,
          ctx,
          feeds.flush,
          ({ result, readsBudget }) => {
            expect(result.parity, `${result.scenario}: ${result.parityDiff ?? ''}`).toBe(true)
            assertCommits(result)
            assertReads(result, { readsPerChange: readsBudget })
            mounted.reads.assertNoCopies(mounted.handle)
          },
        )
        console.info(`[fences] ${entry.name} changed/drawn per scenario: ${summary(steps)}`)
        writeResults(`fences-${entry.folder}-1x.json`, steps)
      } finally {
        mounted.unmount()
        feeds.dispose()
        ctx.engine.destroy()
      }
    }, 120_000)
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
    const feeds = openFenceFeeds(ctx, 'overlaid')
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
        views.push(rowViewsFromStore(ctx.engine.getSnapshot(), engineLocals(ctx)))
        readAts.push(
          ctx.engine.getSnapshot().issues.find((issue) => issue.id === ctx.targets.markReadId)
            ?.readAt,
        )
      }
      return { cells, views, readAts }
    } finally {
      mounted.unmount()
      feeds.dispose()
      ctx.engine.destroy()
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
 * removes the exception. Coordinator ruling on POD-4565: the a1 MobX pool has
 * no order or roll-ups, so it cannot pass parity on every scenario until Mb4.
 */
const PENDING_ROSTER: Readonly<Record<string, string>> = {
  mobx: 'POD-4572 (Mb4) adds the MobX pool with every scenario and parity, and removes this exception',
}

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
  })
})
