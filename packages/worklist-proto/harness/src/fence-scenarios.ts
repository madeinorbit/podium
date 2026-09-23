/**
 * POD-4563 (L6a) — the one scenario list every arm's fences run over.
 *
 * Every per-row scenario of the methodology (#1–#10; lifecycle scenarios
 * #11–#13 replace the whole slice and are L5e's), in methodology order, on ONE
 * engine, as the scenario writes intend. Each step is a `CountInput` carrying
 * the row-view oracle, so `assertCommits` can hold the arm to the exact set of
 * rows whose view changed, and the reads budget (L5a #1–#5, POD-4609 #6–#10).
 *
 * LOCALS COME FROM THE ENGINE. The row-view oracle reads selection and the
 * coarse clock from the engine store (`engineLocals`), because the #3 click
 * and the #8 tick are engine writes. The parity snapshot stays the
 * unselected baseline (spec §7).
 *
 * THE ARM FOLLOWS THEM THROUGH THE LOCALS CHANNEL (POD-4608). `openFenceFeeds`
 * gives every fenced arm the row source AND the engine-backed locals source
 * (`engine-locals.ts`); after each write the step drains both. The row source
 * emits nothing for #3's selection or #8's tick, so an arm that reads its
 * locals once at creation fails the exact-commit fence there.
 *
 * #8b IS THE TICK THAT MOVES A VIEW. The methodology's #8 advances one 60 s
 * period and, on this corpus, changes no row view: it proves a tick wakes no
 * row, and nothing more — an arm deaf to the clock passes it. #8b advances
 * the clock across the finished-grace boundary (24 h; the corpus's grace rows
 * finished 1–20 h before `FIXED_NOW`), so those rows' `closed` flips with no
 * row event at all. That is a sleep/wake, or the one 60 s tick that lands on
 * the boundary: an arm cannot tell them apart.
 *
 * A STEP COUNTS THE LOADS ITS OWN CHANGE TRIGGERS (POD-4568 G2). A lazy arm
 * (one that loads cold rows through the feed's per-row read, `RowSource.row`)
 * queues a load when a view reaches a cold row, and lands it when its window
 * closes. Left to the window, a load the step's change queues can land after
 * the step's reads are sampled, and is charged to no step (M3 re-review 2,
 * §6.3: 2 reads and a pass, against 2,839 and a fail with the load inside the
 * step). So `runFenceStep` awaits the arm's `settleLoads()` INSIDE the
 * measured step, after the write and the feed drain, and afterwards refuses
 * an arm that still has loads pending or that loaded a row after that settle.
 * The feeds count the arm's per-row reads (`FenceFeeds.rowReads`), so an arm
 * that loads rows without the hooks is refused too: the hook cannot be
 * skipped by leaving it out.
 */

import { isDeepStrictEqual } from 'node:util'
import { act } from 'react'
import type { ArmHandle, LazyArmHandle, RowSource } from '../../shared/src/arm'
import type { LocalsSourceHandle } from '../../shared/src/locals-source'
import {
  createRowSource,
  type RowSourceHandle,
  type RowSourceMode,
} from '../../shared/src/row-source'
import {
  armMarkReadRejection,
  pendingWrites,
  type ScenarioEngine,
  writeArchiveIssue,
  writeBurst50,
  writeClockTick,
  writeEvictIssue,
  writeEvictKeeperIssue,
  writeHeartbeat,
  writeNewIssue,
  writeOptimisticEcho,
  writeOptimisticPress,
  writeParentReassignment,
  writePhaseChange,
  writeSelectionClick,
  writeStageMove,
  writeTitleRename,
} from '../../shared/src/scenarios'
import type { SliceLocals } from '../../shared/src/slice-types'
import {
  ancestorCount,
  burstReadBudget,
  clockTickReadBudget,
  type CountResult,
  evictKeeperReadBudget,
  type MountedArm,
  newIssueReadBudget,
  parentReassignmentReadBudget,
  phaseChangeReadBudget,
  READ_BUDGETS,
  removeOneReadBudget,
  runCountScenario,
} from './count-harness'
import { createEngineLocals, localsOfEngine } from './engine-locals'
import { rowViewsFromStore, snapshotFromStore } from './oracle/index'

