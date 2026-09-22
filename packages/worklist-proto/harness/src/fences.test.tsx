// @vitest-environment happy-dom
/**
 * POD-4563 (L6a) — every fence, on every scenario, for every arm.
 *
 * - The REFERENCE arm (`reference-arm/arm.tsx`) must pass the exact-commit
 *   fence on every scenario: the fence can say YES through a real React tree.
 *   Its changed sets must be non-empty where the scenario changes a visible
 *   row, so a pass is not 0 == 0.
 * - Every ROUND-THREE arm (`roster.ts`) must pass, on every scenario: the
 *   exact-commit fence, parity, the L5a reads budget where one is fixed, and
 *   the copy sweep (no row held outside the wrapped tables).
 * - The roster and the `arms/<folder>/fence.json` manifests the lint fence
 *   reads name the same folders.
 *
 * The fence's NO is the legacy control's heartbeat (`control.test.tsx`).
 */

import { readdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createRowSource } from '../../shared/src/row-source'
import { startScenarioEngine } from '../../shared/src/scenarios'
import { assertCommits, assertReads, mountArmForCounts } from './count-harness'
import { engineLocals, FENCE_SCENARIOS, runFenceScenarios } from './fence-scenarios'
import { referenceArmFor } from './reference-arm/arm'
import { ROUND_THREE_ARMS } from './roster'

// happy-dom rewrites `import.meta.url`; resolve from the lane's cwd instead
// (the root lane runs at the repo root, the package lane in the package).
const PACKAGE_DIR = process.cwd().endsWith(join('packages', 'worklist-proto'))
  ? process.cwd()
  : join(process.cwd(), 'packages', 'worklist-proto')
const ARMS_DIR = join(PACKAGE_DIR, 'arms')

function summary(steps: { result: { methodology: string; oracleChangedRows: string[] | null; drawnRows: string[] | null } }[]): string {
  return steps
    .map(({ result }) => `${result.methodology}:${result.oracleChangedRows?.length ?? '∅'}/${result.drawnRows?.length ?? '∅'}`)
    .join(' ')
}

describe('exact-commit fence: reference arm (can say YES)', () => {
  it('redraws exactly the oracle-changed rows on every scenario', async () => {
    const ctx = await startScenarioEngine(1)
    const source = createRowSource(ctx.engine, ctx.replica)
    const mounted = mountArmForCounts(referenceArmFor(ctx.engine), source.source, engineLocals(ctx))
    try {
      const steps = await runFenceScenarios(mounted, ctx, source.flush, ({ result }) => {
        expect(result.parity, `${result.scenario}: ${result.parityDiff ?? ''}`).toBe(true)
        assertCommits(result)
      })
      console.info(`[fences] reference changed/drawn per scenario: ${summary(steps)}`)
      expect(steps.map((step) => step.result.methodology)).toEqual(FENCE_SCENARIOS.map((entry) => entry.methodology))
      // Not 0 == 0: these scenarios change visible rows by construction.
      const changed = Object.fromEntries(steps.map(({ result }) => [result.methodology, result.oracleChangedRows?.length ?? 0]))
      for (const methodology of ['#2', '#3', '#4', '#5', '#7', '#10']) {
        expect(changed[methodology], `${methodology} must change a visible row`).toBeGreaterThan(0)
      }
    } finally {
      mounted.unmount()
      source.dispose()
      ctx.engine.destroy()
    }
  }, 120_000)
})

for (const entry of ROUND_THREE_ARMS) {
  describe(`fences: ${entry.name}`, () => {
    it('passes the exact-commit fence, parity, the reads budgets and the copy sweep on every scenario', async () => {
      const ctx = await startScenarioEngine(1)
      const source = createRowSource(ctx.engine, ctx.replica)
      const mounted = mountArmForCounts(entry.armFor(ctx), source.source, engineLocals(ctx))
      try {
        const steps = await runFenceScenarios(mounted, ctx, source.flush, ({ result, readsBudget }) => {
          expect(result.parity, `${result.scenario}: ${result.parityDiff ?? ''}`).toBe(true)
          assertCommits(result)
          if (readsBudget !== null) assertReads(result, { readsPerChange: readsBudget })
          mounted.reads.assertNoCopies(mounted.handle)
        })
        console.info(`[fences] ${entry.name} changed/drawn per scenario: ${summary(steps)}`)
      } finally {
        mounted.unmount()
        source.dispose()
        ctx.engine.destroy()
      }
    }, 120_000)
  })
}

describe('roster', () => {
  it('names exactly the arm folders that carry a fence manifest', () => {
    const manifests = readdirSync(ARMS_DIR, { withFileTypes: true })
      .filter((dirent) => dirent.isDirectory() && existsSync(join(ARMS_DIR, dirent.name, 'fence.json')))
      .map((dirent) => dirent.name)
      .sort()
    expect(ROUND_THREE_ARMS.map((entry) => entry.folder).sort()).toEqual(manifests)
  })
})
