// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { autorun, runInAction } from 'mobx'
import { headerStats } from '@podium/client-core/perf'
import { createRuntimeWorklistPool } from '@podium/client-graph/runtime-pool'
import { checkHeader, legacyHeaderSnapshot, poolHeaderSnapshot } from '@podium/client-graph/diagnostics/header-check'
import { startHeaderCheck } from '@podium/client-graph/diagnostics/header-runtime-check'
import { HEADER_RELATIONS, HEADER_SCHEMA } from '@podium/client-graph/header-schema'
import type { HostMetricsWire, MachineId } from '@podium/model/browser'
import {
  startScenarioEngine, writeArchiveIssue, writeBurst50, writeClockTick, writeEvictIssue,
  writeHeartbeat, writeNewIssue, writeParentReassignment, writePhaseChange,
  writeRescopeBack, writeRescopeGrow, writeSelectionClick, writeStageMove, writeTitleRename,
} from '../../shared/src/scenarios'

afterEach(() => { vi.useRealTimers(); headerStats.disable(); headerStats.reset() })
async function fixture(scale: 1 | 4 = 1) {
  const ctx = await startScenarioEngine(scale)
  const health = { status: 'ok', rttMs: 12, since: 0 }
  Object.assign(ctx.engine.hub, { connectionHealth: () => health, onConnectionHealth: () => () => {} })
  const handle = createRuntimeWorklistPool(ctx.engine, { header: true })
  const inputs = () => ({ metrics: ctx.engine.hostMetrics.getSnapshot(), quotas: [], connection: health as never, afterDays: 14 })
  const settle = () => {
    for (let turn = 0; turn < 64; turn++) {
      runInAction(() => poolHeaderSnapshot(handle.pool, inputs()))
      if (handle.pool.hydrate() === 0) return
    }
    throw new Error('Header loads did not settle')
  }
  const parity = (label = 'corpus') => {
    settle()
    const value = runInAction(() => checkHeader(handle.pool, ctx.engine.getSnapshot(), inputs()))
    if (value.first) {
      const expected = legacyHeaderSnapshot(ctx.engine.getSnapshot(), inputs(), handle.pool.clock.current)
      const actual = runInAction(() => poolHeaderSnapshot(handle.pool, inputs()))
      expect(actual.sections[value.first.sectionIndex], label).toEqual(expected.sections[value.first.sectionIndex])
    }
    expect(value.first, label).toBeNull()
    expect(value.differences).toBe(0)
    expect(value.pending).toBe(0)
  }
  return { ctx, ...handle, inputs, parity }
}
function metric(machineId: MachineId, sampledAt: string, availableBytes = 60): HostMetricsWire {
  return { machineId, hostname: 'synthetic', sampledAt,
    memory: { totalBytes: 100, availableBytes, swapTotalBytes: 0, swapFreeBytes: 0 } }
}

describe('header pool values', () => {
  it.each([1, 4] as const)('matches corpus values and addressed changes at %ix', async (scale) => {
    const f = await fixture(scale)
    const stop = autorun(() => poolHeaderSnapshot(f.pool, f.inputs()))
    try {
      f.parity()
      for (const write of [writeHeartbeat, writePhaseChange, writeSelectionClick, writeTitleRename,
        writeStageMove, writeNewIssue, writeArchiveIssue, writeEvictIssue, writeParentReassignment,
        writeClockTick, writeBurst50, writeRescopeGrow, writeRescopeBack]) {
        await write(f.ctx)
        await Promise.resolve()
        f.parity(write.name)
      }
    } finally { stop(); f.dispose(); f.ctx.engine.destroy() }
  }, 180_000)

  it('declares separate machine, sample and quota identities and both relation directions', () => {
    expect(HEADER_SCHEMA.machine.source).toBe('engine:machines')
    expect(HEADER_SCHEMA.hostMetric.source).toBe('runtime:hostMetrics')
    expect(HEADER_SCHEMA.quota.source).toBe('api:quota.summary')
    expect(HEADER_RELATIONS).toContainEqual({ from: 'session', name: 'machine', key: 'machineId', to: 'machine', inverse: 'sessions' })
    expect(HEADER_RELATIONS).toContainEqual({ from: 'hostMetric', name: 'machine', key: 'machineId', to: 'machine', inverse: 'metrics' })
  })

  it('sixty metric-only inputs wake only the changed metric row', async () => {
    const f = await fixture()
    const first = f.ctx.engine.getSnapshot().machines[0]?.id ?? 'machine-one' as MachineId
    const second = 'machine-two' as MachineId
    const publish = (step: number) => f.ctx.hub.emit('hostMetrics', [metric(first, String(step), step), metric(second, 'fixed')])
    publish(0)
    let a = 0, b = 0, status = 0
    const stops = [autorun(() => { f.pool.row('hostMetric', first); a++ }),
      autorun(() => { f.pool.row('hostMetric', second); b++ }),
      autorun(() => { f.pool.headerViews.working(); f.pool.headerViews.aggregate(first); f.pool.headerViews.occupancyKey(); f.pool.headerViews.shipping(); f.pool.headerViews.folded(); f.pool.headerViews.reclaimCounts(14); status++ })]
    headerStats.enable(); headerStats.reset()
    const initial = { a, b, status }
    try {
      for (let step = 1; step <= 60; step++) {
        publish(step)
        await Promise.resolve()
      }
      expect(a - initial.a).toBe(60)
      expect(b - initial.b).toBe(0)
      expect(status - initial.status).toBe(0)
      expect(headerStats.read()).toEqual({})
      // A membership delta still removes the metric and its inverse edge.
      f.ctx.hub.emit('hostMetrics', [metric(second, 'fixed')])
      expect(f.pool.row('hostMetric', first)).toBeUndefined()
      expect(f.pool.header.members('machine', first, 'metrics')).toEqual([])
    } finally { for (const stop of stops) stop(); f.dispose(); f.ctx.engine.destroy() }
  }, 120_000)

  it('the checker detects value, order and extra-row faults', async () => {
    const f = await fixture()
    try {
      f.parity()
      const actual = f.pool.headerViews.row('connection', 'server')!
      f.pool.header.apply([{ kind: 'connection', id: 'server', value: { ...actual, rttMs: 999 } }])
      expect(runInAction(() => checkHeader(f.pool, f.ctx.engine.getSnapshot(), f.inputs())).differences).toBeGreaterThan(0)
      f.pool.header.apply([{ kind: 'connection', id: 'server', value: f.inputs().connection }])
      f.pool.header.apply([{ kind: 'hostMetric', id: 'extra', value: metric('extra' as MachineId, 'fixed') }])
      expect(runInAction(() => checkHeader(f.pool, f.ctx.engine.getSnapshot(), f.inputs())).first?.section).toBe('metrics')
    } finally { f.dispose(); f.ctx.engine.destroy() }
  }, 120_000)

  it('diagnostic runs on its timer and teardown prevents later comparisons', async () => {
    const f = await fixture()
    f.parity()
    vi.useFakeTimers()
    const report = vi.fn()
    const stop = startHeaderCheck(f.ctx.engine, f.pool, report, 1000)
    try {
      expect(report).toHaveBeenCalledTimes(1)
      vi.advanceTimersByTime(1000)
      expect(report.mock.lastCall?.[0].state).toBe('match')
      stop(); stop()
      const calls = report.mock.calls.length
      vi.advanceTimersByTime(10_000)
      expect(report).toHaveBeenCalledTimes(calls)
      expect(report.mock.lastCall?.[0].state).toBe('off')
    } finally { stop(); f.dispose(); f.ctx.engine.destroy() }
  }, 120_000)
})
