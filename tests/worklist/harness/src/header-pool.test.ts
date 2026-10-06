import { headerEntities } from '@podium/client-graph/header-entities'
import { headerView } from '@podium/client-graph/header-views'
import { referenceState } from '../../diagnostics/reference-state'
// @vitest-environment happy-dom

import { headerStats } from './perf/header'
import {
  checkHeader,
  legacyHeaderSnapshot,
  poolHeaderSnapshot,
} from '../../diagnostics/header-check'
import { startHeaderCheck } from '../../diagnostics/header-runtime-check'
import { HEADER_RELATIONS, HEADER_SCHEMA } from '@podium/client-graph/header-schema'
import { createRuntimeWorklistPool } from '@podium/client-graph/runtime-pool'
import { asIssueId, type HostMetricsWire, type MachineId } from '@podium/model/browser'
import { autorun, runInAction } from 'mobx'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  evict,
  startScenarioEngine,
  upsert,
  writeArchiveIssue,
  writeBurst50,
  writeClockTick,
  writeEvictIssue,
  writeHeartbeat,
  writeNewIssue,
  writeParentReassignment,
  writePhaseChange,
  writeRescopeBack,
  writeRescopeGrow,
  writeSelectionClick,
  writeStageMove,
  writeTitleRename,
} from '../../shared/src/scenarios'

afterEach(() => {
  vi.useRealTimers()
  headerStats.disable()
  headerStats.reset()
})
async function fixture(scale: 1 | 4 = 1) {
  const ctx = await startScenarioEngine(scale)
  const health = { status: 'ok', rttMs: 12, since: 0 }
  Object.assign(ctx.engine.hub, {
    connectionHealth: () => health,
    onConnectionHealth: () => () => {},
  })
  ctx.hub.emit(
    'hostMetrics',
    ctx.corpus.machines.slice(0, 2).map((host) => metric(host.id, 'fixed')),
  )
  const handle = createRuntimeWorklistPool(ctx.engine, { header: true })
  const inputs = () => ({
    metrics: ctx.engine.hostMetrics.getSnapshot(),
    quotas: [],
    connection: health as never,
    lifecycle: headerEntities(handle.pool).received.lifecycle,
    history: headerEntities(handle.pool).received.history,
  })
  const settle = () => {
    for (let turn = 0; turn < 64; turn++) {
      runInAction(() => poolHeaderSnapshot(handle.pool))
      if (handle.pool.hydrate() === 0) return
    }
    throw new Error('Header loads did not settle')
  }
  const parity = (label = 'corpus') => {
    settle()
    const value = runInAction(() => checkHeader(handle.pool, referenceState(ctx.engine), inputs()))
    if (value.first) {
      const expected = legacyHeaderSnapshot(
        referenceState(ctx.engine),
        inputs(),
        handle.pool.clock.current,
      )
      const actual = runInAction(() => poolHeaderSnapshot(handle.pool))
      expect(actual.sections[value.first.sectionIndex], label).toEqual(
        expected.sections[value.first.sectionIndex],
      )
    }
    expect(value.first, label).toBeNull()
    expect(value.differences).toBe(0)
    expect(value.pending).toBe(0)
  }
  return { ctx, ...handle, inputs, parity }
}
function metric(machineId: MachineId, sampledAt: string, availableBytes = 60): HostMetricsWire {
  return {
    machineId,
    hostname: 'synthetic',
    sampledAt,
    memory: { totalBytes: 100, availableBytes, swapTotalBytes: 0, swapFreeBytes: 0 },
  }
}

