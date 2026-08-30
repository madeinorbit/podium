/**
 * REACHING THE UPDATE PANEL FROM OUTSIDE THE SHELL (POD-2102).
 *
 * Two callers live outside the React tree the panel is mounted in, and both are
 * there on purpose:
 *
 *  - `WireSkewBanner` is mounted at the root, outside the login and setup gates,
 *    because the failure it reports is one where the shell is the thing that did
 *    not come up (POD-1610). It cannot read the panel's context.
 *  - `version-guard.ts` runs BEFORE React exists at all — its whole job is to
 *    decide whether this bundle may talk to this server.
 *
 * So this is a module-level channel, deliberately the same shape as
 * `skew-notice.ts` next to it: a registry the panel writes itself into, and two
 * plain functions the outsiders call. `openUpdatePanel` answers whether anyone
 * was listening, so a caller with a fallback (the banner's reload) can tell
 * "opened it" from "there is no panel in this document".
 */

type Opener = () => boolean
type Availability = () => boolean

let opener: Opener | null = null
let available: Availability | null = null
const listeners = new Set<() => void>()

/** The panel registers itself while mounted. Returns the unregister. */
export function registerUpdatePanelOpener(
  open: Opener,
  canOpen: Availability = () => true,
): () => void {
  opener = open
  available = canOpen
  for (const listener of listeners) listener()
  return () => {
    if (opener === open) {
      opener = null
      available = null
    }
    for (const listener of listeners) listener()
  }
}

/** Is there a panel in this document to open? */
export function hasUpdatePanel(): boolean {
  return opener !== null && (available?.() ?? true)
}

/** Notified when {@link hasUpdatePanel} changes, so a button can label itself honestly. */
export function subscribeUpdatePanel(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** Open the panel. Answers false when nothing is mounted to open. */
export function openUpdatePanel(): boolean {
  if (!opener) return false
  return opener()
}

/**
 * The guard's spent reload budget — the OTHER thing that reaches this panel
 * from outside — lives in `@/lib/reload-budget`, not here: its writer is
 * `features/setup` and a feature may not import another feature.
 */
