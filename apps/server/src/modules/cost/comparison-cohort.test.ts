import { costCohort, taskCostView } from '@podium/client-core/values'
import { foldModelTotals, type CostModelTotalWire, type TaskCostRowWire, type TaskCostWire } from '@podium/model'
import { describe, expect, it } from 'vitest'
import { cohortOfOwnTotals } from './comparison-cohort'

function model(index: number, messages = 21): CostModelTotalWire {
  return {
    model: ['claude-opus-5', 'gpt-6-sol', 'claude-fable-5-1', 'unknown'][index % 4]!,
    inputTokens: (index + 1) * 913, outputTokens: index * 577,
    cacheReadTokens: index * 111, cacheCreationTokens: index * 79,
    cacheCreation1hTokens: index * 37, messages,
  }
}
function legacyRow(models: CostModelTotalWire[]): TaskCostRowWire {
  return { models, messages: models.reduce((n, m) => n + m.messages, 0) } as TaskCostRowWire
}

describe('server cohort parity against the existing client computation', () => {
  for (const count of [0, 1, 2, 3, 4096]) {
    it(`preserves the median and task rate for ${count} tasks`, () => {
      const totals = Array.from({ length: count }, (_, i) =>
        foldModelTotals([[model(i, i % 5 === 0 ? 20 : 21)], [model(i + 4, 1)]]))
      // Threshold, zero-cost and no-replies controls travel through BOTH paths.
      totals.push([model(0, 20)], [{ ...model(0), inputTokens: 0 }], [model(2, 0)])
      const rows = totals.map(legacyRow)
      const expected = costCohort(rows)
      expect(cohortOfOwnTotals(totals)).toEqual(expected)
      const task = {
        state: 'costed', own: { models: [model(3)], messages: 21, sessionCount: 1 },
        rollup: { models: [model(9)], messages: 42, sessionCount: 2 },
        descendantCount: 1, provisional: false, floor: 'none', harnesses: [],
        uncostedSessionCount: 0, sessions: [],
      } as unknown as TaskCostWire
      expect(taskCostView(task, cohortOfOwnTotals(totals)))
        .toEqual(taskCostView(task, expected))
    })
  }
})
