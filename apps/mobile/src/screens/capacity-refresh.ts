import type {
  MachineCapacityReading,
  MachineCapacityReadings,
} from '@podium/client-core/viewmodels'
import type { MachineId } from '@podium/model'
import type { HostMemoryBreakdown } from '@podium/protocol'

export type CapacityRefreshResult = readonly [MachineId, PromiseSettledResult<HostMemoryBreakdown>]

export const CAPACITY_FRESH_MS = 5 * 60_000

/**
 * A focus refresh can reuse only a recent successful sample. Explicit refresh
 * bypasses this check, while stale/loading/unavailable states always retry.
 */
export function selectCapacityRefreshMachineIds(
  current: MachineCapacityReadings,
  candidateMachineIds: readonly MachineId[],
  nowMs: number,
  force: boolean,
  freshForMs = CAPACITY_FRESH_MS,
): MachineId[] {
  if (force) return [...candidateMachineIds]
  return candidateMachineIds.filter((machineId) => {
    const reading = current[machineId]
    if (reading?.state !== 'ready' || !reading.value) return true
    const sampledAt = Date.parse(reading.value.sampledAt)
    return !Number.isFinite(sampledAt) || nowMs - sampledAt >= freshForMs
  })
}

/**
 * Start a refresh without making a cached sample look current. Machines no
 * longer eligible for the use-gated read are pruned from this profile's cache.
 */
export function beginCapacityRefresh(
  current: MachineCapacityReadings,
  retainedMachineIds: readonly MachineId[],
  refreshMachineIds: readonly MachineId[] = retainedMachineIds,
  staleMachineIds: readonly MachineId[] = [],
): MachineCapacityReadings {
  const next: Partial<Record<MachineId, MachineCapacityReading>> = {}
  const refreshing = new Set(refreshMachineIds)
  const stale = new Set(staleMachineIds)
  for (const machineId of retainedMachineIds) {
    const previous = current[machineId]
    if (refreshing.has(machineId)) {
      next[machineId] = { state: 'loading', value: previous?.value ?? null }
    } else if (stale.has(machineId) && previous?.value) {
      next[machineId] = { state: 'stale', value: previous.value }
    } else if (stale.has(machineId) && previous) {
      next[machineId] = { state: 'unavailable', value: null }
    } else if (previous) {
      next[machineId] = previous
    }
  }
  return next
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null
}

/** tRPC exposes authorization failures through data/shape; fetch-like errors use status. */
export function isCapacityAuthorizationFailure(reason: unknown): boolean {
  const error = record(reason)
  const data = record(error?.data)
  const shape = record(error?.shape)
  const shapeData = record(shape?.data)
  const meta = record(error?.meta)
  const response = record(meta?.response)
  const codes = [error?.code, data?.code, shapeData?.code]
  const statuses = [error?.status, data?.httpStatus, shapeData?.httpStatus, response?.status]
  return (
    codes.some((code) => code === 'FORBIDDEN' || code === 'UNAUTHORIZED') ||
    statuses.some((status) => status === 401 || status === 403)
  )
}

/** True when the whole profile credential failed, rather than one machine grant. */
export function isCapacityAuthenticationFailure(reason: unknown): boolean {
  const error = record(reason)
  const data = record(error?.data)
  const shape = record(error?.shape)
  const shapeData = record(shape?.data)
  const meta = record(error?.meta)
  const response = record(meta?.response)
  return (
    [error?.code, data?.code, shapeData?.code].some((code) => code === 'UNAUTHORIZED') ||
    [error?.status, data?.httpStatus, shapeData?.httpStatus, response?.status].some(
      (status) => status === 401,
    )
  )
}

/** A failed read keeps an old sample only as stale. Without one, it is unavailable. */
export function settleCapacityRefresh(
  started: MachineCapacityReadings,
  results: readonly CapacityRefreshResult[],
): MachineCapacityReadings {
  const next: Partial<Record<MachineId, MachineCapacityReading>> = { ...started }
  for (const [machineId, result] of results) {
    if (result.status === 'fulfilled') {
      next[machineId] = { state: 'ready', value: result.value }
      continue
    }
    const previous = started[machineId]?.value
    next[machineId] = isCapacityAuthorizationFailure(result.reason)
      ? { state: 'unavailable', value: null }
      : previous
        ? { state: 'stale', value: previous }
        : { state: 'unavailable', value: null }
  }
  return next
}

/** Run an ordered batch without starting an unbounded probe fan-out. */
export async function settleWithConcurrency<Input, Output>(
  items: readonly Input[],
  concurrency: number,
  worker: (item: Input) => Promise<Output>,
): Promise<PromiseSettledResult<Output>[]> {
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    throw new RangeError('capacity concurrency must be a positive integer')
  }
  const results = new Array<PromiseSettledResult<Output>>(items.length)
  let cursor = 0
  const run = async (): Promise<void> => {
    while (cursor < items.length) {
      const index = cursor
      cursor += 1
      const item = items[index] as Input
      try {
        results[index] = { status: 'fulfilled', value: await worker(item) }
      } catch (reason) {
        results[index] = { status: 'rejected', reason }
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, run))
  return results
}

interface QueuedCapacityRefresh {
  owner: string
  force: boolean
  run: (force: boolean) => Promise<void>
}

/**
 * One scheduler lives for the hook's full lifetime, so replacing a focus
 * effect cannot start another host-walk batch before the active one settles.
 */
export class CapacityRefreshScheduler {
  private active: Promise<void> | null = null
  private queued: QueuedCapacityRefresh | null = null

  schedule(owner: string, force: boolean, run: (force: boolean) => Promise<void>): void {
    if (this.active) {
      const queuedForce = this.queued?.owner === owner && this.queued.force
      this.queued = { owner, force: force || queuedForce, run }
      return
    }

    let work: Promise<void>
    try {
      work = run(force)
    } catch (error) {
      work = Promise.reject(error)
    }
    this.active = work
    const finish = (): void => {
      if (this.active !== work) return
      this.active = null
      const queued = this.queued
      this.queued = null
      if (queued) this.schedule(queued.owner, queued.force, queued.run)
    }
    void work.then(finish, finish)
  }
}

export interface CapacityRefreshToken {
  profileKey: string
  generation: number
}

/**
 * A small fence shared by focus loads and pull-to-refresh. Selecting another
 * profile invalidates every request issued for the old server and principal.
 */
export class CapacityRefreshFence {
  private profileKey: string
  private generation = 0

  constructor(profileKey: string) {
    this.profileKey = profileKey
  }

  selectProfile(profileKey: string): void {
    if (profileKey === this.profileKey) return
    this.profileKey = profileKey
    this.generation += 1
  }

  begin(profileKey: string): CapacityRefreshToken {
    this.selectProfile(profileKey)
    this.generation += 1
    return { profileKey, generation: this.generation }
  }

  accepts(token: CapacityRefreshToken): boolean {
    return token.profileKey === this.profileKey && token.generation === this.generation
  }

  invalidate(token: CapacityRefreshToken): void {
    if (this.accepts(token)) this.generation += 1
  }
}
