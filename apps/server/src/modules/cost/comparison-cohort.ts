import { RATE_COHORT_MIN_REPLIES, messagesOf, type CostCohortWire, type CostModelTotalWire } from '@podium/model'
import { bucketCostUsd } from '@podium/model/cost-pricing'

/** Same all-time own-cost rule as client-core's costCohort. */
export function cohortOfOwnTotals(totals: readonly CostModelTotalWire[][]): CostCohortWire {
  const rates: number[] = []
  for (const models of totals) {
    const messages = messagesOf(models)
    if (messages <= RATE_COHORT_MIN_REPLIES) continue
    const usd = models.reduce((n, m) => n + bucketCostUsd({ hour: '', ...m }), 0)
    if (usd > 0) rates.push(usd / messages)
  }
  if (rates.length === 0) return { medianUsdPerReply: null, taskCount: 0 }
  rates.sort((a, b) => a - b)
  const mid = rates.length >> 1
  return {
    medianUsdPerReply: rates.length % 2 === 1
      ? rates[mid]!
      : (rates[mid - 1]! + rates[mid]!) / 2,
    taskCount: rates.length,
  }
}