describe('header pool values', () => {
  it('hides a normalized unstarted draft vessel with no old issue rows', async () => {
    const f = await fixture()
    try {
      f.ctx.replica.batch(() => {
        for (const issue of f.ctx.corpus.issues) evict(f.ctx, 'issueProjection', issue.id)
      })
      const id = asIssueId('iss_header_normalized_draft')
      upsert(f.ctx, 'issueProjection', id, {
        ...f.ctx.corpus.issueProjections[0],
        id,
        seq: 999999,
        parentId: undefined,
        stage: 'backlog',
        closedAt: undefined,
        closedReason: undefined,
        archived: false,
        deletedAt: undefined,
        isDraftVessel: true,
        worktreePath: undefined,
      })
      referenceState(f.ctx.engine).setSelectedIssueId(id)
      await Promise.resolve()
      f.parity('normalized draft')
      expect(headerView(f.pool).folded()).toMatchObject({
        root: undefined,
        live: 0,
        loading: false,
      })
    } finally {
      f.dispose()
      f.ctx.dispose()
    }
  }, 120_000)

  it.each([1, 4] as const)('matches corpus values and addressed changes at %ix', async (scale) => {
    const f = await fixture(scale)
    const stop = autorun(() => poolHeaderSnapshot(f.pool))
    try {
      f.parity()
      for (const write of [
        writeHeartbeat,
        writePhaseChange,
        writeSelectionClick,
        writeTitleRename,
        writeStageMove,
        writeNewIssue,
        writeArchiveIssue,
        writeEvictIssue,
        writeParentReassignment,
        writeClockTick,
        writeBurst50,
        writeRescopeGrow,
        writeRescopeBack,
      ]) {
        await write(f.ctx)
        await Promise.resolve()
        f.parity(write.name)
      }
    } finally {
      stop()
      f.dispose()
      f.ctx.dispose()
    }
  }, 180_000)

  it('declares separate machine, sample and quota identities and both relation directions', () => {
    expect(HEADER_SCHEMA.machine.source).toBe('engine:machines')
    expect(HEADER_SCHEMA.hostMetric.source).toBe('runtime:hostMetrics')
    expect(HEADER_SCHEMA.quota.source).toBe('runtime:headerInputs.quota')
    expect(HEADER_RELATIONS).toContainEqual({
      from: 'session',
      name: 'machine',
      key: 'machineId',
      to: 'machine',
      inverse: 'sessions',
    })
    expect(HEADER_RELATIONS).toContainEqual({
      from: 'hostMetric',
      name: 'machine',
      key: 'machineId',
      to: 'machine',
      inverse: 'metrics',
    })
  })

  it('sixty metric-only inputs wake only the changed metric row', async () => {
    const f = await fixture()
    const first = referenceState(f.ctx.engine).machines[0]?.id ?? ('machine-one' as MachineId)
    const second = 'machine-two' as MachineId
    const publish = (step: number) =>
      f.ctx.hub.emit('hostMetrics', [metric(first, String(step), step), metric(second, 'fixed')])
    publish(0)
    let a = 0,
      b = 0,
      status = 0
    const stops = [
      autorun(() => {
        f.pool.row('hostMetric', first)
        a++
      }),
      autorun(() => {
        f.pool.row('hostMetric', second)
        b++
      }),
      autorun(() => {
        headerView(f.pool).working()
        headerView(f.pool).aggregate(first)
        headerView(f.pool).occupancyKey()
        headerView(f.pool).shipping()
        headerView(f.pool).folded()
        status++
      }),
    ]
    headerStats.enable()
    headerStats.reset()
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
      expect(headerEntities(f.pool).members('machine', first, 'metrics')).toEqual([])
    } finally {
      for (const stop of stops) stop()
      f.dispose()
      f.ctx.dispose()
    }
  }, 120_000)

  it('the checker detects value, order and extra-row faults', async () => {
    const f = await fixture()
    try {
      f.parity()
      const actual = headerView(f.pool).row('connection', 'server')!
      headerEntities(f.pool).apply([{ kind: 'connection', id: 'server', value: { ...actual, rttMs: 999 } }])
      expect(
        runInAction(() => checkHeader(f.pool, referenceState(f.ctx.engine), f.inputs())).differences,
      ).toBeGreaterThan(0)
      headerEntities(f.pool).apply([{ kind: 'connection', id: 'server', value: f.inputs().connection }])
      const ids = f.inputs().metrics.map((row) => row.machineId ?? row.hostname)
      runInAction(() => headerEntities(f.pool).order('hostMetric', [...ids].reverse()))
      expect(
        runInAction(() => checkHeader(f.pool, referenceState(f.ctx.engine), f.inputs())).first
          ?.section,
      ).toBe('metrics')
      runInAction(() => headerEntities(f.pool).order('hostMetric', ids))
      headerEntities(f.pool).apply([
        { kind: 'hostMetric', id: 'extra', value: metric('extra' as MachineId, 'fixed') },
      ])
      expect(
        runInAction(() => checkHeader(f.pool, referenceState(f.ctx.engine), f.inputs())).first
          ?.section,
      ).toBe('metrics')
    } finally {
      f.dispose()
      f.ctx.dispose()
    }
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
      stop()
      stop()
      const calls = report.mock.calls.length
      vi.advanceTimersByTime(10_000)
      expect(report).toHaveBeenCalledTimes(calls)
      expect(report.mock.lastCall?.[0].state).toBe('off')
    } finally {
      stop()
      f.dispose()
      f.ctx.dispose()
    }
  }, 120_000)
})
