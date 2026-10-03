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
 * A MEASURED roster arm (`RosterArm.measuredOnly`, POD-4934) runs every
 * scenario with parity asserted, but each work verdict is reported (pass or
 * fail, with rows, derivations and elements at 1x and 4x against the
 * neighbourhood bound) instead of failing the suite: the first measurement
 * of an arm before its rework.
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
 * The roster's `windowLayout` additionally runs the actual windowed web
 * list with a harness-supplied box, at the browser lane's 5800px height.
 * Native SectionList work is counted in `harness/native/mobx-pool.native.test.tsx`.
 * Both use this meter and neighbourhood bound; neither renders a test-local list.
 *
 * `POD_WORK_TRACE=1` names the call sites behind each count (slow).
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { IssueModel } from '@podium/client-graph/models'
import { fixedLocals } from '@podium/client-graph/shared/locals-source'
import type { RowSourceMode } from '@podium/client-graph/shared/row-source'
import type { SliceIssue, SliceSnapshot } from '@podium/client-graph/shared/slice-types'
import { reaction } from 'mobx'
import { act } from 'react'
import { describe, expect, it, vi } from 'vitest'
import type { Arm } from '../../shared/src/arm'
import {
  type FixtureScale,
  type ScenarioEngine,
  startScenarioEngine,
} from '../../shared/src/scenarios'
import { harnessMobxPoolArm } from './adapters/mobx-pool'
import { createReplaySource, mountArmForCounts } from './count-harness'
import {
  FENCE_SCENARIOS,
  type FenceFeeds,
  openFenceFeeds,
  parityLocals,
  runFenceStep,
} from './fence-scenarios'
import { legacyControlArmFor } from './legacy-control/arm'
import { installMobxWarnTrap } from './mobx-trap'
import { snapshotFromStore } from './oracle/index'
import { poolScreenCellsAt } from './pool-screen-work'
import screenWorkExceptions from './screen-work.expected-failures.json'
import { ROUND_THREE_ARMS, type RosterAllowances, type RosterArm } from './roster'
import {
  assertScaleInvariant,
  assertScaleInvariantWith,
  describeCells,
  describeSites,
  describeVerdict,
  type ScaleCell,
  scaleCell,
  scaleFailures,
  scaleVerdicts,
} from './scale-check'
import {
  assertScreenWork,
  classifyScreenWork,
  SCREEN_ACTIONS,
  type ScreenWorkCell,
  type ScreenWorkVerdict,
  screenWorkVerdicts,
} from './screen-work-ratios'
import { stubWindowLayout, type WindowLayout } from './window-layout'
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

