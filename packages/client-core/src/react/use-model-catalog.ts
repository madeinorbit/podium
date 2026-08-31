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

interface CatalogScope {
  cache: Map<string, Snapshot>
  /** When this client last checked, distinct from when the server last probed. */
  checkedAt: Map<string, number>
  inflight: Map<string, Promise<void>>
  subscribers: Map<string, Set<() => void>>
  statusByKey: Map<string, ModelCatalogStatus>
}

const scopesByApi = new WeakMap<object, CatalogScope>()

function catalogScope(apiIdentity: object): CatalogScope {
  const existing = scopesByApi.get(apiIdentity)
  if (existing) return existing
  const created: CatalogScope = {
    cache: new Map(),
    checkedAt: new Map(),
    inflight: new Map(),
    subscribers: new Map(),
    statusByKey: new Map(),
  }
  scopesByApi.set(apiIdentity, created)
  return created
}

function cacheKey(machineId: MachineId | undefined): string {
  return machineId ?? DEFAULT_MACHINE
}

function publish(
  scope: CatalogScope,
  key: string,
  snapshot: Snapshot,
  status: ModelCatalogStatus,
): void {
  scope.cache.set(key, snapshot)
  scope.checkedAt.set(key, Date.now())
  scope.statusByKey.set(key, status)
  for (const subscriber of scope.subscribers.get(key) ?? []) subscriber()
}

function publishStatus(scope: CatalogScope, key: string, status: ModelCatalogStatus): void {
  scope.statusByKey.set(key, status)
  for (const subscriber of scope.subscribers.get(key) ?? []) subscriber()
}

function needsRefresh(snapshot: Snapshot): boolean {
  return snapshot.fetchedAt === 0 || Date.now() - snapshot.fetchedAt >= MODEL_CATALOG_MAX_AGE_MS
}

async function fetchCatalog(
  scope: CatalogScope,
  api: NonNullable<PodiumClientApi['models']>,
  machineId: MachineId | undefined,
): Promise<void> {
  const key = cacheKey(machineId)
  const existing = scope.inflight.get(key)
  if (existing) return existing

  const pending = (async () => {
    // A catalog past its recheck boundary is data we can keep displaying, but
    // it is not launch authority until the server proves it fresh again.
    publishStatus(scope, key, 'loading')
    try {
      const input = machineId ? { machineId } : undefined
      const snapshot = await api.catalog.query(input)
      if (!needsRefresh(snapshot)) {
        publish(scope, key, snapshot, 'ready')
        return
      }
      publish(scope, key, snapshot, 'loading')
      // A stale server read starts an SWR probe and returns the old value immediately.
      // Join that same in-flight probe so this mounted picker receives the result now,
      // rather than waiting for the next interval. The shared max age keeps the client
      // and server on the same definition of stale.
      const refreshed = await api.refresh.mutate(input)
      publish(scope, key, refreshed, needsRefresh(refreshed) ? 'unavailable' : 'ready')
    } catch {
      // Keep the last good catalog, but record the check so an unavailable server
      // does not create a tight retry loop across several mounted pickers.
      scope.checkedAt.set(key, Date.now())
      publishStatus(scope, key, 'unavailable')
    } finally {
      scope.inflight.delete(key)
    }
  })()
  scope.inflight.set(key, pending)
  return pending
}

/**
 * Shared stale-while-revalidate model catalog for web and mobile selectors.
 *
 * Catalogs are API-identity and machine scoped because harness models are instance
 * facts. A mounted picker rechecks periodically; previously this happened only on
 * mount, leaving the always-mounted empty-state composer stuck on its first snapshot.
 */
export function useModelCatalogState<TApi extends PodiumClientApi = PodiumClientApi>(
  machineId?: MachineId,
): ModelCatalogState {
  const trpc = useStoreSelector<TApi, TApi>((store) => store.trpc)
  const [, forceRender] = useState(0)
  const key = cacheKey(machineId)
  const scope = catalogScope(trpc)

  useEffect(() => {
    const subscriber = () => forceRender((value) => value + 1)
    const listeners = scope.subscribers.get(key) ?? new Set<() => void>()
    listeners.add(subscriber)
    scope.subscribers.set(key, listeners)

    const revalidate = (): void => {
      const lastCheck = scope.checkedAt.get(key) ?? 0
      const api = (trpc as Partial<PodiumClientApi>).models
      if (!api) {
        publishStatus(scope, key, 'unavailable')
      } else if (Date.now() - lastCheck >= MODEL_CATALOG_MAX_AGE_MS) {
        void fetchCatalog(scope, api, machineId)
      }
    }

    revalidate()
    const timer = setInterval(revalidate, MODEL_CATALOG_MAX_AGE_MS)
    return () => {
      clearInterval(timer)
      listeners.delete(subscriber)
      if (listeners.size === 0) scope.subscribers.delete(key)
    }
  }, [key, machineId, scope, trpc])

  return {
    catalog: scope.cache.get(key)?.byAgent ?? EMPTY_CATALOG,
    status: scope.statusByKey.get(key) ?? 'loading',
  }
}

/** Compatibility surface for consumers that only need the last good catalog. */
export function useModelCatalog<TApi extends PodiumClientApi = PodiumClientApi>(
  machineId?: MachineId,
): ModelCatalog {
  return useModelCatalogState<TApi>(machineId).catalog
}
