// @vitest-environment happy-dom
/**
 * POD-4445 — the control at live corpus (1x): the same armed shape as
 * `control.test.tsx` (heartbeat fails isolation, parity exact), plus the CI
 * budget: the whole count run finishes in under 60 s.
 *
 * This is the baseline every arm beats. Counts only — no walls under box
 * load (methodology §5.7); walls come from the Chromium driver.
 */

import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createRowSource } from '../../../shared/src/row-source'
import { startScenarioEngine } from '../../../shared/src/scenarios'
import type { SliceLocals } from '../../../shared/src/slice-types'
import {
  assertIsolation,
  mountArmForCounts,
  runCountScenario,
} from '../count-harness'
import { snapshotFromStore } from '../oracle/index'
import { writeHeartbeat } from '../../../shared/src/scenarios'
import { legacyControlArmFor } from './arm'

describe('legacy control at 1x', () => {
  it('heartbeat fails isolation with exact parity in under 60 s', async () => {
    const started = performance.now()
    const ctx = await startScenarioEngine(1)
    const source = createRowSource(ctx.engine, ctx.replica)
    const locals: SliceLocals = {
      selectedIssueId: null,
      coarseNow: ctx.engine.getSnapshot().coarseNow,
    }
    const mounted = mountArmForCounts(legacyControlArmFor(ctx.engine), source.source, locals)
    try {
      const result = await runCountScenario(mounted, {
        scenario: 'unrelatedHeartbeat',
        methodology: '#1',
        apply: async () => {
          await writeHeartbeat(ctx)
          source.flush()
        },
        expected: () => snapshotFromStore(ctx.engine.getSnapshot(), locals),
      })
      const elapsedMs = performance.now() - started
      // The COST TABLE line the coordinator mail carries.
      console.info(
        `[control-1x] visible=${result.visibleRows} committed=${result.rowsCommitted} ` +
          `stats=${JSON.stringify(result.stats)} parity=${result.parity} ` +
          `elapsedMs=${Math.round(elapsedMs)}`,
      )
      expect(result.visibleRows).toBeGreaterThan(0)
      expect(result.parityDiff).toBeNull()
      expect(result.parity).toBe(true)
      expect(result.rowsCommitted).toBeGreaterThan(0)
      expect(() => assertIsolation(result, { rowsCommitted: 0 })).toThrow(
        /committed \d+ rows, budget 0/,
      )
      // THE CI BUDGET: the count harness on the control at 1x runs in under 60 s.
      expect(elapsedMs).toBeLessThan(60_000)
      // THE 1x CONTROL JSON (attached to the issue, not committed): counts
      // carry the verdict under box load; walls land via the browser driver
      // when the box is quiet (see docs/plans/pod-4441-harness.md).
      const repos = ctx.engine.getSnapshot().repos as { worktrees?: unknown[] }[]
      // Results dir, lane-independent: turbo runs the package lane with
      // cwd=packages/worklist-proto, test:file and the unit lane with the
      // repo root (`import.meta.url` is not a file URL under the transform).
      const cwd = process.cwd()
      const resultsDir = cwd.endsWith(join('packages', 'worklist-proto'))
        ? join(cwd, 'harness', 'browser', 'results')
        : join(cwd, 'packages', 'worklist-proto', 'harness', 'browser', 'results')
      mkdirSync(resultsDir, { recursive: true })
      writeFileSync(
        join(resultsDir, 'control-1x-counts.json'),
        JSON.stringify(
          {
            arm: 'control',
            scale: 1,
            scenario: 'unrelatedHeartbeat',
            methodology: '#1',
            runtimeSha: execFileSync('git', ['rev-parse', '--short', 'HEAD'], {
              encoding: 'utf-8',
            }).trim(),
            capturedAt: new Date().toISOString(),
            corpus: {
              issues: 1.issues,
              sessions: 1.sessions,
              repos: 1.repos,
              worktrees: repos.reduce((sum, repo) => sum + (repo.worktrees?.length ?? 0), 0),
              rows: result.visibleRows,
            },
            counts: {
              visibleRows: result.visibleRows,
              rowsCommitted: result.rowsCommitted,
              stats: result.stats,
            },
            parity: result.parity,
            elapsedMs: Math.round(elapsedMs),
            walls: null,
            wallsSkipped: 'box load above 8 during G4; counts carry the verdict (methodology §5.7)',
          },
          null,
          2,
        ),
      )
    } finally {
      mounted.unmount()
      source.dispose()
      ctx.engine.destroy()
    }
  }, 120_000)
})
