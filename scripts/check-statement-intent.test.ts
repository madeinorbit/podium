/**
 * THE THREE WAYS THE DECLARED-INTENT GATE REFUSES [POD-3426].
 *
 * The gate's product is an ABSENCE — "no converted call site declares a write as
 * a read" — and POD-3391 shipped it into a corpus where that absence was
 * guaranteed by arithmetic: no repository declared `read`, so `FATAL 0` was true
 * before a query ran. Planting POD-3321's exact defect in two converted
 * repositories produced a byte-identical report, twice.
 *
 * So the refusals are the part worth testing, and BOTH halves of each: a gate
 * that only ever refuses is as useless as one that never does.
 */

import { openDatabase } from '@podium/runtime/sqlite'
import { sql } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import { laneIntentAudit } from '../apps/server/src/store/executor/harness'
import { stageASeam } from '../apps/server/src/test-support/stage-a-seam'
import { gateVerdict, type LaneReport } from './check-statement-intent'

const report = (over: Partial<LaneReport> = {}): LaneReport => ({
  totals: { examined: 10, derivedWrite: 6, derivedRead: 4, inconclusive: 0 },
  reach: { gradedReadDeclarations: 4, fromOutsideTheExecutor: 4 },
  findings: [],
  ...over,
})

const fatalFinding = {
  disagreement: 'write-declared-read' as const,
  fatal: true,
  declared: 'read' as const,
  derived: 'write' as const,
  reason: 'leading INSERT',
  sql: "INSERT INTO notes (body) VALUES ('x')",
  site: 'apps/server/src/store/notes.ts:12',
}

describe('gateVerdict', () => {
  it('passes a corpus that ran, could have failed, and did not', () => {
    expect(gateVerdict(report())).toEqual({ code: 0 })
  })

  it('fails on a FATAL finding', () => {
    const verdict = gateVerdict(report({ findings: [fatalFinding] }))
    expect(verdict.code).toBe(1)
    expect(verdict.refusal).toBeUndefined()
  })

  it('does not fail on an over-declared read, which rule 16 makes the safe default', () => {
    expect(gateVerdict(report({ findings: [{ ...fatalFinding, fatal: false }] }))).toEqual({
      code: 0,
    })
  })

  it('fails a corpus it examined nothing in', () => {
    const verdict = gateVerdict(
      report({ totals: { examined: 0, derivedWrite: 0, derivedRead: 0, inconclusive: 0 } }),
    )
    expect(verdict.code).toBe(1)
    expect(verdict.refusal).toContain('EXAMINED NOTHING')
  })

  /**
   * THE ONE THIS ISSUE EXISTS FOR. Ten statements ran and not one of them could
   * have disagreed, so FATAL 0 is a property of the corpus. Exit 2, not 1: it is
   * the same answer `runCorpus` gives a red lane — this proves nothing either
   * way — and not a claim that the code is wrong.
   */
  it('refuses a corpus in which no statement could have carried a mismatch', () => {
    const verdict = gateVerdict(
      report({ reach: { gradedReadDeclarations: 4, fromOutsideTheExecutor: 0 } }),
    )
    expect(verdict.code).toBe(2)
    expect(verdict.refusal).toContain('COULD HAVE CARRIED A FATAL')
    expect(verdict.refusal).toContain('proves nothing either way')
  })

  /**
   * The other half. Executor-owned read declarations are counted in
   * `gradedReadDeclarations` and deliberately buy the gate nothing — otherwise
   * the executor's own tests would hold it green while no repository could fail
   * it. A single repository read declaration is enough to lift the refusal.
   */
  it('does not refuse once one read declaration came from outside the executor', () => {
    expect(
      gateVerdict(report({ reach: { gradedReadDeclarations: 99, fromOutsideTheExecutor: 1 } })),
    ).toEqual({ code: 0 })
  })

  it('reports a FATAL rather than the reach refusal when the corpus could and did fail', () => {
    expect(gateVerdict(report({ findings: [fatalFinding] })).code).toBe(1)
  })
})

describe('repository audit attachment', () => {
  it('counts repository statements once when seams share a database', async () => {
    const database = openDatabase(':memory:')
    try {
      const first = stageASeam(database)
      const second = stageASeam(database)
      const before = laneIntentAudit().totals.examined
      await first.rootDb.all(sql`SELECT 1`)
      await second.rootDb.all(sql`SELECT 2`)
      expect(laneIntentAudit().totals.examined - before).toBe(2)
    } finally {
      database.close()
    }
  })
})
