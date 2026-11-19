import { describe, expect, it } from 'vitest'
import {
  ask,
  assertNoWrongNumber,
  checkNoWrongNumber,
  startupQuestions,
  startupTargets,
} from './no-wrong-number'
import {
  collectGarbage,
  firstDownloadPool,
  fullPool,
  openStartupFeed,
  policySetPool,
} from './startup-states'

/** Search readers must admit an incomplete device answer on both growth axes.
 * Product requests and their eventual server records are covered in issue-search
 * and collections tests; the full-load control here is the old local answer. */
describe('issue search startup safety on the two-axis corpus', () => {
  for (const history of [1, 10])
    for (const active of [1, 4] as const) {
      it(`device answers are equal or LOADING at h${history}a${active}`, async () => {
        collectGarbage()
        const feed = await openStartupFeed({ history, active })
        const questions = startupQuestions(startupTargets(feed.rows)).filter(
          (question) => question.group === 'search',
        )
        const controlPool = fullPool(feed)
        const control = ask(controlPool, questions)
        controlPool.dispose()
        collectGarbage()
        for (const make of [() => firstDownloadPool(feed, 1), () => policySetPool(feed)]) {
          const pool = make()
          try {
            const report = checkNoWrongNumber(control, ask(pool, questions))
            expect(report.asked).toBe(questions.length)
            expect(report.loading.length).toBeGreaterThan(0)
            assertNoWrongNumber(report, `search h${history}a${active}`)
          } finally {
            pool.dispose()
            collectGarbage()
          }
        }
        // The oracle is armed: an omitted historical hit is a wrong number.
        const corrupt = new Map(control)
        const name = [...control.keys()][0]!
        corrupt.set(name, ['deliberately-wrong-search-id'])
        expect(() => assertNoWrongNumber(checkNoWrongNumber(control, corrupt))).toThrow(
          /wrong numbers/,
        )
      }, 600_000)
    }
})
