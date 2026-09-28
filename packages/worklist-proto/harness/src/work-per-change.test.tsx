// @vitest-environment happy-dom
/**
 * POD-4746 — the work-per-change check (`scale-check.ts`) on every roster arm,
 * and its NO on the legacy control.
 *
 * Each arm runs every fence scenario (#1–#10, `fence-scenarios.ts`) on a 1x
 * engine and on a 4x engine, with its work counted from outside
 * (`work-meter.ts`, the feed's rows) and each step's neighbourhood read off
 * the corpus (`neighbourhood.ts`). Parity must hold at both scales, so a count
 * is never taken from an arm that shows the wrong list. The cells go to the
 * git-ignored results folder (`work-<folder>.json`), with every verdict.
 *
 * A known violation is a NAMED allowance on the roster entry
 * (`RosterAllowances.work`: the issue that fixes it, its scenarios and
 * counts), recorded in the results; an allowance whose count passes fails
 * the suite, so a fix takes its allowance with it. The check still prints
 * every allowed failure with its counts.
 *
 * THE NO is the legacy control: one whole-world derive per publication, so
 * every step that publishes reads the whole corpus and walks every row, at
 * both scales. It must fail on rows and on elements (never weakened: if it goes
 * green, the check is blind).
 *
 * `POD_WORK_TRACE=1` names the call sites behind each count (slow).
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { Arm } from '../../shared/src/arm'
import type { RowSourceMode } from '../../shared/src/row-source'
import {
  type FixtureScale,
  type ScenarioEngine,
  startScenarioEngine,
} from '../../shared/src/scenarios'
import { mountArmForCounts } from './count-harness'
import { FENCE_SCENARIOS, openFenceFeeds, runFenceStep } from './fence-scenarios'
import { legacyControlArmFor } from './legacy-control/arm'
import { ROUND_THREE_ARMS } from './roster'
import {
  assertScaleInvariant,
  describeCells,
  describeSites,
  type ScaleCell,
  type ScaleVerdict,
  scaleCell,
  scaleFailures,
  scaleVerdicts,
} from './scale-check'

const TRACE = process.env.POD_WORK_TRACE === '1'

// happy-dom rewrites `import.meta.url`; resolve from the lane's cwd instead.
const PACKAGE_DIR = process.cwd().endsWith(join('packages', 'worklist-proto'))
  ? process.cwd()
  : join(process.cwd(), 'packages', 'worklist-proto')

/** Every fence scenario on one engine at `scale`, work counted. Parity must hold. */
async function cellsAt(
  scale: FixtureScale,
  mode: RowSourceMode,
  armFor: (ctx: ScenarioEngine) => Arm,
  scenarios = FENCE_SCENARIOS,
): Promise<ScaleCell[]> {
  const ctx = await startScenarioEngine(scale)
  const feeds = openFenceFeeds(ctx, mode)
  const mounted = mountArmForCounts(armFor(ctx), feeds.rows.source, feeds.locals, {
    work: TRACE ? 'trace' : true,
  })
  try {
    const cells: ScaleCell[] = []
    for (const entry of scenarios) {
      const step = await runFenceStep(mounted, ctx, feeds.flush, entry)
      const { result } = step
      expect(result.parity, `${scale}x ${result.methodology}: ${result.parityDiff ?? ''}`).toBe(
        true,
      )
      const cell = scaleCell(step)
      if (TRACE) {
        console.info(
          `[work] ${scale}x ${cell.methodology} ${JSON.stringify(cell.work)} n=${cell.neighbourhood}\n${describeSites(result)}`,
        )
      }
      cells.push(cell)
    }
    return cells
  } finally {
    mounted.unmount()
    feeds.dispose()
    ctx.engine.destroy()
  }
}

function writeCells(name: string, body: object): void {
  const dir = join(PACKAGE_DIR, 'harness', 'browser', 'results')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, name), `${JSON.stringify(body, null, 2)}\n`)
}

for (const entry of ROUND_THREE_ARMS) {
  describe(`work per change: ${entry.name}`, () => {
    it('does the same work at 1x and 4x, or more by at most the changed items’ neighbourhood', async () => {
      const at1x = await cellsAt(1, entry.mode, entry.armFor)
      const at4x = await cellsAt(4, entry.mode, entry.armFor)
      const verdicts = scaleVerdicts(at1x, at4x)
      const known = entry.allowances?.work ?? []
      const covers = (verdict: ScaleVerdict) => (step: { methodology: string; kind: string }) =>
        step.methodology === verdict.methodology && step.kind === verdict.kind
      const isKnown = (verdict: ScaleVerdict): boolean =>
        known.some((allowance) => allowance.steps.some(covers(verdict)))
      writeCells(`work-${entry.folder}.json`, { at1x, at4x, verdicts, allowed: known })
      console.info(`[work] ${entry.name}\n${describeCells(at1x, at4x)}`)
      // Not vacuous: the counters see the arm's work.
      expect(at1x.some((cell) => cell.work.derivations > 0 && cell.work.elements > 0)).toBe(true)
      assertScaleInvariant(verdicts.filter((verdict) => !isKnown(verdict)))
      // A fixed violation takes its allowance with it.
      const failing = scaleFailures(verdicts)
      for (const allowance of known) {
        for (const step of allowance.steps) {
          expect(
            failing.some((verdict) => covers(verdict)(step)),
            `${allowance.issue}'s allowance for ${step.methodology} ${step.kind} passes now: delete it`,
          ).toBe(true)
        }
      }
    }, 1_200_000)
  })
}

describe('work per change: legacy control (the NO)', () => {
  it('fails: its reads and walks grow with the corpus on every step', async () => {
    const armFor = (ctx: ScenarioEngine) => legacyControlArmFor(ctx.engine)
    const at1x = await cellsAt(1, 'overlaid', armFor)
    const at4x = await cellsAt(4, 'overlaid', armFor)
    const verdicts = scaleVerdicts(at1x, at4x)
    writeCells('work-control.json', { at1x, at4x, verdicts })
    console.info(`[work] legacy control\n${describeCells(at1x, at4x)}`)
    const failing = scaleFailures(verdicts)
    // The heartbeat changes no visible row: its neighbourhood is a closed
    // root's family, and the control reads and walks the whole corpus.
    for (const kind of ['rows', 'elements'] as const) {
      expect(
        failing.some((verdict) => verdict.methodology === '#1' && verdict.kind === kind),
        `#1 ${kind}`,
      ).toBe(true)
    }
    // Every step fails: each one publishes the store (the plain tick #8 too:
    // the clock is store state), and each publication re-derives the world.
    const failedSteps = new Set(failing.map((verdict) => verdict.methodology))
    expect(
      FENCE_SCENARIOS.map((entry) => entry.methodology).filter((m) => !failedSteps.has(m)),
    ).toEqual([])
    expect(() => assertScaleInvariant(verdicts)).toThrow(/grew with the data/)
  }, 1_800_000)
})
