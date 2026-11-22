import { ContextSummary } from '@podium/model'
import { autorun, observable, runInAction } from 'mobx'
import { describe, expect, it, vi } from 'vitest'
import { LOADING } from './loading'
import { isGone, requireHere } from './lookup'
import {
  contextInventory,
  contextSample,
  contextQuantity as q,
  sessionContextFixture,
} from './session-context.test.fixture'
import type { CollectionLoaderPort } from './shared/source'

describe('shared context measurements', () => {
  it('keeps the original live object and its observed model across a requested model change', () => {
    const f = sessionContextFixture()
    const stop = autorun(() => void f.model.context)
    try {
      const stored = f.pool.row('session', 's1')
      f.publish(contextSample)
      expect(f.model.context).toBe(contextSample)
      expect(f.model.contextObservedModel).toBe(contextSample.model)
      expect(f.model.contextOccupancy).toBe(contextSample.occupancy)
      expect(f.model.contextCapacity).toBe(contextSample.effectiveCapacity)
      expect(f.model.contextCapacityBasis).toBe('configured')
      expect(f.model.context?.status === 'available' && f.model.context.modelCapacity?.value).toBe(
        1000,
      )
      expect(
        f.model.context?.status === 'available' &&
          f.model.context.compaction?.thresholdTokens?.value,
      ).toBe(160)
      expect(f.model.contextPercent).toBe(10)
      expect(f.model.contextRemainingTokens).toBe(180)
      expect(f.pool.row('session', 's1')).toBe(stored)
      expect(Object.hasOwn(stored as object, 'context')).toBe(false)
      expect(Object.hasOwn(stored as object, 'contextCapability')).toBe(false)
      f.updateSession({ requestedModel: 'next-requested-model' })
      expect(f.model.context).toBe(contextSample)
      expect(f.model.context?.status === 'available' && f.model.context.sample).toBe(
        contextSample.sample,
      )
      expect(f.model.contextObservedModel?.modelId).toBe('observed-model')
    } finally {
      stop()
      f.pool.dispose()
    }
  })

  it.each([
    {
      name: 'measured zero',
      occupancy: { basis: 'current-context', usedTokens: q(0), percent: q(0) },
      percent: 0,
      ratio: 0,
    },
    {
      name: 'count only, unknown limit',
      occupancy: { basis: 'last-request', usedTokens: { ...q(647), accuracy: 'estimated' } },
      percent: undefined,
      ratio: undefined,
    },
    {
      name: 'rounded percentage only',
      occupancy: { basis: 'current-context', percent: q(13) },
      percent: 13,
      ratio: 0.13,
    },
    {
      name: 'remaining only',
      occupancy: { basis: 'current-context', remainingTokens: q(0) },
      percent: undefined,
      ratio: undefined,
      remaining: 0,
    },
    {
      name: 'over capacity',
      occupancy: {
        basis: 'current-context',
        usedTokens: q(250),
        percent: q(125),
        remainingTokens: q(0),
      },
      percent: 125,
      ratio: 1,
      remaining: 0,
    },
  ] as const)('$name stays useful without fabricated values', ({
    occupancy,
    percent,
    ratio,
    ...expected
  }) => {
    const f = sessionContextFixture()
    try {
      const sample = ContextSummary.parse({
        ...contextSample,
        occupancy,
        effectiveCapacity: undefined,
      })
      f.publish(sample)
      expect(f.model.contextState).toBe('available')
      expect(f.model.contextOccupancy).toBe(
        sample.status === 'available' ? sample.occupancy : undefined,
      )
      expect(f.model.contextPercent).toBe(percent)
      expect(f.model.contextRatio).toBe(ratio)
      expect(f.model.contextRemainingTokens).toBe(
        'remaining' in expected ? expected.remaining : undefined,
      )
      expect(f.model.contextCapacity).toBeUndefined()
      expect(f.model.contextUsagePercent).toBe(percent === 125 ? undefined : percent)
    } finally {
      f.pool.dispose()
    }
  })

  it('never recomputes percentage or remaining from known token counts and capacity', () => {
    const f = sessionContextFixture()
    try {
      const occupancy = {
        basis: 'native-estimate' as const,
        usedTokens: { ...q(647), accuracy: 'estimated' as const },
      }
      f.publish({ ...contextSample, occupancy })
      expect(f.model.contextCapacity?.value).toBe(200)
      expect(f.model.contextPercent).toBeUndefined()
      expect(f.model.contextRatio).toBeUndefined()
      expect(f.model.contextRemainingTokens).toBeUndefined()
      expect(f.model.contextOccupancy?.usedTokens?.accuracy).toBe('estimated')
      f.publish({
        ...contextSample,
        occupancy: {
          ...occupancy,
          percent: { ...q(13), accuracy: 'estimated' },
          remainingTokens: { ...q(123), accuracy: 'estimated' },
        },
      })
      expect(f.model.contextPercent).toBe(13)
      expect(f.model.contextRemainingTokens).toBe(123)
      expect(f.model.contextOccupancy?.remainingTokens?.source).toBe('synthetic adapter')
    } finally {
      f.pool.dispose()
    }
  })

  it.each([
    'pending',
    'unavailable',
  ] as const)('%s preserves known capacity/policy without occupancy', (status) => {
    const f = sessionContextFixture()
    try {
      f.publish(contextSample)
      f.publish({
        version: 1,
        status,
        revision: contextSample.sample,
        reason: { code: 'boundary', message: 'Waiting after context boundary' },
        effectiveCapacity: contextSample.effectiveCapacity,
        modelCapacity: contextSample.modelCapacity,
        model: contextSample.model,
        compaction: contextSample.compaction,
      })
      expect(f.model.contextState).toBe(status)
      expect(f.model.contextCapacity?.value).toBe(200)
      expect(f.model.contextObservedModel).toBe(contextSample.model)
      expect(f.model.contextOccupancy).toBeUndefined()
      expect(f.model.contextPercent).toBeUndefined()
      expect(f.model.contextRemainingTokens).toBeUndefined()
      expect(f.model.contextDetailLevel).toBe('none')
    } finally {
      f.pool.dispose()
    }
  })

  it.each([
    0, 41,
  ])('preserves legacy percentage %s with limited provenance and no invented sample', (percent) => {
    const f = sessionContextFixture()
    try {
      f.publish(undefined, percent)
      expect(f.model.contextState).toBe('available')
      expect(f.model.contextProvenance).toBe('legacy-percent')
      expect(f.model.contextPercent).toBe(percent)
      expect(f.model.contextUsagePercent).toBe(percent)
      expect(f.model.contextRatio).toBe(percent / 100)
      expect(f.model.context).toBeUndefined()
      expect(f.model.contextOccupancy).toBeUndefined()
      expect(f.model.contextObservedModel).toBeUndefined()
      expect(f.model.contextCapacity).toBeUndefined()
      expect(f.model.contextRemainingTokens).toBeUndefined()
      expect(f.model.contextDetailLevel).toBe('none')
    } finally {
      f.pool.dispose()
    }
  })

  it('prefers every normalized state over legacy data, including explicit clears', () => {
    const f = sessionContextFixture()
    try {
      f.publish(contextSample, 99)
      expect(f.model.contextPercent).toBe(10)
      expect(f.model.contextUsagePercent).toBe(10)
      expect(f.model.contextProvenance).toBe('normalized')
      f.publish(
        {
          version: 1,
          status: 'unsupported',
          reason: { code: 'no-channel', message: 'Unavailable implementation' },
        },
        99,
      )
      expect(f.model.contextState).toBe('unsupported')
      expect(f.model.contextPercent).toBeUndefined()
      expect(f.model.contextUsagePercent).toBeUndefined()
    } finally {
      f.pool.dispose()
    }
  })
})

