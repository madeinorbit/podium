import type { CostModelTotalWire, TaskCostRowWire, TaskCostWire } from '@podium/model'
import { describe, expect, it } from 'vitest'
import {
  COST_HEDGE,
  costCohort,
  costHarnessLabel,
  formatCostExact,
  formatCostMark,
  formatCostRounded,
  modelTotalCostUsd,
  RATE_COHORT_MIN_REPLIES,
  taskCostRows,
  taskCostView,
  taskRateUsd,
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
    rollupModels: over.rollupModels ?? over.models ?? [model()],
    rollupMessages: over.rollupMessages ?? over.messages ?? 100,
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

describe('the read-time stamp', () => {
  it('passes a read time through, and null when there is none', () => {
    expect(taskCostView(wire({ sampledAt: '2026-09-01T00:00:00.000Z' })).sampledAt).toBe(
      '2026-09-01T00:00:00.000Z',
    )
    expect(taskCostView(wire()).sampledAt).toBeNull()
    expect(taskCostRows([row(1)]).rows[0]?.sampledAt).toBeNull()
  })
})

describe('one rate, two surfaces', () => {
  // POD-1869 finding 6: the panel divided the rollup and the sheet divided own
  // cost, so one task read 1.97x in one place and 2.51x in the other.
  it('gives a parent the SAME rate in the sheet as in the panel', () => {
    const own = model({ messages: 50 }) // $5 over 50 replies
    const rollup = model({ inputTokens: 3_000_000, messages: 100 }) // $15 over 100

    // The sheet ranks the tasks and derives the cohort from the same set; the
    // panel is handed that cohort. Same task, same two numbers, both surfaces.
    const { rows, cohort } = taskCostRows([
      row(1, { models: [own], messages: 50, rollupModels: [rollup], rollupMessages: 100 }),
    ])
    const panel = taskCostView(
      wire({
        own: { models: [own], messages: 50, sessionCount: 1 },
        rollup: { models: [rollup], messages: 100, sessionCount: 3 },
      }),
      cohort,
    )

    expect(panel.ratePerReplyUsd).toBeCloseTo(0.15, 6)
    expect(rows[0]?.ratePerReplyUsd).toBeCloseTo(0.15, 6)
    expect(rows[0]?.rateVsMedian).toBeCloseTo(panel.rateVsMedian as number, 6)
    // Own rate is $5/50 = 0.10, so the rollup rate reads 1.5x the cohort — and
    // it would have read 1.0x if the sheet had kept dividing own cost.
    expect(rows[0]?.rateVsMedian).toBeCloseTo(1.5, 6)
  })

  it('builds the cohort from OWN cost, so an epic is not counted once per ancestor', () => {
    // Each task's own rate is $5/100 = 0.05; the rollups are ten times larger
    // and must not reach the median.
    const cohort = costCohort([
      row(1, { rollupModels: [model({ inputTokens: 10_000_000 })], rollupMessages: 100 }),
      row(2, { rollupModels: [model({ inputTokens: 10_000_000 })], rollupMessages: 100 }),
      row(3, { rollupModels: [model({ inputTokens: 10_000_000 })], rollupMessages: 100 }),
    ])
    expect(cohort.medianUsdPerReply).toBeCloseTo(0.05, 6)
  })

  it('has no rate at all without replies, rather than a zero', () => {
    expect(taskRateUsd(12, 0)).toBeNull()
    expect(taskRateUsd(12, 4)).toBeCloseTo(3, 6)
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
    // Rate from the rollup (here equal to own, no descendants), cohort from own.
    expect(rows[0]?.rateVsMedian).toBeCloseTo(1.6, 6)
    // Nothing in the window: the sheet's window reading is zero, and the
    // all-time figure beside it is not.
    expect(rows[0]?.windowCostUsd).toBe(0)
  })
})

describe('how a figure is worded', () => {
  // The three real missions the design is drawn against (POD-1604 §04).
  it('rounds the way the chip reads, on the real figures', () => {
    expect(formatCostRounded(225.81)).toBe('$226')
    expect(formatCostRounded(262.88)).toBe('$263')
    expect(formatCostRounded(92.64)).toBe('$93')
  })

  it('keeps cents only below $10, where they ARE the significant figures', () => {
    expect(formatCostRounded(4.8)).toBe('$4.80')
    expect(formatCostRounded(4.4)).toBe('$4.40')
    expect(formatCostRounded(0.12)).toBe('$0.12')
    // The boundary itself is a whole-dollar reading, not $10.00.
    expect(formatCostRounded(10)).toBe('$10')
    expect(formatCostRounded(9.99)).toBe('$9.99')
  })

  it('holds to three significant figures once a figure runs past them', () => {
    expect(formatCostRounded(1234)).toBe('$1,230')
    expect(formatCostRounded(12_345)).toBe('$12,300')
  })

  it('prints the exact figure to the cent, and a nil own-side as $0', () => {
    expect(formatCostExact(225.81)).toBe('$225.81')
    expect(formatCostExact(120.79)).toBe('$120.79')
    // POD-1484's own side: it spent nothing itself. `$0.00` reads as a measured
    // zero; `$0` reads as the absence it is.
    expect(formatCostExact(0)).toBe('$0')
  })

  it('marks a lower bound with ≥ and an estimate with ≈', () => {
    expect(formatCostMark(225.81, 'none')).toBe('≈$226')
    expect(formatCostMark(92.64, 'partial')).toBe('≥$93')
  })

  it('names the harnesses a floor rests on, and never lies about Grok', () => {
    expect(costHarnessLabel(['codex'])).toBe('all Codex')
    expect(costHarnessLabel(['claude-code', 'codex'])).toBe('Claude + Codex')
    // The case an arm-per-harness enum got wrong: POD-1484 really reads this.
    expect(costHarnessLabel(['codex', 'grok'])).toBe('Codex + Grok')
    expect(costHarnessLabel([])).toBe('')
  })

  it('states the hedge in exactly one wording', () => {
    expect(COST_HEDGE).toBe('at list price for the same tokens — not what you were billed')
  })
})
