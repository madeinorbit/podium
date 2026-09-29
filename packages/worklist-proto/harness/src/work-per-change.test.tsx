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
 * THE ARM THAT OWNS OPTIMISM (POD-4825). A roster arm with a write layer
 * (`RosterArm.writable`) runs twice more, on the same feed: the layer idle, and
 * with pending title edits queued in the outbox at creation, which stay
 * pending through every step (`writable-arm.ts`). Parity is then held to the
 * oracle with those titles laid over it. Same check, same allowances.
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
import type { SliceSnapshot } from '../../shared/src/slice-types'
import { mountArmForCounts } from './count-harness'
import {
  FENCE_SCENARIOS,
  type FenceFeeds,
  openFenceFeeds,
  parityLocals,
  runFenceStep,
} from './fence-scenarios'
import { legacyControlArmFor } from './legacy-control/arm'
import { snapshotFromStore } from './oracle/index'
import { ROUND_THREE_ARMS, type RosterAllowances, type RosterArm } from './roster'
import {
  assertScaleInvariant,
  assertScaleInvariantWith,
  describeCells,
  describeSites,
  type ScaleCell,
  scaleCell,
  scaleFailures,
  scaleVerdicts,
} from './scale-check'
import {
  PENDING_TITLE_EDITS,
  PENDING_WINDOW_ROWS,
  pendingTitleEditsOn,
  silentTransport,
  targetIds,
  WRITE_VARIANTS,
  type WriteVariant,
  withPendingTitles,
} from './writable-arm'

const TRACE = process.env.POD_WORK_TRACE === '1'

// happy-dom rewrites `import.meta.url`; resolve from the lane's cwd instead.
const PACKAGE_DIR = process.cwd().endsWith(join('packages', 'worklist-proto'))
  ? process.cwd()
  : join(process.cwd(), 'packages', 'worklist-proto')

/** The arm one engine mounts, and what it must show: its own pending edits over the oracle. */
interface CellArm {
  arm: Arm
  expected?: (oracle: SliceSnapshot) => SliceSnapshot
  /** Runs after the last step, before unmount (the pending edits are still pending). */
  after?: (handle: unknown) => void
}
type ArmBuilder = (ctx: ScenarioEngine, feeds: FenceFeeds) => CellArm

/** Every fence scenario on one engine at `scale`, work counted. Parity must hold. */
async function cellsAt(
  scale: FixtureScale,
  mode: RowSourceMode,
  build: ArmBuilder,
  scenarios = FENCE_SCENARIOS,
): Promise<ScaleCell[]> {
  const ctx = await startScenarioEngine(scale)
  const feeds = openFenceFeeds(ctx, mode)
  const built = build(ctx, feeds)
  const mounted = mountArmForCounts(built.arm, feeds.rows.source, feeds.locals, {
    work: TRACE ? 'trace' : true,
  })
  try {
    const cells: ScaleCell[] = []
    for (const entry of scenarios) {
      const step = await runFenceStep(
        mounted,
        ctx,
        feeds.flush,
        entry,
        built.expected === undefined ? {} : { expected: built.expected },
      )
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
    built.after?.(mounted.handle)
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

/**
 * The writable arm in one variant (POD-4825): idle, or with pending title
 * edits queued at creation. The pending edits must still be pending after
 * the last step, and the arm never sends.
 */
function writableBuilder(entry: RosterArm, variant: WriteVariant): ArmBuilder {
  const writable = entry.writable
  if (writable === undefined) throw new Error(`${entry.name} has no write layer`)
  return (ctx, feeds) => {
    if (variant === 'idle') {
      const transport = silentTransport()
      return {
        arm: writable(transport),
        after: () => expect(transport.sent, 'the idle layer sends nothing').toEqual([]),
      }
    }
    const excluded = targetIds(ctx.targets)
    const { queued, titles } = pendingTitleEditsOn(
      feeds.rows.source.snapshot('issue'),
      snapshotFromStore(ctx.engine.getSnapshot(), parityLocals(ctx)).order,
      (id) => excluded.has(id),
      PENDING_WINDOW_ROWS,
      parityLocals(ctx).coarseNow,
    )
    const transport = silentTransport(queued)
    return {
      arm: writable(transport),
      expected: (oracle) => withPendingTitles(oracle, titles),
      after: (handle) => {
        const write = (handle as { write: { pendingDisplay(kind: 'issue', id: string): unknown } })
          .write
        const still = [...titles.keys()].filter(
          (id) => write.pendingDisplay('issue', id) !== undefined,
        )
        expect(still, 'every pending edit is still pending after the last step').toHaveLength(
          PENDING_TITLE_EDITS,
        )
        expect(transport.sent, 'bootstrap re-applies the outbox without re-sending').toEqual([])
      },
    }
  }
}

/** THE check on one arm, with its named allowances; the cells go to `work-<file>.json`. */
async function checkWork(
  name: string,
  file: string,
  mode: RowSourceMode,
  build: ArmBuilder,
  allowances: RosterAllowances | undefined,
): Promise<void> {
  const at1x = await cellsAt(1, mode, build)
  const at4x = await cellsAt(4, mode, build)
  const verdicts = scaleVerdicts(at1x, at4x)
  const known = allowances?.work ?? []
  writeCells(`work-${file}.json`, { at1x, at4x, verdicts, allowed: known })
  console.info(`[work] ${name}\n${describeCells(at1x, at4x)}`)
  // Not vacuous: the counters see the arm's work.
  expect(at1x.some((cell) => cell.work.derivations > 0 && cell.work.elements > 0)).toBe(true)
  // Every failing count inside a sized allowance, and no allowance stale.
  const applied = assertScaleInvariantWith(verdicts, known)
  if (applied.length > 0) console.info(`[work] ${name}: allowances applied: ${applied.join('; ')}`)
}

for (const entry of ROUND_THREE_ARMS) {
  describe(`work per change: ${entry.name}`, () => {
    it('does the same work at 1x and 4x, or more by at most the changed items’ neighbourhood', async () => {
      await checkWork(
        entry.name,
        entry.folder,
        entry.mode,
        (ctx) => ({ arm: entry.armFor(ctx) }),
        entry.allowances,
      )
    }, 1_200_000)
  })
  if (entry.writable === undefined) continue
  for (const variant of WRITE_VARIANTS) {
    describe(`work per change: ${entry.name} with its write layer (${variant})`, () => {
      it('does the same work at 1x and 4x, or more by at most the changed items’ neighbourhood', async () => {
        await checkWork(
          `${entry.name} + write layer (${variant})`,
          `${entry.folder}-write-${variant}`,
          entry.mode,
          writableBuilder(entry, variant),
          entry.allowances,
        )
      }, 1_200_000)
    })
  }
}

describe('work per change: legacy control (the NO)', () => {
  it('fails: its reads and walks grow with the corpus on every step', async () => {
    const build = (ctx: ScenarioEngine) => ({ arm: legacyControlArmFor(ctx.engine) })
    const at1x = await cellsAt(1, 'overlaid', build)
    const at4x = await cellsAt(4, 'overlaid', build)
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
