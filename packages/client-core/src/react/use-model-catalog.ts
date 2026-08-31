import type { MachineId } from '@podium/model'
import { MODEL_CATALOG_MAX_AGE_MS, type ModelChoiceWire } from '@podium/protocol'
import { useEffect, useState } from 'react'
import type { PodiumClientApi } from '../api'
import { useStoreSelector } from './provider'

export type ModelCatalog = Record<string, ModelChoiceWire[]>
export type ModelCatalogStatus = 'loading' | 'ready' | 'unavailable'

export interface ModelCatalogState {
  catalog: ModelCatalog
  status: ModelCatalogStatus
}

interface Snapshot {
  machineId: MachineId
  byAgent: ModelCatalog
  fetchedAt: number
  version?: number
}

const DEFAULT_MACHINE = '__default__'
const EMPTY_CATALOG: ModelCatalog = {}
const cache = new Map<string, Snapshot>()
/** When this client last checked, distinct from when the server last probed. */
const checkedAt = new Map<string, number>()
const inflight = new Map<string, Promise<void>>()
const subscribers = new Map<string, Set<() => void>>()
const statusByKey = new Map<string, ModelCatalogStatus>()

function cacheKey(machineId: MachineId | undefined): string {
  return machineId ?? DEFAULT_MACHINE
}

function publish(key: string, snapshot: Snapshot): void {
  cache.set(key, snapshot)
  checkedAt.set(key, Date.now())
  statusByKey.set(key, 'ready')
  for (const subscriber of subscribers.get(key) ?? []) subscriber()
}

function publishStatus(key: string, status: ModelCatalogStatus): void {
  statusByKey.set(key, status)
  for (const subscriber of subscribers.get(key) ?? []) subscriber()
}

function needsRefresh(snapshot: Snapshot): boolean {
  return snapshot.fetchedAt === 0 || Date.now() - snapshot.fetchedAt >= MODEL_CATALOG_MAX_AGE_MS
}

async function fetchCatalog(
  api: NonNullable<PodiumClientApi['models']>,
  machineId: MachineId | undefined,
): Promise<void> {
  const key = cacheKey(machineId)
  const existing = inflight.get(key)
  if (existing) return existing

  const pending = (async () => {
    try {
      const input = machineId ? { machineId } : undefined
      const snapshot = await api.catalog.query(input)
      publish(key, snapshot)
      // A stale server read starts an SWR probe and returns the old value immediately.
      // Join that same in-flight probe so this mounted picker receives the result now,
      // rather than waiting for the next interval. The shared max age keeps the client
      // and server on the same definition of stale.
      if (needsRefresh(snapshot)) publish(key, await api.refresh.mutate(input))
    } catch {
      // Keep the last good catalog, but record the check so an unavailable server
      // does not create a tight retry loop across several mounted pickers.
      checkedAt.set(key, Date.now())
      publishStatus(key, 'unavailable')
    } finally {
      inflight.delete(key)
    }
  })()
  inflight.set(key, pending)
  return pending
}

/**
 * Shared stale-while-revalidate model catalog for web and mobile selectors.
 *
 * Catalogs are machine-scoped because harness models are machine facts. A mounted
 * picker rechecks periodically; previously this happened only on mount, leaving the
 * always-mounted empty-state composer stuck on whatever snapshot it first received.
 */
export function useModelCatalogState<TApi extends PodiumClientApi = PodiumClientApi>(
  machineId?: MachineId,
): ModelCatalogState {
  const trpc = useStoreSelector<TApi, TApi>((store) => store.trpc)
  const [, forceRender] = useState(0)
  const key = cacheKey(machineId)

  useEffect(() => {
    const subscriber = () => forceRender((value) => value + 1)
    const listeners = subscribers.get(key) ?? new Set<() => void>()
    listeners.add(subscriber)
    subscribers.set(key, listeners)

    const revalidate = (): void => {
      const lastCheck = checkedAt.get(key) ?? 0
      const api = (trpc as Partial<PodiumClientApi>).models
      if (api && Date.now() - lastCheck >= MODEL_CATALOG_MAX_AGE_MS) {
        void fetchCatalog(api, machineId)
      }
    }

    revalidate()
    const timer = setInterval(revalidate, MODEL_CATALOG_MAX_AGE_MS)
    return () => {
      clearInterval(timer)
      listeners.delete(subscriber)
      if (listeners.size === 0) subscribers.delete(key)
    }
  }, [key, machineId, trpc])

  return {
    catalog: cache.get(key)?.byAgent ?? EMPTY_CATALOG,
    status: statusByKey.get(key) ?? 'loading',
  }
}

/** Compatibility surface for consumers that only need the last good catalog. */
export function useModelCatalog<TApi extends PodiumClientApi = PodiumClientApi>(
  machineId?: MachineId,
): ModelCatalog {
  return useModelCatalogState<TApi>(machineId).catalog
}
