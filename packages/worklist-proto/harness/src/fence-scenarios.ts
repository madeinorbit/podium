/**
 * POD-4563 (L6a) — the one scenario list every arm's fences run over.
 *
 * Every per-row scenario of the methodology (#1–#10; lifecycle scenarios
 * #11–#13 replace the whole slice and are L5e's), in methodology order, on ONE
 * engine, as the scenario writes intend. Each step is a `CountInput` carrying
 * the row-view oracle, so `assertCommits` can hold the arm to the exact set of
 * rows whose view changed, and the L5a reads budget where L5a fixed one.
 *
 * LOCALS COME FROM THE ENGINE. The row-view oracle reads selection and the
 * coarse clock from the engine store (`engineLocals`), because the #3 click
 * and the #8 tick are engine writes. The parity snapshot stays the
 * unselected baseline (spec §7).
 */

import type { ArmHandle } from '../../shared/src/arm'
import {
  armMarkReadRejection,
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
  type ScenarioEngine,
} from '../../shared/src/scenarios'
import type { SliceLocals } from '../../shared/src/slice-types'
import {
  ancestorCount,
  phaseChangeReadBudget,
  READ_BUDGETS,
  runCountScenario,
  type CountResult,
  type MountedArm,
} from './count-harness'
import { rowViewsFromStore, snapshotFromStore } from './oracle/index'

export interface FenceScenario {
  scenario: string
  /** Methodology §5.8 number. */
  methodology: string
  /** The write, settled. */
  write(ctx: ScenarioEngine): Promise<unknown>
  /** L5a's reads budget for this change, or null where L5a fixed none. */
  readsBudget(ctx: ScenarioEngine): number | null
}

/** Selection and clock as the engine holds them: what the row views show. */
export function engineLocals(ctx: ScenarioEngine): SliceLocals {
  const store = ctx.engine.getSnapshot()
  return { selectedIssueId: store.selectedIssueId ?? null, coarseNow: store.coarseNow }
}

/** The parity snapshot's locals: the engine clock, no selection (spec §7). */
export function parityLocals(ctx: ScenarioEngine): SliceLocals {
  return { selectedIssueId: null, coarseNow: ctx.engine.getSnapshot().coarseNow }
}

function parentOf(ctx: ScenarioEngine): (id: string) => string | null | undefined {
  return (id) => ctx.engine.getSnapshot().issueProjections.find((issue) => issue.id === id)?.parentId
}

const none = (): null => null

export const FENCE_SCENARIOS: readonly FenceScenario[] = [
  { scenario: 'unrelatedHeartbeat', methodology: '#1', write: writeHeartbeat, readsBudget: () => READ_BUDGETS.unrelatedHeartbeat },
  {
    scenario: 'visibleSessionPhaseChange',
    methodology: '#2',
    write: writePhaseChange,
    readsBudget: (ctx) => phaseChangeReadBudget(ancestorCount(ctx.targets.visibleRootId, parentOf(ctx))),
  },
  { scenario: 'selectionClick', methodology: '#3', write: (ctx) => writeSelectionClick(ctx), readsBudget: () => READ_BUDGETS.selectionClick },
  { scenario: 'visibleTitleRename', methodology: '#4', write: (ctx) => writeTitleRename(ctx), readsBudget: () => READ_BUDGETS.visibleTitleRename },
  { scenario: 'stageMoveAcrossGroups', methodology: '#5', write: (ctx) => writeStageMove(ctx), readsBudget: () => READ_BUDGETS.stageMoveNeighbourhood },
  { scenario: 'newIssue', methodology: '#6a', write: (ctx) => writeNewIssue(ctx), readsBudget: none },
  { scenario: 'archiveIssue', methodology: '#6b', write: (ctx) => writeArchiveIssue(ctx), readsBudget: none },
  { scenario: 'evictWithoutRevision', methodology: '#6c', write: (ctx) => writeEvictIssue(ctx), readsBudget: none },
  { scenario: 'evictKeeperWithoutRevision', methodology: '#6d', write: (ctx) => writeEvictKeeperIssue(ctx), readsBudget: none },
  { scenario: 'parentReassignment', methodology: '#7', write: (ctx) => writeParentReassignment(ctx), readsBudget: none },
  { scenario: 'clockTick', methodology: '#8', write: (ctx) => writeClockTick(ctx), readsBudget: none },
  { scenario: 'optimisticPress', methodology: '#9a', write: (ctx) => writeOptimisticPress(ctx), readsBudget: none },
  { scenario: 'optimisticEcho', methodology: '#9b', write: (ctx) => writeOptimisticEcho(ctx), readsBudget: none },
  {
    scenario: 'optimisticPressRejected',
    methodology: '#9c',
    write: async (ctx) => {
      armMarkReadRejection(ctx)
      await writeOptimisticPress(ctx)
    },
    readsBudget: none,
  },
  { scenario: 'burst50', methodology: '#10', write: writeBurst50, readsBudget: none },
]

/** One fenced step: the count result plus the budget that applied. */
export interface FenceStep {
  result: CountResult
  readsBudget: number | null
}

/**
 * Run every fence scenario, in order, against one mounted arm on one engine.
 * `flush` drains the arm's row source after each write (`createRowSource`'s
 * `flush`). `each` runs after every step, before the next write — the fences
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
    const readsBudget = entry.readsBudget(ctx)
    const result = await runCountScenario(mounted, {
      scenario: entry.scenario,
      methodology: entry.methodology,
      apply: async () => {
        await entry.write(ctx)
        flush()
      },
      expected: () => snapshotFromStore(ctx.engine.getSnapshot(), parityLocals(ctx)),
      views: () => rowViewsFromStore(ctx.engine.getSnapshot(), engineLocals(ctx)),
    })
    const step = { result, readsBudget }
    steps.push(step)
    each(step, mounted.handle)
  }
  return steps
}
