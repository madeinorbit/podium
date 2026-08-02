/**
 * `useSlice` (POD-330) — the ONE hook a view uses to read a published slice.
 *
 * Where `useStoreSelector` runs a caller-supplied selector and caches it PER
 * COMPONENT, `useSlice` reads a NAMED slice from a publisher shared by the whole
 * tree: two components reading the worklist cause one derivation, not two, which
 * is the point of publishing slices at all.
 *
 * Both are correct across evict/rescope, and for the same reason — the key is
 * snapshot identity. Neither is being replaced by the other: a one-off selector
 * ("this session's title") has no business being a named slice, and a named
 * slice read by five components has no business being re-derived five times.
 *
 * The publisher is keyed off the store HANDLE, which is stable for as long as
 * the principal is unchanged and is replaced when it changes. A new principal
 * therefore gets a new publisher holding nothing — the mechanism never has to be
 * told that a sign-out happened.
 *
 * PRESENCE IS NOT READ THROUGH HERE. It is stream-plane and ephemeral
 * (POD-1078): it has its own publisher and never enters a memoized entity slice,
 * the funnel, the oplog or a persisted snapshot.
 */
import { useSyncExternalStore } from 'react'
import type { PodiumClientApi } from '../api'
import type { Store } from '../engine/types'
import {
  createSlicePublisher,
  type SliceDefinition,
  type SliceDerivationCounts,
  type SlicePublisher,
} from '../viewmodels/slices/publish'
import { useStoreHandle } from './provider'

/** The read seam, structurally — the same shape the provider's hooks consume. */
interface Handle<TApi extends PodiumClientApi> {
  subscribe(listener: () => void): () => void
  getSnapshot(): Store<TApi>
}

// Keyed by handle identity and weakly held, so a runtime that goes away takes
// its publisher (and every value it memoized) with it. Nothing here is a
// module-level cache of DATA — only of the per-runtime publisher.
const publishers = new WeakMap<object, SlicePublisher<Store<PodiumClientApi>>>()

function publisherFor<TApi extends PodiumClientApi>(
  handle: Handle<TApi>,
): SlicePublisher<Store<TApi>> {
  const existing = publishers.get(handle as object)
  if (existing) return existing as unknown as SlicePublisher<Store<TApi>>
  const created = createSlicePublisher(() => handle.getSnapshot())
  publishers.set(handle as object, created as unknown as SlicePublisher<Store<PodiumClientApi>>)
  return created
}

/**
 * Read a published slice. Re-renders only when THIS slice's value changes
 * identity — a snapshot that leaves the slice equal (per the slice's own
 * `isEqual`) does not re-render its readers.
 */
export function useSlice<T, TApi extends PodiumClientApi = PodiumClientApi>(
  def: SliceDefinition<Store<TApi>, T>,
): T {
  const handle = useStoreHandle<TApi>()
  const publisher = publisherFor(handle)
  return useSyncExternalStore(handle.subscribe, () => publisher.read(def))
}

/** Derivation counts for the current tree's publisher — the render-count probe
 *  reads this. Instrumentation only; no product code may branch on it. */
export function useSliceDerivationCounts<
  TApi extends PodiumClientApi = PodiumClientApi,
>(): SliceDerivationCounts {
  const handle = useStoreHandle<TApi>()
  return publisherFor(handle).derivations()
}
