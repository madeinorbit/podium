import type { MachineId } from '@podium/model'
import type { HostMemoryBreakdown } from '@podium/protocol'
import { describe, expect, it } from 'vitest'
import { serverProfileRequestKey } from '../client/server-profiles'
import {
  beginCapacityRefresh,
  CapacityRefreshFence,
  CapacityRefreshScheduler,
  isCapacityAuthenticationFailure,
  selectCapacityRefreshMachineIds,
  settleWithConcurrency,
  settleCapacityRefresh,
} from './capacity-refresh'

const machineId = 'machine:one' as MachineId
const sample: HostMemoryBreakdown = {
  hostname: 'studio.local',
  sampledAt: '2026-08-31T10:00:00.000Z',
  supported: true,
  memory: {
    totalBytes: 32 * 1024 ** 3,
    availableBytes: 16 * 1024 ** 3,
    swapTotalBytes: 0,
    swapFreeBytes: 0,
  },
  disk: {
    path: '/home/operator',
    totalBytes: 1024 ** 4,
    usedBytes: 512 * 1024 ** 3,
    availableBytes: 512 * 1024 ** 3,
  },
  agents: [],
  projects: [],
  otherBytes: 0,
}

describe('capacity refresh state', () => {
  it('marks a cached success stale when its next refresh fails', () => {
    const firstStarted = beginCapacityRefresh({}, [machineId])
    const ready = settleCapacityRefresh(firstStarted, [
      [machineId, { status: 'fulfilled', value: sample }],
    ])
    expect(ready[machineId]).toEqual({ state: 'ready', value: sample })

    const secondStarted = beginCapacityRefresh(ready, [machineId])
    expect(secondStarted[machineId]).toEqual({ state: 'loading', value: sample })
    const stale = settleCapacityRefresh(secondStarted, [
      [machineId, { status: 'rejected', reason: new Error('offline') }],
    ])
    expect(stale[machineId]).toEqual({ state: 'stale', value: sample })
  })

  it('reports unavailable when the first read fails', () => {
    const started = beginCapacityRefresh({}, [machineId])
    const failed = settleCapacityRefresh(started, [
      [machineId, { status: 'rejected', reason: new Error('denied') }],
    ])
    expect(failed[machineId]).toEqual({ state: 'unavailable', value: null })
  })

  it('purges a cached sample when the server denies the live read', () => {
    const started = beginCapacityRefresh({ [machineId]: { state: 'ready', value: sample } }, [
      machineId,
    ])
    const denied = settleCapacityRefresh(started, [
      [machineId, { status: 'rejected', reason: { data: { code: 'FORBIDDEN' } } }],
    ])
    expect(denied[machineId]).toEqual({ state: 'unavailable', value: null })
  })

  it('distinguishes profile authentication failure from a machine denial', () => {
    expect(isCapacityAuthenticationFailure({ data: { code: 'UNAUTHORIZED' } })).toBe(true)
    expect(isCapacityAuthenticationFailure({ status: 401 })).toBe(true)
    expect(isCapacityAuthenticationFailure({ data: { code: 'FORBIDDEN' } })).toBe(false)
  })

  it('retains an authorized offline sample as stale without refreshing it', () => {
    const retained = beginCapacityRefresh(
      { [machineId]: { state: 'ready', value: sample } },
      [machineId],
      [],
      [machineId],
    )
    expect(retained[machineId]).toEqual({ state: 'stale', value: sample })
  })

  it('skips a fresh success on refocus but forces it on explicit refresh', () => {
    const readings = { [machineId]: { state: 'ready' as const, value: sample } }
    const shortlyAfterSample = Date.parse(sample.sampledAt) + 60_000

    expect(
      selectCapacityRefreshMachineIds(readings, [machineId], shortlyAfterSample, false),
    ).toEqual([])
    expect(beginCapacityRefresh(readings, [machineId], [])).toEqual(readings)
    expect(
      selectCapacityRefreshMachineIds(readings, [machineId], shortlyAfterSample, true),
    ).toEqual([machineId])
    expect(
      selectCapacityRefreshMachineIds(
        readings,
        [machineId],
        shortlyAfterSample + 5 * 60_000,
        false,
      ),
    ).toEqual([machineId])
  })
})

