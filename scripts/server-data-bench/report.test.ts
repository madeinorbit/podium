import { describe, expect, it } from 'vitest'
import { FRAME_MIX, frameKindAt, framesDue, RUNNING_WRITE_SHARE, sessionWriteTarget } from './drive'
import {
  deltaPct, diffTotals, interleavedOrder, type LoopMinuteRecord, median, minuteMetrics, minuteSpans,
  minutesInside, nextMinuteBoundary, sideBySide, statementKind, statementsByKind, windowRates,
} from './report'
import { bucketOf, parentsFirst } from './seed'

const minute = (ts: string, extra: Partial<LoopMinuteRecord> = {}): LoopMinuteRecord => ({
  at: ts.slice(0, 17) + '00.000Z', ts, blockedPct: 10, stalls: 6, rssBytes: 1, heapUsedBytes: 1, utilizationPct: 50, ...extra,
})

describe('server data bench report', () => {
  it('keeps only loop minutes whose whole span lies inside the window, by write time', () => {
    const start = Date.parse('2026-10-15T10:00:00.000Z')
    const end = start + 3 * 60_000
    const records = [
      minute('2026-10-15T10:00:40.000Z'), // began before the window
      minute('2026-10-15T10:01:41.000Z'),
      minute('2026-10-15T10:02:42.000Z'),
      minute('2026-10-15T10:03:43.000Z'), // ended after the window
      { ...minute('2026-10-15T10:02:00.000Z'), ts: undefined }, // file-only record: no write time
    ]
    expect(minutesInside(records, start, end).map((r) => r.ts)).toEqual(['2026-10-15T10:01:41.000Z', '2026-10-15T10:02:42.000Z'])
  })

  it('scales counts to 60 s of wall time by each minute span and keeps shares as they are', () => {
    const all = [minute('2026-10-15T10:00:00.000Z'), minute('2026-10-15T10:02:00.000Z', { stalls: 30, blockedPct: 40, utilizationPct: 70 })]
    const inside = all.slice(1)
    const spans = minuteSpans(inside, all)
    expect(spans).toEqual([120_000])
    const metrics = minuteMetrics(inside, spans)
    expect(metrics.stallsPerMin).toBe(15)
    expect(metrics.blockedPct).toBe(40)
    expect(metrics.utilizationPct).toBe(70)
    expect(metrics.minuteSpanS).toBe(120)
  })

  it('takes window rates from the totals diff, so they cover exactly the window', () => {
    const start = { 'select 1': { count: 10, wallMs: 5, rows: 10 } }
    const end = { 'select 1': { count: 70, wallMs: 35, rows: 70 }, 'insert into t': { count: 30, wallMs: 30, rows: 0 }, idle: { count: 0, wallMs: 0 } }
    const queries = diffTotals(start, end)
    expect(queries).toEqual({ 'select 1': { count: 60, wallMs: 30, rows: 60 }, 'insert into t': { count: 30, wallMs: 30, rows: 0 } })
    const tasks = diffTotals({}, { 'ws.message.daemon': { count: 45, wallMs: 9 }, 'ws.message.client': { count: 3, wallMs: 1 } })
    const rates = windowRates(queries, tasks, 30_000)
    expect(rates.sqlStatementsPerMin).toBe(180)
    expect(rates.daemonFramesPerMin).toBe(90)
    expect(rates.clientFramesPerMin).toBe(6)
    expect(rates.windowSqlPerDaemonFrame).toBe(2)
  })

  it('names a statement by its verb and first table', () => {
    expect(statementKind('select "id" from "users" where "users"."role" = ?')).toBe('select users')
    expect(statementKind('insert into "changes" ("seq") values (?)')).toBe('insert changes')
    expect(statementKind('update `sessions` set a = 1')).toBe('update sessions')
    expect(statementKind('delete from issues where id = ?')).toBe('delete issues')
    expect(statementKind('select 1')).toBe('select')
    expect(statementsByKind({ 'select a from t': { count: 4, wallMs: 2 }, 'select b from t': { count: 2, wallMs: 2 }, 'select x from u': { count: 3, wallMs: 0 } }, 2))
      .toEqual([{ kind: 'select t', perMin: 3, wallMsPerMin: 2 }, { kind: 'select u', perMin: 1.5, wallMsPerMin: 0 }])
  })

  it('prints both SHAs, the median and spread per arm, the change and what each number counts', () => {
    const rounds = [
      { arm: 'A' as const, round: 1, metrics: { utilizationPct: 50, blockedPct: 10 } },
      { arm: 'B' as const, round: 1, metrics: { utilizationPct: 60, blockedPct: 10 } },
      { arm: 'A' as const, round: 2, metrics: { utilizationPct: 52, blockedPct: 12 } },
      { arm: 'B' as const, round: 2, metrics: { utilizationPct: 58, blockedPct: 12 } },
    ]
    const table = sideBySide(rounds, { A: 'aaaaaaaaaaaa1111', B: 'bbbbbbbbbbbb2222' })
    expect(table).toContain('A aaaaaaaaaa median (min–max)')
    expect(table).toContain('B bbbbbbbbbb median (min–max)')
    expect(table).toContain('| utilizationPct | 51.0 (50.0–52.0) | 59.0 (58.0–60.0) | +15.7% | event-loop utilization')
    expect(table).toContain('| blockedPct | 11.0 (10.0–12.0) | 11.0 (10.0–12.0) | +0.0% |')
    expect(table).not.toContain('| stallsPerMin |')
  })

  it('interleaves the arms and starts on a whole minute', () => {
    expect(interleavedOrder(3).map((s) => `${s.arm}${s.round}`)).toEqual(['A1', 'B1', 'A2', 'B2', 'A3', 'B3'])
    expect(nextMinuteBoundary(Date.parse('2026-10-15T10:00:50.000Z'), 20_000)).toBe(Date.parse('2026-10-15T10:02:00.000Z'))
    expect(median([3, 1, 2])).toBe(2)
    expect(median([4, 1, 2, 3])).toBe(2.5)
    expect(deltaPct(0, 5)).toBeNaN()
  })
})