describe('shared machine context lookup', () => {
  it('distinguishes two generic-pty harnesses on one machine and follows bound-driver changes', () => {
    const f = sessionContextFixture()
    const stop = autorun(() => void f.model.contextSupport)
    try {
      const machine = requireHere(f.pool.model('machine', 'm1'))
      expect(machine.contextCapabilities).toBe(contextInventory.contextCapabilities)
      expect(f.model.contextImplementation).toBe(machine.contextCapabilities?.[0])
      expect(f.model.contextCapability).toBe(machine.contextCapabilities?.[0]?.capability)
      expect(f.model.contextSupport).toBe('supported')
      expect(f.model.contextAvailability?.status).toBe('unavailable')
      expect(f.model.contextState).toBe('unavailable')
      f.publish(contextSample)
      expect(f.model.contextState).toBe('available')
      expect(f.model.contextDetailLevel).toBe('on-demand')
      f.updateSession({ driverId: 'headless' })
      expect(machine.inventory?.runtimeDrivers?.some((driver) => driver.id === 'headless')).toBe(
        false,
      )
      expect(f.model.contextSupport).toBe('supported')
      expect(f.model.contextImplementation).toBe(machine.contextCapabilities?.[2])
      expect(f.model.contextDetailLevel).toBe('none')
      f.updateSession({ agentKind: 'cursor' })
      expect(f.model.contextImplementation).toBe(machine.contextCapabilities?.[1])
      expect(f.model.contextSupport).toBe('unsupported')
      expect(f.model.contextDetailLevel).toBe('none')
    } finally {
      stop()
      f.pool.dispose()
    }
  })

  it.each([
    { ...contextInventory, contextCapabilities: undefined },
    {
      ...contextInventory,
      contextCapabilities: undefined,
      runtimeDrivers: [
        { harness: 'codex' as const, id: 'generic-pty', family: 'terminal' as const },
      ],
    },
    undefined,
  ])('old or unavailable inventory stays unknown', (inventory) => {
    const f = sessionContextFixture()
    try {
      f.updateInventory(inventory)
      expect(f.model.contextSupport).toBe('unknown')
      expect(f.model.contextCapability).toBeUndefined()
      expect(f.model.contextState).toBe('unknown')
      f.live.online('m1', false)
      expect(f.model.contextState).toBe('unavailable')
      expect(f.model.contextReason?.code).toBe('offline')
      f.live.online('m1', true)
      f.publish(contextSample)
      expect(f.model.contextPercent).toBe(10)
      expect(f.model.contextDetailLevel).toBe('none')
    } finally {
      f.pool.dispose()
    }
  })

  it('does not guess a driver from requested settings or a missing inventory row', () => {
    const f = sessionContextFixture()
    try {
      f.updateSession({ driverId: undefined })
      expect(f.model.contextImplementation).toBeUndefined()
      expect(f.model.contextSupport).toBe('unknown')
      f.updateSession({ driverId: 'driver-from-newer-peer' })
      expect(f.model.contextSupport).toBe('unknown')
    } finally {
      f.pool.dispose()
    }
  })

  it('shares one capability value across sessions and follows inventory replacement', () => {
    const f = sessionContextFixture()
    const stop = autorun(() => void f.model.contextCapability)
    try {
      expect(f.pool.sessionObject('s2').contextCapability).toBe(f.model.contextCapability)
      f.updateInventory({
        ...contextInventory,
        contextCapabilities: contextInventory.contextCapabilities?.map((driver) => ({
          ...driver,
          capability: undefined,
          availability: {
            status: 'unsupported',
            reason: {
              code: 'changed-installation',
              message: 'Context support is no longer admitted',
            },
          },
        })),
      })
      expect(f.model.contextSupport).toBe('unsupported')
      expect(f.pool.sessionObject('s2').contextSupport).toBe('unsupported')
      expect(f.model.contextCapability).toBeUndefined()
    } finally {
      stop()
      f.pool.dispose()
    }
  })

  it('preserves loading/gone lookup answers and never reads live data for an absent session', () => {
    const disk = observable.set(['not-loaded', 'machine-not-loaded'])
    const loadFromDisk = vi.fn()
    const loader: CollectionLoaderPort = {
      request: () => {},
      show: () => () => {},
      status: () => 'complete',
      online: true,
      firstDownload: false,
      isComplete: (spec) => (disk.has(String(spec.args?.id)) ? undefined : {}),
      wasRefused: () => false,
      stubOf: () => undefined,
      stubsByParent: () => [],
      stubRows: () => [],
      subscribe: () => () => {},
      unloaded: (_kind: string, id: string) => disk.has(id),
      loadFromDisk,
    }
    const f = sessionContextFixture({ loader: () => loader, schedule: () => () => {} })
    const absent = f.pool.sessionObject('not-loaded')
    const stop = autorun(() => void absent.contextState)
    try {
      expect(absent.contextImplementation).toBe(LOADING)
      expect(absent.contextState).toBe('unknown')
      expect(absent.context).toBeUndefined()
      expect(loadFromDisk).toHaveBeenCalledWith('session', ['not-loaded'])
      runInAction(() => disk.delete('not-loaded'))
      expect(isGone(absent.contextImplementation)).toBe(true)
      expect(absent.contextState).toBe('unavailable')
      f.updateSession({ machineId: 'machine-not-loaded' })
      expect(f.model.contextImplementation).toBe(LOADING)
      runInAction(() => disk.delete('machine-not-loaded'))
      expect(isGone(f.model.contextImplementation)).toBe(true)
      expect(f.model.contextSupport).toBe('unknown')
      expect(f.model.contextState).toBe('unavailable')
      expect(f.live.live.watchedSessions('session.condition')).toEqual([])
    } finally {
      stop()
      f.pool.dispose()
    }
  })

  it('handles a missing machine and drops a dangling reading when its session is removed', () => {
    const f = sessionContextFixture()
    const stop = autorun(() => void f.model.contextState)
    try {
      f.publish(contextSample)
      f.pool.apply({ type: 'update', rows: [{ kind: 'machine', id: 'm1', value: undefined }] })
      expect(f.model.contextState).toBe('unavailable')
      expect(f.model.contextReason?.code).toBe('machine-gone')
      expect(f.model.context).toBe(contextSample)
      f.updateInventory(contextInventory)
      expect(f.model.contextState).toBe('available')
      f.pool.apply({ type: 'update', rows: [{ kind: 'session', id: 's1', value: undefined }] })
      expect(f.model.contextState).toBe('unavailable')
      expect(f.model.contextReason?.code).toBe('session-gone')
      expect(f.model.context).toBeUndefined()
      expect(f.model.contextPercent).toBeUndefined()
      expect(f.live.live.watchedSessions('session.condition')).toEqual([])
    } finally {
      stop()
      f.pool.dispose()
    }
  })
})