describe('capacity refresh fence', () => {
  it('rejects older overlapping reloads', () => {
    const fence = new CapacityRefreshFence('profile-a')
    const first = fence.begin('profile-a')
    const second = fence.begin('profile-a')
    expect(fence.accepts(first)).toBe(false)
    expect(fence.accepts(second)).toBe(true)
  })

  it('rejects a prior request when the same profile opens a replacement instance', () => {
    const firstKey = serverProfileRequestKey({
      id: 'profile-a',
      userId: 'user-a',
      instanceId: 'instance-one',
    })
    const replacementKey = serverProfileRequestKey({
      id: 'profile-a',
      userId: 'user-a',
      instanceId: 'instance-two',
    })
    const fence = new CapacityRefreshFence(firstKey)
    const oldProfile = fence.begin(firstKey)
    fence.selectProfile(replacementKey)
    const currentProfile = fence.begin(replacementKey)
    expect(replacementKey).not.toBe(firstKey)
    expect(fence.accepts(oldProfile)).toBe(false)
    expect(fence.accepts(currentProfile)).toBe(true)
  })

  it('invalidates the active batch after a profile-wide auth failure', () => {
    const fence = new CapacityRefreshFence('profile-a')
    const token = fence.begin('profile-a')
    fence.invalidate(token)
    expect(fence.accepts(token)).toBe(false)
  })
})

describe('settleWithConcurrency', () => {
  it('keeps result order and limits active probes', async () => {
    let active = 0
    let peak = 0
    const results = await settleWithConcurrency([1, 2, 3, 4, 5], 2, async (value) => {
      active += 1
      peak = Math.max(peak, active)
      await Promise.resolve()
      active -= 1
      return value * 10
    })
    expect(peak).toBe(2)
    expect(results).toEqual([10, 20, 30, 40, 50].map((value) => ({ status: 'fulfilled', value })))
  })
})

describe('CapacityRefreshScheduler', () => {
  it('keeps replacement focus lifetimes behind the active host-walk batch', async () => {
    const scheduler = new CapacityRefreshScheduler()
    const firstOwner = 'profile-one'
    const replacementOwner = 'profile-two'
    let active = 0
    let peak = 0
    let releaseFirst = (): void => {}
    let releaseReplacement = (): void => {}
    let markReplacementStarted = (): void => {}
    const replacementStarted = new Promise<void>((resolve) => {
      markReplacementStarted = resolve
    })

    scheduler.schedule(firstOwner, false, () => {
      active += 1
      peak = Math.max(peak, active)
      return new Promise<void>((resolve) => {
        releaseFirst = () => {
          active -= 1
          resolve()
        }
      })
    })
    scheduler.schedule(replacementOwner, false, () => {
      active += 1
      peak = Math.max(peak, active)
      markReplacementStarted()
      return new Promise<void>((resolve) => {
        releaseReplacement = () => {
          active -= 1
          resolve()
        }
      })
    })

    expect(active).toBe(1)
    releaseFirst()
    await replacementStarted
    expect(active).toBe(1)
    expect(peak).toBe(1)
    releaseReplacement()
  })

  it('coalesces queued pulls and preserves a forced refresh', async () => {
    const scheduler = new CapacityRefreshScheduler()
    const owner = 'profile-one'
    let release = (): void => {}
    const forces: boolean[] = []
    let markQueuedStarted = (): void => {}
    const queuedStarted = new Promise<void>((resolve) => {
      markQueuedStarted = resolve
    })
    scheduler.schedule(owner, false, async (force) => {
      forces.push(force)
      await new Promise<void>((resolve) => {
        release = resolve
      })
    })
    scheduler.schedule(owner, false, async () => undefined)
    scheduler.schedule(owner, true, async (force) => {
      forces.push(force)
      markQueuedStarted()
    })

    release()
    await queuedStarted
    expect(forces).toEqual([false, true])
  })
})
