import { describe, expect, it } from 'vitest'
import {
  PlainRoundTripBaseline,
  WorkspaceWriteMetrics,
  type WorkspaceWriteObservation,
  WorkspaceWriteTiming,
} from './workspace-write-metrics'

const sample = (workspaceId: string, holdMs = 5): WorkspaceWriteObservation => ({
  workspaceId,
  outcome: 'committed',
  waitMs: 2,
  schedulerQueueMs: 0,
  holdMs,
  acquisitionMs: 3,
  roundTrips: 4,
  statements: 2,
  driverMs: 4,
  statementMs: 2,
})

describe('workspace write metrics', () => {
  it('bounds workspace cardinality by recent writes and keeps workspaces separate', () => {
    let now = 0
    const metrics = new WorkspaceWriteMetrics(2, () => now)
    metrics.record(sample('a', 3))
    metrics.record(sample('b', 7))
    now = 1_000
    metrics.record(sample('a', 9))
    metrics.record(sample('c', 11))
    const snapshot = metrics.snapshot()
    expect(Object.keys(snapshot.byWorkspace)).toEqual(['a', 'c'])
    expect(snapshot.evictedWorkspaces).toBe(1)
    expect(snapshot.byWorkspace.a?.holdMs).toMatchObject({ count: 2, p50: 3, p95: 9, total: 12 })
    expect(snapshot.byWorkspace.c?.holdMs.p50).toBe(11)
    expect(() => new WorkspaceWriteMetrics(0)).toThrow('capacity must be positive')
  })

  it('reports throughput in complete seconds, including idle time, without a timer', () => {
    let now = 0
    const metrics = new WorkspaceWriteMetrics(2, () => now)
    metrics.record(sample('a'))
    metrics.record(sample('a'))
    now = 1_000
    metrics.record(sample('a'))
    now = 4_000
    const stats = metrics.snapshot().byWorkspace.a!
    expect(stats.writesPerSecond).toBe(0.75)
    expect(stats.writesPerSecondHistogram).toMatchObject({ count: 4, p50: 0, p95: 2, total: 3 })
    now = 70_000
    expect(metrics.snapshot().byWorkspace.a?.writesPerSecondHistogram).toMatchObject({
      count: 60,
      max: 0,
    })
  })

  it('retains bounded recent quantiles and lifetime histogram totals', () => {
    const metrics = new WorkspaceWriteMetrics()
    for (let i = 0; i < 2_000; i++) metrics.record(sample('a', i < 1_488 ? 10_000 : 1))
    const hold = metrics.snapshot().byWorkspace.a!.holdMs
    expect(hold).toMatchObject({ count: 2_000, p99: 1, max: 10_000 })
    expect(hold.buckets.reduce((a, b) => a + b, 0)).toBe(2_000)
  })

  it('isolates subscribers and distinguishes rollback, failed acquisition and no baseline', () => {
    const metrics = new WorkspaceWriteMetrics()
    const seen: string[] = []
    metrics.probe(() => {
      throw new Error('diagnostics failed')
    })
    const stop = metrics.probe((each) => {
      seen.push(each.outcome)
    })
    metrics.record({ ...sample('a'), outcome: 'rolled-back', waitMs: undefined })
    metrics.record({ ...sample('a'), outcome: 'acquisition-failed' })
    stop()
    metrics.record(sample('a'))
    expect(seen).toEqual(['rolled-back', 'acquisition-failed'])
    expect(metrics.snapshot().byWorkspace.a).toMatchObject({
      committed: 1,
      rolledBack: 1,
      acquisitionFailures: 1,
      uncalibratedWaits: 1,
      waitMs: { count: 1 },
      holdMs: { count: 2 },
    })
  })

  it('subtracts an existing plain round trip once and excludes wait from hold', () => {
    let now = 0
    const baseline = new PlainRoundTripBaseline()
    const metrics = new WorkspaceWriteMetrics(2, () => now)
    const timing = new WorkspaceWriteTiming(baseline, metrics, () => now)
    const seen: WorkspaceWriteObservation[] = []
    metrics.probe((each) => {
      seen.push(each)
    })
    timing.pipeline(2.6, 1, 1, true, false)
    timing.begin('a')
    now = 22.6
    timing.acquired()
    timing.pipeline(22.6, 3, 0, true, true)
    now = 40
    timing.pipeline(4, 1, 1, true, false)
    now = 50
    timing.pipeline(3, 1, 0, true, false)
    timing.end('committed')
    timing.end('committed') // A lease close cannot count the commit twice.
    expect(seen).toHaveLength(1)
    expect(seen[0]).toMatchObject({
      workspaceId: 'a',
      waitMs: 20,
      holdMs: 30,
      roundTrips: 3,
      statements: 1,
      driverMs: 9.600000000000001,
      statementMs: 4,
    })
    expect(metrics.snapshot().byWorkspace.a?.committed).toBe(1)
  })
})
