// @vitest-environment happy-dom
import { createRuntimeWorklistPool } from '@podium/client-graph/runtime-pool'
import { localsOfEngine } from '@podium/client-graph/shared/engine-locals'
import * as rowSource from '@podium/client-graph/shared/row-source'
import * as engineLocals from '@podium/client-graph/shared/engine-locals'
import { LOADING } from '@podium/client-graph'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  startScenarioEngine,
  writeClockTick,
  writeRescopeBack,
  writeRescopeGrow,
  writeSelectionClick,
  writeTitleRename,
} from '../../shared/src/scenarios'
import { snapshotPool, tracked } from './adapters/mobx-pool'
import { snapshotFromStore } from './oracle'
import { installMobxWarnTrap } from './mobx-trap'

installMobxWarnTrap()
afterEach(() => vi.restoreAllMocks())

describe('the pool over the app-owned runtime', () => {
  it.each([1, 4] as const)('matches the round-three legacy oracle at %ix, including runtime writes and locals', async (scale) => {
    const ctx = await startScenarioEngine(scale)
    const handle = createRuntimeWorklistPool(ctx.engine)
    try {
      const parity = () => expect(snapshotPool(handle.pool)).toEqual(
        snapshotFromStore(ctx.engine.getSnapshot(), localsOfEngine(ctx.engine)),
      )
      parity()
      await writeTitleRename(ctx)
      parity()
      await writeClockTick(ctx)
      expect(handle.pool.clock.current).toBe(ctx.engine.getSnapshot().coarseNow)
      parity()
      const selected = await writeSelectionClick(ctx)
      await Promise.resolve()
      expect(tracked(() => handle.pool.selection.has(selected))).toBe(true)
      parity()
    } finally {
      handle.dispose()
      ctx.engine.destroy()
    }
  }, 120_000)

  it.each([1, 4] as const)('follows rescope growth and shrink through the existing feed at %ix', async (scale) => {
    const ctx = await startScenarioEngine(scale)
    const handle = createRuntimeWorklistPool(ctx.engine)
    try {
      const before = snapshotPool(handle.pool)
      await writeRescopeGrow(ctx)
      const grown = snapshotPool(handle.pool)
      expect(Object.keys(grown.rowsById)).toHaveLength(Object.keys(before.rowsById).length + 10)
      expect(grown).toEqual(snapshotFromStore(ctx.engine.getSnapshot(), localsOfEngine(ctx.engine)))
      await writeRescopeBack(ctx)
      expect(snapshotPool(handle.pool)).toEqual(before)
    } finally {
      handle.dispose()
      ctx.engine.destroy()
    }
  }, 120_000)

  it('builds from the persisted offline slice before start and follows hydration without a replacement pool', async () => {
    const ctx = await startScenarioEngine(1, {
      start: false,
      network: { isOnline: () => false, onlineEvents: { add: () => {}, remove: () => {} } },
    })
    const input = vi.spyOn(rowSource, 'createRowSource')
    const handle = createRuntimeWorklistPool(ctx.engine)
    const pool = handle.pool
    try {
      const id = ctx.targets.visibleRootId
      snapshotPool(pool)
      // POD-4953 (7ccf96945) introduced the temporary normalized join. The
      // pool borrows that exact input, with no second copy on repeated reads.
      // POD-4968 retires the join and must restore plain replica-row identity.
      const joined = input.mock.results[0]!.value.source.row!('issue', id)
      expect(tracked(() => pool.row('issue', id))).toBe(joined)
      expect(tracked(() => pool.row('issue', id))).toBe(joined)
      expect(snapshotPool(pool)).toEqual(snapshotFromStore(ctx.engine.getSnapshot(), localsOfEngine(ctx.engine)))
      ctx.engine.start()
      ctx.replica.onKernelEvent({
        type: 'bootstrap-installed', cause: 'cold-start', snapshotSeq: 1,
        entityCount: ctx.cache.records.length, bufferedFramesApplied: 0,
      } as never)
      await new Promise((resolve) => setTimeout(resolve, ctx.settleMs))
      expect(handle.pool).toBe(pool)
      expect(snapshotPool(pool)).toEqual(snapshotFromStore(ctx.engine.getSnapshot(), localsOfEngine(ctx.engine)))
    } finally {
      handle.dispose()
      ctx.engine.destroy()
    }
  }, 120_000)

  it('a known row absent from memory answers LOADING and loads through a nonblocking batch', async () => {
    const ctx = await startScenarioEngine(1)
    const read = vi.spyOn(ctx.replica, 'row')
    const handle = createRuntimeWorklistPool(ctx.engine)
    try {
      read.mockClear()
      const id = ctx.targets.heartbeatSessionId
      expect(tracked(() => handle.pool.tables.session.has(id))).toBe(false)
      expect(tracked(() => handle.pool.row('session', id))).toBe(LOADING)
      expect(handle.pool.hydrate()).toBeGreaterThan(0)
      expect(read).toHaveBeenCalledWith('sessions', id)
      expect(tracked(() => handle.pool.row('session', id))).toBe(ctx.replica.row!('sessions', id))
    } finally {
      handle.dispose()
      ctx.engine.destroy()
    }
  }, 60_000)

  it('disposes the pool and both runtime feed subscriptions once, before later publications', async () => {
    const ctx = await startScenarioEngine(1)
    const rows = vi.spyOn(rowSource, 'createRowSource')
    const locals = vi.spyOn(engineLocals, 'createEngineLocals')
    const handle = createRuntimeWorklistPool(ctx.engine)
    const rowHandle = rows.mock.results[0]!.value as rowSource.RowSourceHandle
    const localsHandle = locals.mock.results[0]!.value as ReturnType<typeof engineLocals.createEngineLocals>
    const offRows = vi.spyOn(rowHandle, 'dispose')
    const offLocals = vi.spyOn(localsHandle, 'dispose')
    const offPool = vi.spyOn(handle.pool, 'dispose')
    try {
      expect(rows).toHaveBeenCalledWith(ctx.engine, ctx.engine.replica, { mode: 'overlaid' })
      expect(locals).toHaveBeenCalledWith(ctx.engine)
      handle.dispose()
      handle.dispose()
      expect(offPool).toHaveBeenCalledTimes(1)
      expect(offRows).toHaveBeenCalledTimes(1)
      expect(offLocals).toHaveBeenCalledTimes(1)
      expect(() => rowHandle.source.row!('issue', ctx.targets.visibleRootId)).toThrow('disposed source')
      const apply = vi.spyOn(handle.pool, 'apply')
      await writeTitleRename(ctx)
      expect(apply).not.toHaveBeenCalled()
    } finally {
      handle.dispose()
      ctx.engine.destroy()
    }
  }, 60_000)
})
