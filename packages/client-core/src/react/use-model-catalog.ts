import type { MachineId } from '@podium/model'
import type { ModelChoiceWire } from '@podium/protocol'
import { useEffect, useState } from 'react'
import type { PodiumClientApi } from '../api'
import { useStoreSelector } from './provider'

export type ModelCatalog = Record<string, ModelChoiceWire[]>

interface Snapshot {
  machineId: MachineId
  byAgent: ModelCatalog
  fetchedAt: number
  version?: number
}

const DEFAULT_MACHINE = '__default__'
const EMPTY_CATALOG: ModelCatalog = {}
const CLIENT_TTL_MS = 5 * 60 * 1000

const cache = new Map<string, Snapshot>()
/** When this client last checked, distinct from when the server last probed. */
const checkedAt = new Map<string, number>()
const inflight = new Map<string, Promise<void>>()
const subscribers = new Map<string, Set<() => void>>()

function cacheKey(machineId: MachineId | undefined): string {
  return machineId ?? DEFAULT_MACHINE
}

function publish(key: string, snapshot: Snapshot): void {
  cache.set(key, snapshot)
  checkedAt.set(key, Date.now())
  for (const subscriber of subscribers.get(key) ?? []) subscriber()
}

function isEmpty(byAgent: ModelCatalog): boolean {
  return Object.values(byAgent).every((models) => !models || models.length === 0)
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
      // The server's first SWR read can be empty while its probe is running.
      // Join that probe so the currently-open picker fills in without a remount.
      if (isEmpty(snapshot.byAgent)) publish(key, await api.refresh.mutate(input))
    } catch {
      // Keep the last good catalog, but record the check so an unavailable server
      // does not create a tight retry loop across several mounted pickers.
      checkedAt.set(key, Date.now())
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
export function useModelCatalog<TApi extends PodiumClientApi = PodiumClientApi>(
  machineId?: MachineId,
): ModelCatalog {
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
      if (api && Date.now() - lastCheck >= CLIENT_TTL_MS) {
        void fetchCatalog(api, machineId)
      }
    }

    revalidate()
    const timer = setInterval(revalidate, CLIENT_TTL_MS)
    return () => {
      clearInterval(timer)
      listeners.delete(subscriber)
      if (listeners.size === 0) subscribers.delete(key)
    }
  }, [key, machineId, trpc])

  return cache.get(key)?.byAgent ?? EMPTY_CATALOG
}