describe('server data bench load and seed', () => {
  it('sends the declared frame mix, evenly over time, at the requested rate', () => {
    const counts: Record<string, number> = {}
    for (let k = 0; k < 10_000; k++) counts[frameKindAt(k)] = (counts[frameKindAt(k)] ?? 0) + 1
    for (const [kind, share] of FRAME_MIX) expect(Math.abs(counts[kind]! / 10_000 - share)).toBeLessThan(0.005)
    expect(framesDue(28_000, 30_000)).toBe(14_000)
    expect(framesDue(28_000, 1)).toBe(0)
  })

  it('sends the running share of session writes to live sessions, or picks uniformly', () => {
    const live = ['l1', 'l2', 'l3']
    const parked = Array.from({ length: 97 }, (_, i) => `p${i}`)
    const all = [...live, ...parked]
    const hits = (targeting: 'running' | 'uniform') => {
      let toLive = 0
      for (let k = 0; k < 10_000; k++) if (live.includes(sessionWriteTarget(k, targeting, all, live, parked))) toLive++
      return toLive / 10_000
    }
    expect(Math.abs(hits('running') - RUNNING_WRITE_SHARE)).toBeLessThan(0.005)
    expect(Math.abs(hits('uniform') - 0.03)).toBeLessThan(0.01)
    expect(sessionWriteTarget(5, 'running', all, live, parked)).toBe(sessionWriteTarget(5, 'running', all, live, parked))
    // With no parked sessions there is nothing to split: fall back to the whole table.
    expect(live).toContain(sessionWriteTarget(7, 'running', live, live, []))
  })

  it('seeds every parent before its children and buckets ids stably', () => {
    const issues = [
      { id: 'c', seq: 1, parentId: 'p' },
      { id: 'p', seq: 2, parentId: 'g' },
      { id: 'g', seq: 3, parentId: null },
      { id: 'orphan', seq: 4, parentId: 'missing' },
      { id: 'loop-a', seq: 5, parentId: 'loop-b' },
      { id: 'loop-b', seq: 6, parentId: 'loop-a' },
    ]
    expect(parentsFirst(issues).map((i) => i.id)).toEqual(['g', 'p', 'c', 'orphan', 'loop-b', 'loop-a'])
    expect(bucketOf('s42', 6)).toBe(bucketOf('s42', 6))
    expect(bucketOf('s42', 6)).toBeLessThan(6)
  })
})
