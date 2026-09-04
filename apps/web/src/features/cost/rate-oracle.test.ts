import { costCohort, taskCostView } from '@podium/client-core/viewmodels'
import type { CostModelTotalWire, TaskCostRowWire, TaskCostWire } from '@podium/model/browser'
import { describe, expect, it } from 'vitest'
import { rateLabel } from './cost-format'

/**
 * THE RATE, AGAINST THE READ PATH'S OWN ORACLE.
 *
 * POD-1869 measured the read path over the live corpus at a stable commit and
 * got POD-1574 at $0.2159 per reply and 2.31x median, which matches the
 * coordinator's hand measurement. A panel screenshot then showed 5.9x for the
 * same task, and the question was whether this surface computes a rate of its
 * own.
 *
 * IT DOES NOT, AND THIS PINS THAT. Everything below runs the real
 * `costCohort` + `taskCostView` and asserts the oracle's figures come out the
 * other end. The 5.9x was a harness FIXTURE whose three invented cohort rows had
 * a median of $0.0256 per reply — 3.7x cheaper than the corpus — so the multiple
 * on screen was right about the data it was given and wrong about the world.
 *
 * If this file ever fails, the rate definition moved. The panel divides nothing.
 */

const ORACLE_USD_PER_REPLY = 0.2159
const ORACLE_MULTIPLE = 2.31
/** What the oracle's two figures imply the corpus median must be. */
const ORACLE_MEDIAN = ORACLE_USD_PER_REPLY / ORACLE_MULTIPLE

/** Opus cache reads price at $0.50/M, so a target dollar figure is exact. */
const cacheOnly = (usd: number, messages: number): CostModelTotalWire => ({
  model: 'claude-opus-5',
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: Math.round(usd * 2_000_000),
  cacheCreationTokens: 0,
  cacheCreation1hTokens: 0,
  messages,
})

const cohortRow = (seq: number, usdPerReply: number, messages: number): TaskCostRowWire => {
  const models = [cacheOnly(usdPerReply * messages, messages)]
  return {
    issueId: `i-${seq}`,
    seq,
    title: `cohort ${seq}`,
    stage: 'done',
    models,
    messages,
    rollupModels: models,
    rollupMessages: messages,
    windowModels: [],
    windowMessages: 0,
    sessionCount: 3,
    floor: 'none',
    harnesses: ['claude-code'],
  } as unknown as TaskCostRowWire
}

/** The measured spread, median on the corpus's own figure. */
const CORPUS: TaskCostRowWire[] = [
  cohortRow(1, 0.03, 500),
  cohortRow(2, 0.06, 800),
  cohortRow(3, ORACLE_MEDIAN, 1000),
  cohortRow(4, 0.15, 600),
  cohortRow(5, 0.255, 900),
]

/** POD-1574 as the read path reports it: $225.81 over 1,046 replies. */
const POD_1574 = (): TaskCostWire => {
  const totals = { models: [cacheOnly(225.81, 1046)], messages: 1046, sessionCount: 10 }
  return {
    issueId: 'i-1574',
    state: 'costed',
    own: totals,
    rollup: totals,
    descendantCount: 0,
    provisional: false,
    floor: 'none',
    harnesses: ['claude-code'],
    sessions: [],
  } as unknown as TaskCostWire
}

describe('the rate this surface renders', () => {
  it("reproduces the read path's oracle: $0.2159 per reply", () => {
    const view = taskCostView(POD_1574(), costCohort(CORPUS))
    expect(view.ratePerReplyUsd).toBeCloseTo(ORACLE_USD_PER_REPLY, 4)
  })

  it('reproduces the oracle multiple, and prints it as 2.3x median', () => {
    const view = taskCostView(POD_1574(), costCohort(CORPUS))
    expect(view.rateVsMedian).toBeCloseTo(ORACLE_MULTIPLE, 2)
    expect(rateLabel(view.rateVsMedian as number)).toBe('2.3x median')
  })

  it('takes the median from OWN cost per task, not from the rollup', () => {
    // A cohort of rollups counts an epic's work once for the epic and again for
    // every ancestor above it, dragging the median up with every tree. Doubling
    // every rollup column must not move a median built from own.
    const inflated = CORPUS.map((r) => ({
      ...r,
      rollupModels: [cacheOnly(1000, 50)],
      rollupMessages: 50,
    })) as TaskCostRowWire[]
    expect(costCohort(inflated).medianUsdPerReply).toBeCloseTo(
      costCohort(CORPUS).medianUsdPerReply as number,
      8,
    )
  })

  it('is null rather than a multiple with no cohort behind it', () => {
    expect(taskCostView(POD_1574()).rateVsMedian).toBeNull()
  })
})
