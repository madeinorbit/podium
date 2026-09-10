import { afterEach, describe, expect, it } from 'vitest'
import { addLoopAccounting, clearLoopAccounting } from './loop-accounting'
import {
  callerFrames,
  formatTopQueries,
  type QueryCost,
  queryKey,
  recordQuery,
  resetQueryAttribution,
} from './query-attribution'

/**
 * POD-1630. The instrument exists to name the statement behind a stall, so what is
 * worth pinning is the naming and the disabled-path cost model — not the timing
 * numbers, which are the machine's to report.
 */

describe('queryKey', () => {
  it('folds whitespace so one query written across lines aggregates as one key', () => {
    expect(queryKey('SELECT *\n  FROM podium_events\n  WHERE id > ?')).toBe(
      'SELECT * FROM podium_events WHERE id > ?',
    )
  })

  it('truncates to keep a stall line readable, preserving the identifying prefix', () => {
    const key = queryKey('SELECT ' + 'a, '.repeat(100) + 'z FROM t', 40)
    expect(key).toHaveLength(40)
    expect(key.startsWith('SELECT a, a,')).toBe(true)
    expect(key.endsWith('…')).toBe(true)
  })
})

describe('formatTopQueries', () => {
  it('ranks by summed wall time and bounds the line to `limit` statements', () => {
    const costs = new Map<string, QueryCost>([
      ['SELECT cheap', { count: 9, wallMs: 3, rows: 9 }],
      ['SELECT costly', { count: 2, wallMs: 800, rows: 4000 }],
      ['SELECT middling', { count: 1, wallMs: 50, rows: 10 }],
    ])
    expect(formatTopQueries(2, costs)).toBe(
      '2x/800ms/4000rows SELECT costly | 1x/50ms/10rows SELECT middling',
    )
  })

  it('is empty when nothing ran, so the stall line omits the segment entirely', () => {
    expect(formatTopQueries(3, new Map())).toBe('')
  })
})

/**
 * The `sql` bucket (§6.1). It is the one bucket declared NESTED, because every
 * statement this records ran inside something else that is also being measured —
 * an rpc handler, a timer callback, a socket frame — so the minute record
 * subtracts it before comparing the bucket sum to busy time.
 */
describe('bucket attribution', () => {
  afterEach(() => {
    resetQueryAttribution()
    clearLoopAccounting()
  })

  it('bills a statement execution to the sql bucket at its wall time', () => {
    const calls: [string, number][] = []
    addLoopAccounting({ attribute: (bucket, wallMs) => calls.push([bucket, wallMs]) })
    recordQuery('SELECT 1', 12.5, 1)
    recordQuery('SELECT 2', 3, 0)
    expect(calls).toEqual([
      ['sql', 12.5],
      ['sql', 3],
    ])
  })

  it('records with no accounting handle — a statement may run before boot sets one', () => {
    clearLoopAccounting()
    expect(() => recordQuery('SELECT 1', 5, 1)).not.toThrow()
    expect(formatTopQueries(1)).toContain('SELECT 1')
  })
})

/**
 * POD-3851. A `full` dump on the live host showed, for every one of the six
 * hottest statements, nothing but the executor's own frames — so the stacks
 * could not name the module that issued the query, which is the only reason
 * they are collected. Two halves fixed that: the capture MOVED to the caller's
 * turn (`queryClientOver`, tested at the seam in
 * `apps/server/src/store/executor/statement-probe.test.ts`), and the frames of
 * the path it is captured through are dropped here so the top frame is the
 * caller. This pins the second half, which is a pure string transform.
 */
describe('callerFrames', () => {
  /** A capture taken in `queryClientOver.get`, verbatim in shape. */
  const captured = [
    'Error: statement issued',
    '    at issuedHere (/repo/apps/server/src/store/executor/driver.ts:309:43)',
    '    at get (/repo/apps/server/src/store/executor/driver.ts:324:83)',
    '    at <anonymous> (/repo/apps/server/src/store/executor/sync-drizzle.ts:175:42)',
    '    at get (/repo/node_modules/drizzle-orm/sqlite-proxy/session.js:24:26)',
    '    at get (/repo/node_modules/drizzle-orm/sqlite-core/async/session.js:120:36)',
    '    at readUser (/repo/apps/server/src/modules/users/store-users.ts:412:20)',
    '    at loadFrame (/repo/apps/server/src/modules/frames/frame.ts:88:5)',
  ].join('\n')

  it('drops the plumbing so the top frame is the module that issued the query', () => {
    expect(callerFrames(captured).split('\n')).toEqual([
      'at readUser (/repo/apps/server/src/modules/users/store-users.ts:412:20)',
      'at loadFrame (/repo/apps/server/src/modules/frames/frame.ts:88:5)',
    ])
  })

  it('drops the two instruments that record, whichever seam saw the statement', () => {
    const raw = [
      'Error',
      '    at recordCallerStack (/repo/packages/runtime/src/query-attribution.ts:200:1)',
      '    at execute (/repo/apps/server/src/store/executor/statement-probe.ts:325:13)',
      '    at migrate (/repo/apps/server/src/migrations/run.ts:31:7)',
    ].join('\n')
    expect(callerFrames(raw)).toBe('at migrate (/repo/apps/server/src/migrations/run.ts:31:7)')
  })

  /**
   * `driver.ts` on its own would also swallow `packages/agent-runtime/src/driver.ts`
   * and `packages/composer/src/driver.ts`, either of which can be a caller. A
   * marker that is too broad does not fail loudly: it buries the answer.
   */
  it('keeps a caller whose file is also named driver.ts', () => {
    const raw = [
      'Error: statement issued',
      '    at get (/repo/apps/server/src/store/executor/driver.ts:324:83)',
      '    at resume (/repo/packages/agent-runtime/src/driver.ts:77:9)',
    ].join('\n')
    expect(callerFrames(raw)).toBe('at resume (/repo/packages/agent-runtime/src/driver.ts:77:9)')
  })

  it('caps the sample so one stall line stays readable', () => {
    const deep = [
      'Error',
      ...Array.from({ length: 40 }, (_, i) => `    at f${i} (/repo/a.ts:${i}:1)`),
    ]
    expect(callerFrames(deep.join('\n')).split('\n')).toHaveLength(12)
  })

  it('survives a stack that is only its message, or none at all', () => {
    expect(callerFrames('Error: statement issued')).toBe('')
    expect(callerFrames('')).toBe('')
  })
})
