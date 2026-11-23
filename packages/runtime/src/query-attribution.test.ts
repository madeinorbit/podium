import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { addLoopAccounting, clearLoopAccounting } from './loop-accounting'
import {
  callerFrames,
  claimQueryAttribution,
  clearQueryDefinitionNames,
  definitionSiteName,
  drainHeavyStatementReads,
  formatTopQueries,
  HEAVY_READ_BYTES,
  nameQueryDefinition,
  parseRchar,
  type QueryCost,
  queryAttributionSnapshot,
  queryDefinitionName,
  queryKey,
  READ_SAMPLE_ARM_MS,
  readBytesSince,
  recordQuery,
  resetQueryAttribution,
  sampleBatchRead,
  sampleStatementRead,
  setThreadReadMeter,
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
    expect(key.startsWith('SELECT a, a,')).toBe(true)
    expect(key.slice(0, 40)).toMatch(/…$/)
  })

  // POD-6189: a cut select lost its table, so C1's extra grant reads were
  // reported as "select (table cut off)" and could not be attributed.
  it('keeps the table of a cut select and tells statements with one prefix apart', () => {
    const columns = 'SELECT ' + '"c", '.repeat(40) + '"z" FROM "grants" WHERE '
    const one = queryKey(columns + '"resource_id" = ?')
    const many = queryKey(columns + '"resource_id" IN (?, ?)')
    expect(one).toMatch(/… FROM "grants" #[0-9a-f]{8}$/)
    expect(many).toMatch(/… FROM "grants" #[0-9a-f]{8}$/)
    expect(one).not.toBe(many)
    expect(queryKey(columns + '"resource_id" = ?')).toBe(one)
  })

  it('appends no table when the cut already holds one', () => {
    const key = queryKey('INSERT INTO "sessions" (' + '"c", '.repeat(40) + '"z") VALUES (?)')
    expect(key).toMatch(/^INSERT INTO "sessions" .*… #[0-9a-f]{8}$/)
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
   * `driver.ts` on its own would also swallow `packages/harness/src/driver/driver.ts`,
   * which can be a caller. A
   * marker that is too broad does not fail loudly: it buries the answer.
   */
  it('keeps a caller whose file is also named driver.ts', () => {
    const raw = [
      'Error: statement issued',
      '    at get (/repo/apps/server/src/store/executor/driver.ts:324:83)',
      '    at resume (/repo/packages/harness/src/driver/driver.ts:77:9)',
    ].join('\n')
    expect(callerFrames(raw)).toBe('at resume (/repo/packages/harness/src/driver/driver.ts:77:9)')
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

/**
 * POD-7037. The incident returned 0 rows per call while reading about 130 MB,
 * and a stall line that says "0rows" hid it. Bun has no statement step counter,
 * so what a statement READ is measured instead, on the executions of statements
 * that already ran slow once.
 */
describe('bytes read per statement', () => {
  let counter = 0
  beforeEach(() => {
    counter = 0
    setThreadReadMeter(() => counter)
    resetQueryAttribution()
    clearQueryDefinitionNames()
  })
  afterEach(() => {
    setThreadReadMeter(undefined)
    resetQueryAttribution()
    clearQueryDefinitionNames()
  })

  const walk =
    'SELECT * FROM effects WHERE kind = ? AND target_id = ? ORDER BY created_at DESC LIMIT 1'

  it('samples nothing until the statement has run slow once', () => {
    expect(sampleStatementRead(walk)).toBeUndefined()
    recordQuery(walk, READ_SAMPLE_ARM_MS - 1, 0)
    expect(sampleStatementRead(walk)).toBeUndefined()
    recordQuery(walk, READ_SAMPLE_ARM_MS, 0)
    expect(sampleStatementRead(walk)).toBe(0)
    expect(sampleStatementRead('SELECT 1')).toBeUndefined()
  })

  it('measures what the statement read and reports it on the stall line', () => {
    recordQuery(walk, 40, 0)
    resetQueryAttribution()
    const before = sampleStatementRead(walk)
    counter += 50 * 1024 * 1024
    recordQuery(walk, 2200, 0, undefined, readBytesSince(before))
    expect(queryAttributionSnapshot().get(queryKey(walk))).toMatchObject({
      count: 1,
      rows: 0,
      maxMs: 2200,
      readBytes: 50 * 1024 * 1024,
      readSamples: 1,
    })
    expect(formatTopQueries(1)).toBe(`1x/2200ms/0rows/50.0MBread ${queryKey(walk)}`)
  })

  it('queues an execution that read past the heavy line, and only that one', () => {
    recordQuery(walk, 30, 0, undefined, HEAVY_READ_BYTES - 1)
    recordQuery(walk, 30, 0, undefined, HEAVY_READ_BYTES)
    expect(drainHeavyStatementReads()).toEqual([
      { key: queryKey(walk), readBytes: HEAVY_READ_BYTES, wallMs: 30, rows: 0 },
    ])
    expect(drainHeavyStatementReads()).toEqual([])
  })

  it('leaves the measuring to the outer seam inside a claim', () => {
    recordQuery(walk, 40, 0)
    expect(claimQueryAttribution(() => sampleStatementRead(walk))).toBeUndefined()
    expect(claimQueryAttribution(() => sampleBatchRead([walk]))).toBeUndefined()
    expect(sampleBatchRead(['SELECT 1', walk])).toBe(0)
    expect(sampleBatchRead(['SELECT 1'])).toBeUndefined()
  })

  it('reports no bytes, rather than zero, where the platform has no counter', () => {
    setThreadReadMeter(() => undefined)
    recordQuery(walk, 40, 0)
    expect(readBytesSince(sampleStatementRead(walk))).toBeUndefined()
  })
})

describe('parseRchar', () => {
  const bytes = (text: string) => new TextEncoder().encode(text)
  it('reads the first field of a proc io record', () => {
    const record = bytes('rchar: 50118779\nwchar: 12\nsyscr: 12237\n')
    expect(parseRchar(record, record.length)).toBe(50118779)
  })
  it('refuses a record that does not start with rchar', () => {
    const record = bytes('wchar: 12\n')
    expect(parseRchar(record, record.length)).toBeUndefined()
    expect(parseRchar(bytes('rchar: \n'), 8)).toBeUndefined()
  })
})

describe('definition names', () => {
  afterEach(() => {
    clearQueryDefinitionNames()
    resetQueryAttribution()
  })

  it('names the first frame outside prepared.ts, as a repository path', () => {
    const stack = [
      'Error: query definition',
      '    at register (/home/u/podium/packages/sync/src/adapters/sqlite/prepared.ts:76:16)',
      '    at preparedFamily (/home/u/podium/packages/sync/src/adapters/sqlite/prepared.ts:155:16)',
      '    at <anonymous> (/home/u/podium/apps/server/src/store/effects.ts:292:30)',
      '    at module code (/home/u/podium/apps/server/src/store/effects.ts:12:1)',
    ].join('\n')
    expect(definitionSiteName(stack)).toBe('apps/server/src/store/effects.ts:292')
  })

  it('names a frame of a bundle without a source map by its position', () => {
    const stack = [
      'Error: query definition',
      '    at register (/$bunfs/root/podium-server:91234:16)',
      '    at prepared (/$bunfs/root/podium-server:91240:16)',
      '    at /$bunfs/root/podium-server:402117:30',
    ].join('\n')
    expect(definitionSiteName(stack)).toBe('podium-server:402117')
  })

  it('accepts file URLs and returns nothing for a stack with no position', () => {
    expect(definitionSiteName('Error\n    at x (file:///r/apps/server/src/a.ts:3:4)')).toBe(
      'apps/server/src/a.ts:3',
    )
    expect(definitionSiteName('Error: no frames')).toBeUndefined()
  })

  it('puts the name of the defining site on the stall line, with the family shape', () => {
    const site = new Error('query definition')
    site.stack = 'Error\n    at <anonymous> (/r/apps/server/src/store/effects.ts:292:30)'
    nameQueryDefinition('SELECT * FROM effects WHERE status IN (?, ?)', site, 'active')
    recordQuery('SELECT * FROM effects WHERE status IN (?, ?)', 9, 0)
    expect(queryDefinitionName(queryKey('SELECT * FROM effects WHERE status IN (?, ?)'))).toBe(
      'apps/server/src/store/effects.ts:292 active',
    )
    expect(formatTopQueries(1)).toBe(
      '1x/9ms/0rows [apps/server/src/store/effects.ts:292 active] SELECT * FROM effects WHERE status IN (?, ?)',
    )
  })

  it('keeps the first definition of a text', () => {
    const first = new Error()
    first.stack = 'Error\n    at f (/r/apps/a.ts:1:1)'
    const second = new Error()
    second.stack = 'Error\n    at g (/r/apps/b.ts:2:1)'
    nameQueryDefinition('SELECT 1', first)
    nameQueryDefinition('SELECT 1', second)
    expect(queryDefinitionName('SELECT 1')).toBe('apps/a.ts:1')
  })
})