describe('pool screens work ratios', () => {
  it('counts every scripted click/delta for every pool screen and app reader at 1x/4x', async () => {
    const partial = { at1x: [] as ScreenWorkCell[], at4x: [] as ScreenWorkCell[] }
    const capture = (key: keyof typeof partial) => (cell: ScreenWorkCell) => {
      partial[key].push(cell)
      writeCells('work-pool-screens-progress.json', partial)
    }
    const at1x = await poolScreenCellsAt(1, capture('at1x'))
    const at4x = await poolScreenCellsAt(4, capture('at4x'))
    expect(at4x.readers).toEqual(at1x.readers)
    expect(at4x.corpus.issues).toBeGreaterThan(at1x.corpus.issues * 3)
    expect(at4x.corpus.sessions).toBeGreaterThan(at1x.corpus.sessions * 3)
    const verdicts = screenWorkVerdicts(at1x.cells, at4x.cells)
    const exceptions = screenWorkExceptions.flatMap(({ issue, counters }) =>
      counters.map(counter => ({ ...counter, issue })))
    const { expectedFailures, unexpected, resolved } = classifyScreenWork(verdicts, exceptions)
    writeCells('work-pool-screens.json', { at1x, at4x, verdicts, expectedFailures, unexpected, resolved })
    console.info(
      `[screen work] ${at1x.readers.length} readers × ${SCREEN_ACTIONS.length} clicks/deltas × 2 scales; ${verdicts.length} counters; ${expectedFailures.length} expected failures; ${resolved.length} fixed counts green; ${unexpected.length} unexpected`,
    )
    for (const issue of new Set(expectedFailures.map((verdict) => verdict.issue))) {
      const owned = expectedFailures.filter((verdict) => verdict.issue === issue)
      const worst = [...owned].sort((a, b) => b.at4x - b.at1x - (a.at4x - a.at1x))[0]!
      console.info(
        `[screen work] expected failure ${issue}: ${owned.length} counts; ${worst.action} ${worst.reader} ${worst.kind} ${worst.at1x} → ${worst.at4x}; neighbourhood ${worst.neighbourhood1x} → ${worst.neighbourhood4x}`,
      )
    }
    // A new reader or unnamed mechanism does not silently inherit another screen's exception.
    assertScreenWork(unexpected)
    expect(at1x.cells.some((cell) => cell.work.rows! > 0 && cell.work.derivations > 0)).toBe(true)
  }, 1_200_000)

  it('keeps the real legacy control arm as the failing whole-data read control', async () => {
    const heartbeat = FENCE_SCENARIOS.filter((entry) => entry.methodology === '#1')
    const build = (ctx: ScenarioEngine) => ({ arm: legacyControlArmFor(ctx.engine) })
    const first = (await cellsAt(1, 'overlaid', build, heartbeat))[0]!
    const second = (await cellsAt(4, 'overlaid', build, heartbeat))[0]!
    expect(second.work.rows).toBeGreaterThan(first.work.rows)
    expect(second.work.elements).toBeGreaterThan(first.work.elements)
    // Its visible target is the same one-row heartbeat. Any total-data ratio is forbidden.
    const verdict: ScreenWorkVerdict = {
      action: 'heartbeat',
      kind: 'rows',
      reader: 'legacy control',
      at1x: first.work.rows,
      at4x: second.work.rows,
      neighbourhood1x: 1,
      neighbourhood4x: 1,
      passed: second.work.rows <= first.work.rows,
    }
    expect(() => assertScreenWork([verdict])).toThrow(/grew with total data/)
  }, 600_000)

  it('rejects a planted scan in any reader, even beside a much larger constant reader', () => {
    const cells = (): ScreenWorkCell[] =>
      SCREEN_ACTIONS.map((action) => ({
        action,
        neighbourhood: ['issue:visible'],
        work: {
          derivations: 1,
          derivationsBy: { cheap: 1 },
          rows: 1000,
          rowsBy: { expensiveButConstant: 1000 },
          elements: 0,
          elementsBy: {},
          visits: 0,
        },
      }))
    expect(() => assertScreenWork(screenWorkVerdicts(cells(), cells()))).not.toThrow()
    const growingNeighbourhood = cells()
    growingNeighbourhood[0]!.neighbourhood = ['issue:1', 'issue:2', 'issue:3', 'issue:4']
    growingNeighbourhood[0]!.work.rowsBy!.expensiveButConstant = 4000
    expect(() => assertScreenWork(screenWorkVerdicts(cells(), growingNeighbourhood))).not.toThrow()
    for (const action of SCREEN_ACTIONS)
      for (const kind of ['rows', 'derivations', 'elements'] as const) {
        const first = cells(),
          second = cells()
        const a = first.find((cell) => cell.action === action)!.work
        const b = second.find((cell) => cell.action === action)!.work
        const left =
          kind === 'rows' ? a.rowsBy! : kind === 'derivations' ? a.derivationsBy : a.elementsBy
        const right =
          kind === 'rows' ? b.rowsBy! : kind === 'derivations' ? b.derivationsBy : b.elementsBy
        left.planted = 1
        right.planted = 4
        expect(
          () => assertScreenWork(screenWorkVerdicts(first, second)),
          `${action} ${kind}`,
        ).toThrow(/planted/)
      }
    const zero = cells(),
      positive = cells()
    positive[0]!.work.rowsBy!.newReader = 1
    expect(() => assertScreenWork(screenWorkVerdicts(zero, positive))).toThrow(/newReader/)
    expect(() => screenWorkVerdicts(zero.slice(1), positive)).toThrow(/every click/)
  })

  it('limits expected failures to exact issue-linked counts and reports fixed counts green', () => {
    const bad: ScreenWorkVerdict = { action: 'select', kind: 'rows', reader: 'consumer:known',
      at1x: 1, at4x: 4, neighbourhood1x: 1, neighbourhood4x: 1, passed: false }
    const exception = { action: bad.action, kind: bad.kind, reader: bad.reader, issue: 'POD-5421' }
    const classified = classifyScreenWork([bad, { ...bad, kind: 'derivations' },
      { ...bad, action: 'open-menu' }, { ...bad, reader: `${bad.reader}/newScan` }], [exception])
    expect(classified.expectedFailures).toEqual([{ ...bad, issue: exception.issue }])
    expect(classified.unexpected).toHaveLength(3)
    expect(() => assertScreenWork(classified.unexpected)).toThrow(/newScan/)
    const fixed = classifyScreenWork([{ ...bad, at4x: 1, passed: true }], [exception])
    expect(fixed.expectedFailures).toEqual([])
    expect(fixed.resolved).toEqual([exception])
    expect(() => classifyScreenWork([bad], [{ ...exception, issue: '' }])).toThrow(/Invalid/)
    expect(() => classifyScreenWork([bad], [exception, exception])).toThrow(/duplicate/)
  })
})

