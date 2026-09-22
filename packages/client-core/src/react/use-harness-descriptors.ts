import type { MachineId } from '@podium/model'
import type { HarnessDescriptorWire } from '@podium/protocol'
import { useEffect, useRef, useState } from 'react'
import type { PodiumClientApi } from '../api'
import { useStoreSelector } from './provider'

export type HarnessDescriptorStatus = 'loading' | 'ready' | 'unavailable'

export interface HarnessDescriptorState {
  /** Served descriptors for the machine, or undefined when none arrived
   *  (older daemon, no report yet, no machine): callers render the bundled
   *  copy from `@podium/harness/browser` in that case. */
  served: HarnessDescriptorWire[] | undefined
  status: HarnessDescriptorStatus
}

interface Scope {
  cache: Map<string, HarnessDescriptorWire[] | undefined>
  inflight: Map<string, Promise<void>>
  subscribers: Map<string, Set<() => void>>
  statusByKey: Map<string, HarnessDescriptorStatus>
}

const scopesByApi = new WeakMap<object, Scope>()

function scopeFor(apiIdentity: object): Scope {
  const existing = scopesByApi.get(apiIdentity)
  if (existing) return existing
  const created: Scope = {
    cache: new Map(),
    inflight: new Map(),
    subscribers: new Map(),
    statusByKey: new Map(),
  }
  scopesByApi.set(apiIdentity, created)
  return created
}

async function fetchDescriptors(
  scope: Scope,
  api: NonNullable<PodiumClientApi['machines']>,
  key: string,
  machineId: MachineId,
): Promise<void> {
  const existing = scope.inflight.get(key)
  if (existing) return existing
  const pending = (async () => {
    await Promise.resolve()
    scope.statusByKey.set(key, 'loading')
    for (const subscriber of scope.subscribers.get(key) ?? []) subscriber()
    try {
      const served = await api.descriptors.query({ machineId })
      scope.cache.set(key, served)
      scope.statusByKey.set(key, 'ready')
    } catch {
      scope.statusByKey.set(key, 'unavailable')
    } finally {
      scope.inflight.delete(key)
      for (const subscriber of scope.subscribers.get(key) ?? []) subscriber()
    }
  })()
  scope.inflight.set(key, pending)
  return pending
}

/**
 * Served harness descriptors for one machine (POD-4475), shared by web and
 * mobile pickers, marks and labels.
 *
 * Unlike the model catalog this is NOT stale-while-revalidate: descriptors
 * are pushed facts (every inventoryReport carries them), so the hook fetches
 * once per machine and keeps the last answer — a newer report arrives with
 * the next mount, and long-lived screens can call `refreshHarnessDescriptors`
 * after an explicit inventory request. `machineId` undefined means "no
 * machine": unavailable immediately, no request.
 */
export function useHarnessDescriptors<TApi extends PodiumClientApi = PodiumClientApi>(
  machineId: MachineId | undefined,
): HarnessDescriptorState {
  const trpc = useStoreSelector<TApi, TApi>((store) => store.trpc)
  const [, forceRender] = useState(0)
  const key = machineId ?? '__no_machine__'
  // First-render transport wins: some test stores hand out a fresh `trpc`
  // object per selector call, and keying the scope (or the effect) off its
  // identity would refetch — and re-render — forever. Production trpc is
  // stable, so this changes nothing there.
  const trpcRef = useRef<TApi | null>(null)
  if (trpcRef.current === null) trpcRef.current = trpc
  const scope = scopeFor(trpcRef.current)

  useEffect(() => {
    const subscriber = () => forceRender((value) => value + 1)
    const listeners = scope.subscribers.get(key) ?? new Set<() => void>()
    listeners.add(subscriber)
    scope.subscribers.set(key, listeners)
    return () => {
      listeners.delete(subscriber)
      if (listeners.size === 0) scope.subscribers.delete(key)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, scope])

  useEffect(() => {
    if (!machineId) {
      if (scope.statusByKey.get(key) !== 'unavailable') {
        scope.statusByKey.set(key, 'unavailable')
        for (const subscriber of scope.subscribers.get(key) ?? []) subscriber()
      }
      return
    }
    // Test stores may carry a partial trpc surface (no `machines` router):
    // unavailable, never a throw — callers render the bundled copy.
    const api = (trpc as Partial<PodiumClientApi>).machines
    if (!api?.descriptors) {
      if (scope.statusByKey.get(key) !== 'unavailable') {
        scope.statusByKey.set(key, 'unavailable')
        for (const subscriber of scope.subscribers.get(key) ?? []) subscriber()
      }
      return
    }
    if (scope.inflight.has(key) || scope.statusByKey.get(key) === 'ready') return
    void fetchDescriptors(scope, api as NonNullable<PodiumClientApi['machines']>, key, machineId)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, machineId, scope])

  return {
    served: scope.cache.get(key),
    status: scope.statusByKey.get(key) ?? 'loading',
  }
}