describe('context freshness and reader isolation', () => {
  it('marks transport loss and machine offline stale without changing the sample', () => {
    const f = sessionContextFixture()
    const stop = autorun(() => void f.model.contextState)
    try {
      f.publish(contextSample)
      expect(f.model.contextState).toBe('available')
      f.advanceTime()
      f.live.sessionCondition('s2', { busy: true, requestsGated: 0 })
      expect(f.model.contextState).toBe('available')
      f.live.online('m1', false)
      expect(f.model.contextState).toBe('stale')
      expect(f.model.contextReason?.code).toBe('offline')
      expect(f.model.context).toBe(contextSample)
      expect(f.model.contextDetailLevel).toBe('none')
      f.live.online('m1', true)
      expect(f.model.contextState).toBe('available')
      f.live.lost(Date.parse(contextSample.sample.at))
      expect(f.model.contextState).toBe('stale')
      expect(f.model.context).toBe(contextSample)
    } finally {
      stop()
      f.pool.dispose()
    }
  })

  it('preserves adapter stale provenance and consumes a rebind clear as a whole replacement', () => {
    const f = sessionContextFixture()
    try {
      const stale = {
        ...contextSample,
        status: 'stale' as const,
        reason: { code: 'native-disconnected', message: 'Native observer disconnected' },
      }
      f.publish(stale)
      expect(f.model.contextState).toBe('stale')
      expect(f.model.contextReason).toBe(stale.reason)
      const clear = {
        version: 1 as const,
        status: 'unavailable' as const,
        revision: { ...contextSample.sample, bindingVersion: 4, contextRevision: 2 },
        reason: { code: 'binding-changed', message: 'New binding has no attributable sample' },
      }
      f.updateSession({ driverId: 'headless' })
      f.publish(clear)
      expect(f.model.context).toBe(clear)
      expect(f.model.contextState).toBe('unavailable')
      expect(f.model.contextReason?.code).toBe('binding-changed')
      expect(f.model.contextPercent).toBeUndefined()
      expect(f.model.contextRemainingTokens).toBeUndefined()
    } finally {
      f.pool.dispose()
    }
  })

  it('keeps legacy offline readings stale and an exited measurement historical', () => {
    const f = sessionContextFixture()
    const stop = autorun(() => void f.model.contextState)
    try {
      f.publish(undefined, 0)
      f.live.lost(1)
      expect(f.model.contextState).toBe('stale')
      expect(f.model.contextRatio).toBe(0)
      f.publish(contextSample)
      f.updateSession({ status: 'exited' })
      expect(f.model.contextState).toBe('stale')
    } finally {
      stop()
      f.pool.dispose()
    }
  })

  it('isolates another session’s updates and suppresses unrelated readers even for its own update', () => {
    const f = sessionContextFixture()
    const contextReader = vi.fn(() => f.model.contextPercent)
    const titleReader = vi.fn(() => f.model.title)
    const busyReader = vi.fn(() => f.model.busy)
    const capacityReader = vi.fn(() => f.model.contextCapacityBasis)
    const supportReader = vi.fn(() => f.model.contextSupport)
    const stops = [contextReader, titleReader, busyReader, capacityReader, supportReader].map(
      (read) => autorun(read),
    )
    try {
      f.publish(contextSample)
      const before = f.pool.row('session', 's1')
      for (const read of [contextReader, titleReader, busyReader, capacityReader, supportReader])
        read.mockClear()
      f.publish(
        { ...contextSample, occupancy: { basis: 'current-context', percent: q(90) } },
        undefined,
        's2',
      )
      for (const read of [contextReader, titleReader, busyReader, capacityReader, supportReader])
        expect(read).not.toHaveBeenCalled()
      f.publish({ ...contextSample, occupancy: { ...contextSample.occupancy, percent: q(20) } })
      expect(contextReader).toHaveBeenCalledTimes(1)
      for (const read of [titleReader, busyReader, capacityReader, supportReader])
        expect(read).not.toHaveBeenCalled()
      expect(f.pool.row('session', 's1')).toBe(before)
      expect(f.pool.sessionObject('s1')).toBe(f.model)
    } finally {
      for (const stop of stops) stop()
      f.pool.dispose()
    }
  })
})
