/**
 * Runtime glue for ref-link activation (#474, areas 6b + 7).
 *
 * Ref links are produced in two very different places — sanitized markdown HTML
 * (chat transcripts) and the xterm terminal link provider — neither of which can
 * easily reach into React state. This module is the thin, framework-free seam
 * both call:
 *
 *   - a module-level external store for the single floating miniview, consumed by
 *     the root-mounted <RefMiniviewHost> via useSyncExternalStore;
 *   - a registered "activator" the host installs, so click handlers can trigger
 *     navigation (which needs live store actions) without importing React.
 *
 * The pure resolve/reducer logic lives in ./ref-miniview; this only wires it up.
 */

import { type MiniviewAnchor, type MiniviewState, miniviewReducer } from './ref-miniview'

// --- Single-instance miniview external store ------------------------------

let miniviewState: MiniviewState = null
const listeners = new Set<() => void>()

function emit(): void {
  for (const l of listeners) l()
}

export function subscribeMiniview(cb: () => void): () => void {
  listeners.add(cb)
  return () => listeners.delete(cb)
}

export function getMiniviewState(): MiniviewState {
  return miniviewState
}

export function openMiniview(ref: string, anchor?: MiniviewAnchor): void {
  miniviewState = miniviewReducer(miniviewState, { type: 'open', ref, anchor })
  emit()
}

export function closeMiniview(): void {
  miniviewState = miniviewReducer(miniviewState, { type: 'close' })
  emit()
}

// --- Prefix-set invalidation ------------------------------------------------

/** Window event dispatched after a repo prefix changes (settings editor), so
 *  <RefPrefixSync> refetches `repos.listDetailed` without a page reload. */
export const REF_PREFIXES_CHANGED_EVENT = 'podium:ref-prefixes-changed'

// --- Activator registry ---------------------------------------------------

/** How a click modifier was held when a ref link was activated. */
export interface RefActivateModifiers {
  /** Cmd (mac) or Ctrl — jump straight to the full issue/session view. */
  direct: boolean
}

export type RefActivator = (
  ref: string,
  mods: RefActivateModifiers,
  anchor?: MiniviewAnchor,
) => void

// Plain default: just open the miniview. The host replaces this with a
// navigation-aware activator once mounted (so Cmd/Ctrl-click can route).
let activator: RefActivator = (ref, _mods, anchor) => openMiniview(ref, anchor)

export function setRefActivator(fn: RefActivator | null): void {
  activator = fn ?? ((ref, _mods, anchor) => openMiniview(ref, anchor))
}

/** Read the modifier that means "go straight to the full view" from a mouse event. */
export function directModifier(e: { metaKey?: boolean; ctrlKey?: boolean }): RefActivateModifiers {
  return { direct: Boolean(e.metaKey || e.ctrlKey) }
}

/** Activate a ref token (from markdown or the terminal). Single entry point so
 *  both surfaces share identical semantics. The click point (when the event has
 *  one) anchors the preview card next to the clicked link. */
export function activateRef(
  ref: string,
  e: { metaKey?: boolean; ctrlKey?: boolean; clientX?: number; clientY?: number },
): void {
  const anchor =
    typeof e.clientX === 'number' && typeof e.clientY === 'number' && (e.clientX || e.clientY)
      ? { x: e.clientX, y: e.clientY }
      : undefined
  activator(ref, directModifier(e), anchor)
}
