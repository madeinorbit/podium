import { describe, expect, it } from 'vitest'
import {
  attributeQueries,
  formatTopQueries,
  queryAttributionEnabled,
  queryAttributionSnapshot,
  queryKey,
  resetQueryAttribution,
  type QueryCost,
} from './query-attribution'
import type { SqlDatabase, SqlStatement } from './types'

/**
 * POD-1630. The instrument exists to name the statement behind a stall, so what is
 * worth pinning is the naming and the disabled-path cost model — not the timing
 * numbers, which are the machine's to report.
 */

function fakeDatabase(rowsPerAll = 3): SqlDatabase & { prepared: string[] } {
  const prepared: string[] = []
  const db = {
    prepared,
    prepare(sql: string): SqlStatement {
      prepared.push(sql)
      return {
        run: () => ({ changes: 1, lastInsertRowid: 1 }),
        get: () => ({ id: 1 }),
        all: () => Array.from({ length: rowsPerAll }, (_, i) => ({ id: i })),
      }
    },
    exec: () => {},
    close: () => {},
  }
  return db
}

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

describe('attributeQueries', () => {
  it('hands the database back UNCHANGED when disabled — the cost model', () => {
    // Stated, not inherited: PODIUM_LOOP_PROFILE is set in some shells (the live
    // server unit sets it), so a test that read the ambient flag would assert
    // whatever the environment happened to be. The default is covered below.
    const db = fakeDatabase()
    expect(attributeQueries(db, false)).toBe(db)
  })

  it('defaults to the PODIUM_LOOP_PROFILE flag when the caller says nothing', () => {
    const db = fakeDatabase()
    expect(attributeQueries(db) === db).toBe(!queryAttributionEnabled)
  })

  it('preserves statement results and prepares against the real database once', () => {
    const db = fakeDatabase(3)
    const st = attributeQueries(db, true).prepare('SELECT * FROM podium_events WHERE id > ?')
    expect(st.all(0)).toHaveLength(3)
    expect(st.get(0)).toEqual({ id: 1 })
    expect(st.run(0).changes).toBe(1)
    expect(db.prepared).toEqual(['SELECT * FROM podium_events WHERE id > ?'])
  })

  it('attributes rows to the statement that returned them', () => {
    resetQueryAttribution()
    const st = attributeQueries(fakeDatabase(7), true).prepare('SELECT * FROM podium_events')
    st.all(0)
    st.all(0)
    const cost = queryAttributionSnapshot().get('SELECT * FROM podium_events')
    expect(cost?.count).toBe(2)
    expect(cost?.rows).toBe(14)
  })

  it('records a throwing statement rather than losing the window to it', () => {
    resetQueryAttribution()
    const exploding: SqlDatabase = {
      prepare: () => ({
        run: () => {
          throw new Error('constraint failed')
        },
        get: () => undefined,
        all: () => [],
      }),
      exec: () => {},
      close: () => {},
    }
    const st = attributeQueries(exploding, true).prepare('INSERT INTO t VALUES (?)')
    expect(() => st.run(1)).toThrow('constraint failed')
    expect(queryAttributionSnapshot().get('INSERT INTO t VALUES (?)')?.count).toBe(1)
  })
})
