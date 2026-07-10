import { useEffect, useState } from 'react'
import { useStoreSelector } from '@/app/store'
import type { ModelChoice } from './agent-models'

/**
 * Client-side stale-while-revalidate for the live per-agent model catalog. A single
 * module-level cache is shared by every ModelPicker: reads return it instantly, and a
 * mount refreshes it in the background when stale. Falls back to an empty map (→ the
 * static catalog) when the server has no `models` API (older server) or in tests.
 */
type Catalog = Record<string, ModelChoice[]>
interface Snapshot {
  byAgent: Catalog
  fetchedAt: number
}

let cache: Snapshot = { byAgent: {}, fetchedAt: 0 }
let inflight: Promise<void> | null = null
const subscribers = new Set<() => void>()
const CLIENT_TTL_MS = 5 * 60 * 1000

function publish(next: Snapshot): void {
  cache = next
  for (const s of subscribers) s()
}

function isEmpty(byAgent: Catalog): boolean {
  return Object.values(byAgent).every((v) => !v || v.length === 0)
}

interface ModelsApi {
  catalog: { query: () => Promise<Snapshot> }
  refresh: { mutate: () => Promise<Snapshot> }
}

async function fetchCatalog(api: ModelsApi): Promise<void> {
  if (inflight) return inflight
  inflight = (async () => {
    try {
      const snap = await api.catalog.query()
      publish(snap)
      // The server serves stale-while-revalidate: a cold cache returns empty and kicks
      // its own probe. Force one refresh so THIS open fills in (~2s) instead of waiting
      // for a re-open. The server dedups, so this joins the probe the query already began.
      if (isEmpty(snap.byAgent)) publish(await api.refresh.mutate())
    } catch {
      // keep the last-good cache
    } finally {
      inflight = null
    }
  })()
  return inflight
}

export function useModelCatalog(): Catalog {
  const trpc = useStoreSelector((s) => s.trpc)
  const [, force] = useState(0)
  useEffect(() => {
    const sub = () => force((n) => n + 1)
    subscribers.add(sub)
    const api = (trpc as unknown as { models?: ModelsApi }).models
    if (api && Date.now() - cache.fetchedAt > CLIENT_TTL_MS) void fetchCatalog(api)
    return () => {
      subscribers.delete(sub)
    }
  }, [trpc])
  return cache.byAgent
}
