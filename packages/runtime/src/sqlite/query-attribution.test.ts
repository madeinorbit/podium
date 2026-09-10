import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  attributeQueries,
  queryAttributionSnapshot,
  resetQueryAttribution,
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
        // `values` is what a drizzle BUILDER read decodes through [POD-3395]; a
        // fake without it is a statement the probe can no longer observe.
        values: () => Array.from({ length: rowsPerAll }, (_, i) => [i]),
      }
    },
    exec: () => {},
    close: () => {},
  }
  return db
}

describe('attributeQueries', () => {
  it('hands the database back UNCHANGED when disabled — the cost model', () => {
    // Stated, not inherited: PODIUM_LOOP_PROFILE is set in some shells (the live
    // server unit sets it), so a test that read the ambient flag would assert
    // whatever the environment happened to be. The default is covered below.
    const db = fakeDatabase()
    expect(attributeQueries(db, false)).toBe(db)
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
        values: () => {
          throw new Error('constraint failed')
        },
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

/**
 * The default `enabled` argument is the resolved profile level, which this
 * wrapper and `../query-attribution` both read at IMPORT — so each direction is
 * a re-import under a STATED environment. Reading whatever this runner carries
 * would assert the environment instead of the wiring: `PODIUM_LOOP_PROFILE` is
 * set in some shells on this host, and a test run that states nothing resolves
 * `off` (POD-3827).
 */
describe('the default enabled argument', () => {
  const KEYS = ['PODIUM_LOOP_PROFILE', 'PODIUM_STATE_DIR', 'PODIUM_APP_VERSION'] as const
  const priorEnv: Record<string, string | undefined> = {}
  let dir: string

  beforeEach(() => {
    for (const key of KEYS) priorEnv[key] = process.env[key]
    dir = mkdtempSync(join(tmpdir(), 'podium-query-attribution-'))
    process.env.PODIUM_STATE_DIR = dir
    // A SOURCE run, so `off` below is the test-run rule answering and not the
    // packaged default — which would make the first case pass either way.
    process.env.PODIUM_APP_VERSION = 'dev'
    vi.resetModules()
  })
  afterEach(() => {
    for (const [key, value] of Object.entries(priorEnv)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    rmSync(dir, { recursive: true, force: true })
  })

  it('hands a test run its database back unwrapped, because a test run is off', async () => {
    delete process.env.PODIUM_LOOP_PROFILE
    const { attributeQueries: subject } = await import('./query-attribution')
    const db = fakeDatabase()
    expect(subject(db)).toBe(db)
  })

  it('wraps it when the environment states attribution', async () => {
    process.env.PODIUM_LOOP_PROFILE = 'attribution'
    const { attributeQueries: subject } = await import('./query-attribution')
    const db = fakeDatabase()
    expect(subject(db)).not.toBe(db)
  })
})
