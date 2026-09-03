import { describe, expect, it } from 'vitest'
import { formatTopQueries, type QueryCost, queryKey } from './query-attribution'

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