// happy-dom rewrites `import.meta.url`; resolve from the lane's cwd instead.
const PACKAGE_DIR = process.cwd().endsWith(join('packages', 'worklist-proto'))
  ? process.cwd()
  : join(process.cwd(), 'packages', 'worklist-proto')

/** The arm one engine mounts, and what it must show: its own pending edits over the oracle. */
interface CellArm {
  arm: Arm
  windowLayout?: WindowLayout
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
  const restoreLayout =
    built.windowLayout === undefined ? () => {} : stubWindowLayout(built.windowLayout)
  const mounted = mountArmForCounts(built.arm, feeds.rows.source, feeds.locals, {
    work: TRACE ? 'trace' : true,
  })
  try {
    if (built.windowLayout !== undefined) {
      let snapshot!: SliceSnapshot
      act(() => {
        snapshot = mounted.handle.snapshot()
      })
      const list = document.querySelector('[data-pool-list]')
      const drawn = list?.querySelectorAll('[data-issue-row], [data-loading-row]').length ?? 0
      expect(drawn, 'the window layout draws rows').toBeGreaterThan(0)
      expect(drawn, 'the count mount is a window').toBeLessThan(
        snapshot.order.pinnedIds.length +
          snapshot.order.groups.reduce(
            (n, group) => n + group.rowIds.length + group.closedIds.length,
            0,
          ),
      )
    }
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
    restoreLayout()
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
  measuredOnly: boolean,
): Promise<void> {
  const at1x = await cellsAt(1, mode, build)
  const at4x = await cellsAt(4, mode, build)
  const verdicts = scaleVerdicts(at1x, at4x)
  const known = allowances?.work ?? []
  writeCells(`work-${file}.json`, {
    at1x,
    at4x,
    verdicts,
    allowed: known,
    ...(measuredOnly ? { measuredOnly: true } : {}),
  })
  console.info(`[work] ${name}\n${describeCells(at1x, at4x)}`)
  // Not vacuous: the counters see the arm's work.
  expect(at1x.some((cell) => cell.work.derivations > 0 && cell.work.elements > 0)).toBe(true)
  if (measuredOnly) {
    // POD-4934: a measured arm reports each verdict instead of failing on it.
    const failing = scaleFailures(verdicts)
    console.info(
      `[work] ${name}: measured only — ${verdicts.length} verdicts, ` +
        `${failing.length} failing, reported not failed`,
    )
    for (const verdict of failing) console.info(`[work] ${name}: FAILS ${describeVerdict(verdict)}`)
    return
  }
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
        entry.measuredOnly === true,
      )
    }, 1_200_000)
  })
  if (entry.windowLayout !== undefined) {
    describe(`work per change: ${entry.name} (window layout)`, () => {
      it('does the same work at 1x and 4x, or more by at most the changed items’ neighbourhood', async () => {
        await checkWork(
          `${entry.name} (window layout)`,
          `${entry.folder}-window`,
          entry.mode,
          (ctx) => ({ arm: entry.armFor(ctx), windowLayout: entry.windowLayout }),
          entry.allowances,
          false,
        )
      }, 1_200_000)
    })
  }
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
          entry.measuredOnly === true,
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

