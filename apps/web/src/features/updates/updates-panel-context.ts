/**
 * THE EAGER HALF OF THE UPDATE SURFACE — the seam the strip reads (POD-2102).
 *
 * SPLIT FROM THE PROVIDER ON PURPOSE. The provider registers the service worker
 * and therefore imports `virtual:pwa-register/react` — a Vite virtual module
 * that only exists when the PWA plugin is in the pipeline. The status strip
 * only wants to READ this, and pulling the whole provider into its module graph
 * would make an unrelated component's tests depend on the build's PWA plugin.
 *
 * IT IS A STORE, NOT A CONTEXT, AND THAT IS THE POINT (POD-2190). A context has
 * to be PROVIDED by an ancestor, so the strip could only be told about an update
 * by a provider mounted above it — which meant the update ENGINE, its view model
 * and its renderer all had to be in the eager graph, 99 KB of source that the
 * first paint has no use for. That is what put the eager budget over.
 *
 * A module-level store has no ancestor. The engine can therefore be loaded a beat
 * later without the strip waiting for it or knowing that it did: until the engine
 * publishes, the answer is `IDLE_UPDATES` — "no update" — which is not a
 * placeholder but the literal truth, because no poll has returned yet. Nothing
 * about an update can be lost in that window, because in that window the client
 * has not yet been told there is one.
 *
 * A singleton is honest here for the same reason `open-panel.ts` next door is
 * one: an app has exactly one update surface, and its two halves are mounted in
 * two different subtrees.
 */
import { useSyncExternalStore } from 'react'
import type { IndicatorState } from './indicator-state'

export interface UpdatesContextValue {
  indicator: IndicatorState
  indicatorLabel: string
  /** Whether the panel is currently expanded — the indicator's `aria-expanded`. */
  open: boolean
  toggle: () => void
  show: () => void
  checkNow: () => void
}

const NOOP = (): void => {}

/**
 * What the strip sees before the engine has published, and again once it
 * unmounts. A REAL, INERT value rather than `undefined`: a component rendered
 * outside the surface entirely (a test, a screen mounted before the shell)
 * degrades to "there is no update" instead of throwing.
 */
export const IDLE_UPDATES: UpdatesContextValue = {
  indicator: 'none',
  indicatorLabel: '',
  open: false,
  toggle: NOOP,
  show: NOOP,
  checkNow: NOOP,
}

let published: UpdatesContextValue = IDLE_UPDATES
const listeners = new Set<() => void>()

/** The engine's one way to speak to the strip. */
export function publishUpdates(value: UpdatesContextValue): void {
  published = value
  for (const listener of listeners) listener()
}

/** Back to "no update", so an unmounted engine leaves no ghost in the strip. */
export function resetUpdates(): void {
  publishUpdates(IDLE_UPDATES)
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

function readPublished(): UpdatesContextValue {
  return published
}

export function useUpdates(): UpdatesContextValue {
  return useSyncExternalStore(subscribe, readPublished, readPublished)
}
