/**
 * Client-side experimental feature gate [spec:SP-f4b9].
 *
 * Module-level cache shared across the app: fetch `features.state` once per load,
 * re-fetch after settings.save. Components gate unfinished UI with
 * `if (!useFeature('x')) return null`.
 *
 * Lives in `lib/` (not `features/`) because it is a cross-cutting gate every
 * feature may call, not a feature surface of its own — the Experimental settings
 * *page* is `features/settings/sections/experimental.tsx`. Keeping it here is what
 * stops `settings -> experimental` (and the next caller) from being a feature-to-
 * feature edge; see features/README.md + test/features.structure.test.ts.
 */
import type { FeatureId } from '@podium/protocol'
import { useEffect, useState } from 'react'
import { useStoreSelector } from '@/app/store'
import type { Trpc } from '@/app/trpc'

export interface FeaturesStateSnapshot {
  devMode: boolean
  channel: 'stable' | 'edge'
  flags: Array<{
    id: string
    name: string
    description: string
    visibility: 'hidden' | 'edge' | 'stable'
    listed: boolean
    enabled: boolean
    source: 'config' | 'user' | 'default'
    locked: boolean
  }>
}

let cache: FeaturesStateSnapshot | null = null
let inflight: Promise<FeaturesStateSnapshot | null> | null = null
/** Monotonic epoch so a pre-invalidate response cannot overwrite a fresher one. */
let fetchEpoch = 0
const subscribers = new Set<() => void>()

function publish(next: FeaturesStateSnapshot | null): void {
  cache = next
  for (const s of subscribers) s()
}

async function fetchFeatures(trpc: Trpc): Promise<FeaturesStateSnapshot | null> {
  if (inflight) return inflight
  const epoch = fetchEpoch
  inflight = (async () => {
    try {
      const snap = await trpc.features.state.query()
      // Drop stale responses that raced past an invalidateFeatures() call.
      if (epoch !== fetchEpoch) return cache
      publish(snap)
      return snap
    } catch {
      // keep last-good cache; first load stays null → flags off
      return cache
    } finally {
      if (epoch === fetchEpoch) inflight = null
    }
  })()
  return inflight
}

/** Force a re-fetch after settings.set (the only writer of user toggles). */
export function invalidateFeatures(trpc: Trpc): void {
  fetchEpoch += 1
  inflight = null
  void fetchFeatures(trpc)
}

/** Subscribe to the shared features.state snapshot (for the Experimental page). */
export function useFeaturesState(): FeaturesStateSnapshot | null {
  const trpc = useStoreSelector((s) => s.trpc)
  const [, force] = useState(0)
  useEffect(() => {
    const sub = () => force((n) => n + 1)
    subscribers.add(sub)
    if (!cache) void fetchFeatures(trpc)
    return () => {
      subscribers.delete(sub)
    }
  }, [trpc])
  return cache
}

/** Whether feature `id` is currently enabled for this install. */
export function useFeature(id: FeatureId): boolean {
  const state = useFeaturesState()
  return state?.flags.find((f) => f.id === id)?.enabled ?? false
}
