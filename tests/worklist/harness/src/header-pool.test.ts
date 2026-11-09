import { headerView } from '@podium/client-graph/header-views'
import { headerRequests } from '@podium/client-graph/header-requests'
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
  const handle = createRuntimeWorklistPool(ctx.engine, { header: true })
  // POD-5798: live readings are the runtime's LiveStore; history is the
  // header's request answer; lifecycle is the instance settings (POD-6677).
  const inputs = () => ({
    metrics: headerView(handle.pool).metrics(),
    quotas: [],
    connection: ctx.engine.live.connection,
    lifecycle: headerView(handle.pool).lifecycle() ?? undefined,
    history: headerRequests(handle.pool)?.history ?? undefined,
    outboxSize: ctx.engine.live.outbox.pending,
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

  it('declares the machine identity and its relations; live readings are not tables (POD-5798)', () => {
    expect(HEADER_SCHEMA.machine.source).toBe('replica:machines')
    // Host samples, quota and the connection are LiveStore conditions.
    for (const live of ['hostMetric', 'quota', 'connection', 'history', 'lifecycle'])
      expect(Object.hasOwn(HEADER_SCHEMA, live), live).toBe(false)
    expect(HEADER_RELATIONS).toContainEqual({
      from: 'session',
      name: 'machine',
      key: 'machineId',
      to: 'machine',
      inverse: 'sessions',
    })
    expect(HEADER_RELATIONS.some((relation) => relation.from === ('hostMetric' as string))).toBe(false)
  })

  it('the checker detects value and extra-row faults', async () => {
    const f = await fixture()
    try {
      f.parity()
      const connection = f.inputs().connection
      expect(
        runInAction(() =>
          checkHeader(f.pool, referenceState(f.ctx.engine), {
            ...f.inputs(),
            connection: { ...connection, pingMs: 999 },
          }),
        ).differences,
      ).toBeGreaterThan(0)
      expect(
        runInAction(() =>
          checkHeader(f.pool, referenceState(f.ctx.engine), {
            ...f.inputs(),
            metrics: [...f.inputs().metrics, metric('extra' as MachineId, 'fixed')],
          }),
        ).first?.section,
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
