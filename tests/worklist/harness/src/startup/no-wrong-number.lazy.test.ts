/**
 * POD-5594 — the "no wrong number" check on the production lazy pool
 * (h1a1): the whole feed is known, history rows are cold. Before they load,
 * every answer must equal the full bootstrap or be LOADING; after they load,
 * every answer must equal it. Its own file so it gets its own worker: the
 * control plus a fully loaded lazy pool is the memory-heavy pair.
 */
import { beforeAll, describe, expect, it } from 'vitest'
import { writeResult } from '../results'
import { ask, assertNoWrongNumber, checkNoWrongNumber, startupQuestions, startupTargets, summarize } from './no-wrong-number'
import { collectGarbage, fullPool, hydrateAll, lazyPool, memoryAt, openStartupFeed, type StartupFeed } from './startup-states'

let feed: StartupFeed
let questions: ReturnType<typeof startupQuestions>
let control: Map<string, unknown>

beforeAll(async () => {
  feed = await openStartupFeed({ history: 1, active: 1 })
  questions = startupQuestions(startupTargets(feed.rows))
  const pool = fullPool(feed)
  control = ask(pool, questions)
  memoryAt('control asked')
  pool.dispose()
  collectGarbage()
  memoryAt('control dropped')
}, 600_000)

describe('the production lazy pool against the full bootstrap (h1a1)', () => {
  it('the lazy pool, before and after its cold rows load', () => {
    const handle = lazyPool(feed)
    try {
      memoryAt('lazy pool built')
      const before = checkNoWrongNumber(control, ask(handle.pool, questions))
      memoryAt('lazy pool asked')
      const loaded = hydrateAll(handle.pool, questions)
      memoryAt('lazy pool loaded')
      const after = checkNoWrongNumber(control, ask(handle.pool, questions))
      const result = { before: summarize(before), after: summarize(after), loaded,
        wrongBefore: before.wrong.slice(0, 40), wrongAfter: after.wrong.slice(0, 40) }
      console.info(`[no-wrong-number] lazy pool: ${JSON.stringify({ before: result.before, after: result.after, loaded })}`)
      writeResult('startup-no-wrong-number-lazy-h1a1', result)
      // History known but not loaded: every answer right or on its way.
      assertNoWrongNumber(before, 'lazy pool before loading')
      expect(before.loading.length).toBeGreaterThan(0)
      assertNoWrongNumber(after, 'lazy pool after loading')
      expect(after.loading).toEqual([])
    } finally {
      handle.dispose()
      collectGarbage()
    }
  }, 600_000)
})