export interface FenceScenario {
  scenario: string
  /** Methodology §5.8 number. */
  methodology: string
  /** The write, settled. */
  write(ctx: ScenarioEngine): Promise<unknown>
  /**
   * The reads budget for this change (#1–#5 L5a, POD-4557; #6–#10 POD-4609),
   * computed from the targets BEFORE the write. Every scenario has one.
   */
  readsBudget(ctx: ScenarioEngine): number
  /**
   * The optimistic writes this step leaves pending ON PURPOSE
   * (`pendingWrites`), for the next step to settle: only #9a, whose echo is
   * #9b. Every other step settles its own writes (POD-4618). Default none.
   */
  leavesPending?(ctx: ScenarioEngine): string[]
}

/** Selection and clock as the engine holds them: what the row views show. */
export function engineLocals(ctx: ScenarioEngine): SliceLocals {
  return localsOfEngine(ctx.engine)
}

/** #8b: one tick across the finished-grace boundary (`SIDEBAR_FINISHED_GRACE_MS`). */
export const GRACE_CROSSING_TICK_MS = 24 * 60 * 60 * 1000

/** What a fenced arm consumes: the row source and the locals channel, drained together. */
export interface FenceFeeds {
  rows: RowSourceHandle
  locals: LocalsSourceHandle
  /** Drain both, rows first: what each step runs after its write. */
  flush(): void
  /**
   * Per-row reads (`RowSource.row`) the arm has made through `rows.source`
   * since the feeds opened: a lazy arm's loads (G2). Non-zero means the arm is
   * lazy, and `runFenceStep` then requires its load hooks.
   */
  rowReads(): number
  dispose(): void
}

/** The feeds behind a `flush` handed to `runFenceStep`: how a step finds `rowReads`. */
const FEEDS_OF_FLUSH = new WeakMap<() => void, FenceFeeds>()

export function openFenceFeeds(ctx: ScenarioEngine, mode: RowSourceMode): FenceFeeds {
  const raw = createRowSource(ctx.engine, ctx.replica, { mode })
  const locals = createEngineLocals(ctx.engine)
  let rowReads = 0
  const row = raw.source.row?.bind(raw.source)
  const source: RowSource = {
    snapshot: (kind) => raw.source.snapshot(kind),
    subscribe: (listener) => raw.source.subscribe(listener),
    ...(row === undefined
      ? {}
      : {
          row(kind: 'issue' | 'session', id: string) {
            rowReads += 1
            return row(kind, id)
          },
        }),
  }
  const rows: RowSourceHandle = {
    source,
    get stats() {
      return raw.stats
    },
    flush: () => raw.flush(),
    dispose: () => raw.dispose(),
  }
  const feeds: FenceFeeds = {
    rows,
    locals,
    flush(): void {
      rows.flush()
      locals.flush()
    },
    rowReads: () => rowReads,
    dispose(): void {
      rows.dispose()
      locals.dispose()
    },
  }
  FEEDS_OF_FLUSH.set(feeds.flush, feeds)
  return feeds
}

/** The parity snapshot's locals: the engine clock, no selection (spec §7). */
export function parityLocals(ctx: ScenarioEngine): SliceLocals {
  return { selectedIssueId: null, coarseNow: ctx.engine.getSnapshot().coarseNow }
}

function parentOf(ctx: ScenarioEngine): (id: string) => string | null | undefined {
  return (id) =>
    ctx.engine.getSnapshot().issueProjections.find((issue) => issue.id === id)?.parentId
}

/** #8: one coarse period (`writeClockTick`'s default). */
export const CLOCK_TICK_MS = 60_000

/**
 * The rows a clock advance of `ms` would cross, projected BEFORE the write:
 * the row-view oracle at the current locals and at the advanced clock, same
 * store. Crossed = view changed, entered or left. Sorted ids.
 */
export function tickCrossings(ctx: ScenarioEngine, ms: number): string[] {
  const store = ctx.engine.getSnapshot()
  const now = engineLocals(ctx)
  const before = rowViewsFromStore(store, now)
  const after = rowViewsFromStore(store, { ...now, coarseNow: now.coarseNow + ms })
  const ids = new Set([...Object.keys(before), ...Object.keys(after)])
  return [...ids].filter((id) => !isDeepStrictEqual(before[id], after[id])).sort()
}

/** Ancestors above `id` in the engine's issue tree, before the write. */
function ancestorsOf(ctx: ScenarioEngine, id: string): number {
  return ancestorCount(id, parentOf(ctx))
}