describe('MobX cold parent reads', () => {
  installMobxWarnTrap()

  const now = Date.parse('2026-10-03T12:00:00.000Z')
  const stamp = new Date(now - 60_000).toISOString()
  const old = new Date(now - 30 * 24 * 60 * 60 * 1000).toISOString()
  const issue = (id: string, patch: Partial<SliceIssue> = {}): SliceIssue => ({
    id,
    seq: 1,
    title: id,
    stage: 'planning',
    audience: 'human',
    parentId: null,
    repoPath: '/synthetic/repo',
    createdAt: stamp,
    updatedAt: stamp,
    ...patch,
  })

  /** Offscreen progress has no row observer retaining its cold ancestors' facts. */
  function replayHeartbeat() {
    const archived = issue('archived-parent', { archived: true, stage: 'done', closedAt: old })
    const cold = issue('cold-parent', {
      parentId: archived.id,
      stage: 'done',
      closedAt: old,
      updatedAt: old,
    })
    const branch = issue('branch', { parentId: cold.id })
    const leaf = issue('leaf', { parentId: branch.id })
    const background = issue('background', { archived: true, stage: 'done', closedAt: old })
    const replay = createReplaySource({
      issues: [archived, cold, branch, leaf, background].map((value) => ({
        kind: 'issue',
        id: value.id,
        value,
      })),
      sessions: [],
      worktrees: [],
    })
    const read = vi.fn(replay.source.row!.bind(replay.source))
    const locals = fixedLocals({ selectedIssueId: null, coarseNow: now })
    const handle = harnessMobxPoolArm.create(
      { ...replay.source, row: read },
      locals.source,
      undefined,
      { schedule: () => () => {} },
    )
    try {
      const before = handle.snapshot()
      expect(before.rowsById.branch?.progressTotal, 'the offscreen row has formal progress').toBe(1)
      expect([...handle.pool.residency!.ids('issue')]).toEqual(
        expect.arrayContaining([archived.id, cold.id]),
      )
      replay.push({
        type: 'update',
        rows: [
          {
            kind: 'issue',
            id: background.id,
            value: { ...background, updatedAt: new Date(now).toISOString() },
          },
        ],
      })
      handle.settleLoads()
      expect(handle.pendingLoads()).toBe(0)
      read.mockClear()
      const after = handle.snapshot()
      expect(after).toEqual(before)
      expect([...handle.pool.residency!.ids('issue')]).toEqual(
        expect.arrayContaining([archived.id, cold.id]),
      )
      return read.mock.calls.map(([kind, id]) => `${kind}:${id}`)
    } finally {
      handle.dispose()
      locals.dispose()
    }
  }

  function assertNoLateReads(reads: readonly string[]): void {
    expect(reads, 'late row reads after the settled heartbeat').toEqual([])
  }

  it('checks offscreen progress after a settled heartbeat without reading cold ancestor payloads', () => {
    assertNoLateReads(replayHeartbeat())
  })

  it('tracks declared parent changes through cold updates, removal and promotion', () => {
    let value = issue('cold-parent', {
      parentId: 'missing-parent',
      stage: 'done',
      closedAt: old,
      updatedAt: old,
    })
    const replay = createReplaySource({
      issues: [{ kind: 'issue', id: value.id, value }],
      sessions: [],
      worktrees: [],
    })
    const read = vi.fn(replay.source.row!.bind(replay.source))
    const locals = fixedLocals({ selectedIssueId: null, coarseNow: now })
    const handle = harnessMobxPoolArm.create(
      { ...replay.source, row: read },
      locals.source,
      undefined,
      { schedule: () => () => {} },
    )
    const seen: (string | null)[] = []
    const stop = reaction(
      () => handle.pool.rollupInputs.rollupNode(value.id)?.formalParent ?? null,
      (parent) => seen.push(parent),
      { fireImmediately: true },
    )
    const update = (patch: Partial<SliceIssue>) => {
      value = { ...value, ...patch }
      replay.push({ type: 'update', rows: [{ kind: 'issue', id: value.id, value }] })
    }
    const remove = () =>
      replay.push({
        type: 'update',
        rows: [{ kind: 'issue', id: value.id, value: undefined }],
      })
    try {
      expect(handle.pool.residency!.isCold('issue', value.id)).toBe(true)
      expect(seen).toEqual(['missing-parent'])
      read.mockClear()
      update({ parentId: 'next-parent' })
      update({ archived: true })
      update({ archived: false })
      update({ deletedAt: stamp })
      update({ deletedAt: null })
      expect(handle.pool.residency!.isCold('issue', value.id)).toBe(true)
      expect(seen).toEqual([
        'missing-parent',
        'next-parent',
        null,
        'next-parent',
        null,
        'next-parent',
      ])
      remove()
      expect(seen.at(-1)).toBeNull()
      update({ parentId: 'readded-parent' })
      expect(seen.at(-1)).toBe('readded-parent')
      update({ stage: 'planning', closedAt: null, updatedAt: stamp })
      expect(handle.pool.residency!.isCold('issue', value.id)).toBe(false)
      update({ parentId: 'resident-parent' })
      remove()
      update({ stage: 'done', closedAt: old, updatedAt: old })
      expect(handle.pool.residency!.isCold('issue', value.id)).toBe(true)
      expect(seen.at(-1)).toBe('resident-parent')
      update({ parentId: null })
      update({ stage: 'planning', closedAt: null, updatedAt: stamp })
      remove()
      update({ stage: 'done', closedAt: old, updatedAt: old })
      expect(handle.pool.residency!.isCold('issue', value.id)).toBe(true)
      update({ parentId: 'cold-again-parent' })
      expect(seen).toEqual([
        'missing-parent',
        'next-parent',
        null,
        'next-parent',
        null,
        'next-parent',
        null,
        'readded-parent',
        'resident-parent',
        null,
        'resident-parent',
        null,
        'cold-again-parent',
      ])
      expect(handle.pendingLoads()).toBe(0)
      expect(read.mock.calls).toEqual([])
    } finally {
      stop()
      handle.dispose()
      locals.dispose()
    }
  })

  it('rejects the original standing-based parent getter when it is planted', () => {
    const plant = vi
      .spyOn(IssueModel.prototype, 'formalParent', 'get')
      .mockImplementation(function (this: IssueModel) {
        return this.standing?.formalParent ?? null
      })
    try {
      const reads = replayHeartbeat()
      expect(reads).toEqual(['issue:cold-parent', 'issue:archived-parent'])
      expect(() => assertNoLateReads(reads)).toThrow(/late row reads after the settled heartbeat/)
    } finally {
      plant.mockRestore()
    }
  })
})
