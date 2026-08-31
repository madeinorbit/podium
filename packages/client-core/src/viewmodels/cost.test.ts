import type { CostModelTotalWire, TaskCostRowWire, TaskCostWire } from '@podium/model'
import { describe, expect, it } from 'vitest'
import {
  costCohort,
  modelTotalCostUsd,
  RATE_COHORT_MIN_REPLIES,
  taskCostRows,
  taskCostView,
} from './cost'
import { bucketCostUsd } from './usage'

const model = (over: Partial<CostModelTotalWire> = {}): CostModelTotalWire => ({
  model: 'claude-opus-5',
  inputTokens: 1_000_000,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheCreationTokens: 0,
  cacheCreation1hTokens: 0,
  messages: 1,
  ...over,
})

const wire = (over: Partial<TaskCostWire> = {}): TaskCostWire =>
  ({
    issueId: 'iss_1',
    state: 'costed',
    own: { models: [model()], messages: 1, sessionCount: 1 },
    rollup: { models: [model()], messages: 1, sessionCount: 1 },
    descendantCount: 0,
    provisional: false,
    floor: 'none',
    harnesses: ['claude-code'],
    sessions: [],
    ...over,
  }) as TaskCostWire

const row = (seq: number, over: Partial<TaskCostRowWire> = {}): TaskCostRowWire =>
  ({
    issueId: `iss_${seq}`,
    seq,
    title: `Task ${seq}`,
    stage: 'done',
    models: [model()],
    messages: 100,
    windowModels: [],
    windowMessages: 0,
    sessionCount: 1,
    floor: 'none',
    harnesses: ['claude-code'],
    ...over,
  }) as TaskCostRowWire

describe('pricing', () => {
  // The one price table, borrowed rather than restated. Opus 5 lists at $5/MTok
  // input; if this ever disagrees with `bucketCostUsd` there are two tables.
  it('prices a model total exactly as the usage sheet prices the same tokens', () => {
    const m = model({ outputTokens: 200_000, cacheReadTokens: 3_000_000 })
    expect(modelTotalCostUsd(m)).toBeCloseTo(
      bucketCostUsd({
        hour: '',
        model: m.model,
        inputTokens: m.inputTokens,
        outputTokens: m.outputTokens,
        cacheReadTokens: m.cacheReadTokens,
        cacheCreationTokens: m.cacheCreationTokens,
        cacheCreation1hTokens: m.cacheCreation1hTokens,
        messages: m.messages,
      }),
      10,
    )
    expect(modelTotalCostUsd(model())).toBeCloseTo(5, 6)
  })

  it('ranks the model split dearest first', () => {
    const view = taskCostView(
      wire({
        rollup: {
          models: [model({ model: 'claude-haiku-4-5' }), model({ model: 'claude-opus-5' })],
          messages: 2,
          sessionCount: 1,
        },
      }),
    )
    expect(view.rollup.models.map((m) => m.model)).toEqual(['claude-opus-5', 'claude-haiku-4-5'])
    expect(view.rollup.estCostUsd).toBeCloseTo(6, 6)
  })
})

describe('the cold states pass through untouched', () => {
  it('leaves a task with no sessions at zero dollars AND says why', () => {
    const view = taskCostView(
      wire({
        state: 'no-sessions',
        own: { models: [], messages: 0, sessionCount: 0 },
        rollup: { models: [], messages: 0, sessionCount: 0 },
      }),
    )
    expect(view.state).toBe('no-sessions')
    expect(view.rollup.estCostUsd).toBe(0)
    // A caller that prints the number without reading the state is the bug this
    // shape exists to make visible — the state is never absent.
    expect(view.ratePerReplyUsd).toBeNull()
  })

  it('keeps the floor and provisional marks on the view', () => {
    const view = taskCostView(wire({ floor: 'partial', harnesses: ['codex'], provisional: true }))
    expect(view).toMatchObject({ floor: 'partial', harnesses: ['codex'], provisional: true })
  })
})

describe('the rate cohort', () => {
  it('takes the median over tasks with more than twenty replies', () => {
    const cohort = costCohort([
      row(1, { messages: 100 }), // $5 / 100 = 0.05
      row(2, { messages: 50 }), // 0.10
      row(3, { messages: 25 }), // 0.20
      // Below the bar: one expensive turn would otherwise drag the median.
      row(4, { messages: RATE_COHORT_MIN_REPLIES }),
      row(5, { messages: 1 }),
    ])
    expect(cohort.taskCount).toBe(3)
    expect(cohort.medianUsdPerReply).toBeCloseTo(0.1, 6)
  })

  it('reports no median rather than a made-up one when nothing qualifies', () => {
    expect(costCohort([row(1, { messages: 3 })])).toEqual({
      medianUsdPerReply: null,
      taskCount: 0,
    })
  })

  it('reads a task against the cohort as a multiple', () => {
    const cohort = { medianUsdPerReply: 0.05, taskCount: 200 }
    const view = taskCostView(
      wire({
        rollup: { models: [model({ messages: 50 })], messages: 50, sessionCount: 1 },
      }),
      cohort,
    )
    expect(view.ratePerReplyUsd).toBeCloseTo(0.1, 6)
    expect(view.rateVsMedian).toBeCloseTo(2, 6)
  })

  it('has no multiple without a cohort', () => {
    expect(taskCostView(wire()).rateVsMedian).toBeNull()
  })
})

describe('the sheet rows', () => {
  it('ranks by cost and measures the multiple against the same set', () => {
    const { rows, cohort } = taskCostRows([
      row(1, { messages: 100 }),
      row(2, { messages: 100, models: [model({ inputTokens: 4_000_000 })] }),
    ])
    expect(rows.map((r) => r.seq)).toEqual([2, 1])
    expect(rows[0]?.estCostUsd).toBeCloseTo(20, 6)
    expect(cohort.taskCount).toBe(2)
    expect(rows[0]?.rateVsMedian).toBeCloseTo(1.6, 6)
    // Nothing in the window: the sheet's window reading is zero, and the
    // all-time figure beside it is not.
    expect(rows[0]?.windowCostUsd).toBe(0)
  })
})