export const FENCE_SCENARIOS: readonly FenceScenario[] = [
  {
    scenario: 'unrelatedHeartbeat',
    methodology: '#1',
    write: writeHeartbeat,
    readsBudget: () => READ_BUDGETS.unrelatedHeartbeat,
  },
  {
    scenario: 'visibleSessionPhaseChange',
    methodology: '#2',
    write: writePhaseChange,
    readsBudget: (ctx) =>
      phaseChangeReadBudget(ancestorCount(ctx.targets.visibleRootId, parentOf(ctx))),
  },
  {
    scenario: 'selectionClick',
    methodology: '#3',
    write: (ctx) => writeSelectionClick(ctx),
    readsBudget: () => READ_BUDGETS.selectionClick,
  },
  {
    scenario: 'visibleTitleRename',
    methodology: '#4',
    write: (ctx) => writeTitleRename(ctx),
    readsBudget: () => READ_BUDGETS.visibleTitleRename,
  },
  {
    scenario: 'stageMoveAcrossGroups',
    methodology: '#5',
    write: (ctx) => writeStageMove(ctx),
    readsBudget: () => READ_BUDGETS.stageMoveNeighbourhood,
  },
  {
    scenario: 'newIssue',
    methodology: '#6a',
    write: (ctx) => writeNewIssue(ctx),
    readsBudget: () => newIssueReadBudget(),
  },
  {
    scenario: 'archiveIssue',
    methodology: '#6b',
    write: (ctx) => writeArchiveIssue(ctx),
    readsBudget: (ctx) => removeOneReadBudget(ancestorsOf(ctx, ctx.targets.archiveId)),
  },
  {
    scenario: 'evictWithoutRevision',
    methodology: '#6c',
    write: (ctx) => writeEvictIssue(ctx),
    readsBudget: (ctx) => removeOneReadBudget(ancestorsOf(ctx, ctx.targets.evictId)),
  },
  {
    scenario: 'evictKeeperWithoutRevision',
    methodology: '#6d',
    write: (ctx) => writeEvictKeeperIssue(ctx),
    readsBudget: (ctx) => evictKeeperReadBudget(ancestorsOf(ctx, ctx.targets.keeperLeafId)),
  },
  {
    scenario: 'parentReassignment',
    methodology: '#7',
    write: (ctx) => writeParentReassignment(ctx),
    readsBudget: (ctx) =>
      parentReassignmentReadBudget(
        ancestorsOf(ctx, ctx.targets.reparentId),
        ancestorsOf(ctx, ctx.targets.reparentToId),
      ),
  },
  {
    scenario: 'clockTick',
    methodology: '#8',
    write: (ctx) => writeClockTick(ctx, CLOCK_TICK_MS),
    readsBudget: (ctx) => clockTickReadBudget(tickCrossings(ctx, CLOCK_TICK_MS).length),
  },
  {
    scenario: 'clockGraceCrossing',
    methodology: '#8b',
    write: (ctx) => writeClockTick(ctx, GRACE_CROSSING_TICK_MS),
    readsBudget: (ctx) => clockTickReadBudget(tickCrossings(ctx, GRACE_CROSSING_TICK_MS).length),
  },
  {
    scenario: 'optimisticPress',
    methodology: '#9a',
    write: (ctx) => writeOptimisticPress(ctx),
    readsBudget: () => READ_BUDGETS.markRead,
    leavesPending: (ctx) => [`issues:${ctx.targets.markReadId}`],
  },
  {
    scenario: 'optimisticEcho',
    methodology: '#9b',
    write: (ctx) => writeOptimisticEcho(ctx),
    readsBudget: () => READ_BUDGETS.markRead,
  },
  {
    scenario: 'optimisticPressRejected',
    methodology: '#9c',
    write: async (ctx) => {
      armMarkReadRejection(ctx)
      await writeOptimisticPress(ctx)
    },
    readsBudget: () => READ_BUDGETS.markRead,
  },
  {
    scenario: 'burst50',
    methodology: '#10',
    write: writeBurst50,
    readsBudget: (ctx) =>
      burstReadBudget(ctx.targets.burstIssueIds.map((id) => ancestorsOf(ctx, id))),
  },
]

/** One fenced step: the count result plus the budget that applied. */
export interface FenceStep {
  result: CountResult
  readsBudget: number
}

/**
 * Run every fence scenario, in order, against one mounted arm on one engine.
 * `flush` drains the arm's feeds after each write (`FenceFeeds.flush`: the
 * row source, then the locals channel). `each` runs after every step, before the next write — the fences
 * assert there, so the first failing scenario is the one named.
 */
export async function runFenceScenarios(
  mounted: MountedArm,
  ctx: ScenarioEngine,
  flush: () => void,
  each: (step: FenceStep, handle: ArmHandle) => void,
): Promise<FenceStep[]> {
  const steps: FenceStep[] = []
  for (const entry of FENCE_SCENARIOS) {
    const step = await runFenceStep(mounted, ctx, flush, entry)
    steps.push(step)
    each(step, mounted.handle)
  }
  return steps
}

/** Rounds of redraw-then-load the pre-step settle allows before it gives up. */
const SETTLE_ROUNDS = 100

/**
 * The arm's load hooks (G2), or null for an eager arm. THROWS for an arm that
 * has read rows through `RowSource.row` (when the feeds are known) or has one
 * hook without the other: a lazy arm without them would have its loads
 * charged to no step.
 */
function loadHooks(
  handle: ArmHandle,
  feeds: FenceFeeds | undefined,
  step: string,
): LazyArmHandle | null {
  const settle = typeof handle.settleLoads === 'function'
  const pending = typeof handle.pendingLoads === 'function'
  if (settle && pending) return handle as LazyArmHandle
  const reads = feeds?.rowReads() ?? 0
  if (settle || pending || reads > 0) {
    const missing = [settle ? null : 'settleLoads()', pending ? null : 'pendingLoads()']
      .filter((hook) => hook !== null)
      .join(' and ')
    const why =
      reads > 0 ? `${reads} per-row read(s) through RowSource.row` : 'it has one load hook'
    throw new Error(
      `${step}: the arm is lazy (${why}) but has no ${missing}: its loads would be charged to no step`,
    )
  }
  return null
}

/**
 * One fence scenario against a mounted arm: the count result with the row-view oracle.
 *
 * A lazy arm's loads (G2): what was queued BEFORE the step (the mount's loads;
 * a step never leaves one, below) lands first, outside the count. The step's
 * own loads land inside it: `settleLoads()` after the write and the feed
 * drain, before the reads are sampled. Afterwards a load still pending, or a
 * row read through the feed after that settle, is refused.
 */
export async function runFenceStep(
  mounted: MountedArm,
  ctx: ScenarioEngine,
  flush: () => void,
  entry: FenceScenario,
): Promise<FenceStep> {
  const step = `${entry.methodology} ${entry.scenario}`
  const readsBudget = entry.readsBudget(ctx)
  const feeds = FEEDS_OF_FLUSH.get(flush)
  const before = loadHooks(mounted.handle, feeds, step)
  // Each round under its own act: the rows it lands redraw when act exits,
  // and a redrawn row can reach another cold row.
  for (let round = 0; before !== null && before.pendingLoads() > 0; round += 1) {
    if (round >= SETTLE_ROUNDS) {
      throw new Error(
        `${step}: loads queued before the step did not settle in ${SETTLE_ROUNDS} rounds`,
      )
    }
    await act(async () => {
      await before.settleLoads()
    })
  }
  let settledAt = feeds?.rowReads() ?? 0
  const result = await runCountScenario(mounted, {
    scenario: entry.scenario,
    methodology: entry.methodology,
    apply: async () => {
      await entry.write(ctx)
      flush()
      // A handle that turns lazy inside the step is asked here too.
      await loadHooks(mounted.handle, feeds, step)?.settleLoads()
      settledAt = feeds?.rowReads() ?? 0
    },
    expected: () => snapshotFromStore(ctx.engine.getSnapshot(), parityLocals(ctx)),
    views: () => rowViewsFromStore(ctx.engine.getSnapshot(), engineLocals(ctx)),
  })
  // LOAD ISOLATION (G2): a load pending now, or one that landed after the
  // step's settle (in the harness's own `snapshot()`, after the reads were
  // sampled), is charged to no step. Refuse it here, where it was triggered.
  const after = loadHooks(mounted.handle, feeds, step)
  const pendingLoads = after?.pendingLoads() ?? 0
  if (pendingLoads > 0) {
    throw new Error(`${step} left ${pendingLoads} load(s) pending after the step`)
  }
  const late = (feeds?.rowReads() ?? 0) - settledAt
  if (late > 0) {
    throw new Error(
      `${step} loaded ${late} row(s) after the step settled its loads: charged to no step`,
    )
  }
  // STEP ISOLATION (POD-4618): a write still awaiting truth after its step is
  // retired later by the runtime's 60 s wall-clock sweep, in whichever step is
  // running then, and charged to it. Refuse it here, where it was written.
  const pending = pendingWrites(ctx)
  const allowed = entry.leavesPending?.(ctx) ?? []
  if (!isDeepStrictEqual(pending, allowed)) {
    throw new Error(
      `${entry.methodology} ${entry.scenario} left writes pending: ` +
        `[${pending.join(', ')}], expected [${allowed.join(', ')}]`,
    )
  }
  return { result, readsBudget }
}
