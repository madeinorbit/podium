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

type Opener = () => void

let opener: Opener | null = null
const listeners = new Set<() => void>()

/** The panel registers itself while mounted. Returns the unregister. */
export function registerUpdatePanelOpener(open: Opener): () => void {
  opener = open
  for (const listener of listeners) listener()
  return () => {
    if (opener === open) opener = null
    for (const listener of listeners) listener()
  }
}

/** Is there a panel in this document to open? */
export function hasUpdatePanel(): boolean {
  return opener !== null
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
  opener()
  return true
}

/**
 * THE GUARD'S HARD RELOAD, EXPLAINED AFTERWARDS.
 *
 * `version-guard.ts` may hard-reload this tab twice before it gives up
 * (`MAX_RELOADS`). That budget is the corruption backstop and it stays — but
 * when it is spent, the user has just watched their app reload twice by itself
 * and been told nothing. The guard records it here; the panel says one sentence
 * about it after the reload (§6.2.3).
 *
 * sessionStorage, not a module variable, for the obvious reason: the fact has to
 * survive the very reload it describes.
 */
const RELOAD_BUDGET_KEY = 'podium.update.reload-budget-spent'

export function noteReloadBudgetSpent(): void {
  try {
    globalThis.sessionStorage?.setItem(RELOAD_BUDGET_KEY, '1')
  } catch {
    // Private mode: the explanation is a nicety, never a dependency.
  }
}

export function reloadBudgetSpent(): boolean {
  try {
    return globalThis.sessionStorage?.getItem(RELOAD_BUDGET_KEY) === '1'
  } catch {
    return false
  }
}

export function clearReloadBudgetNote(): void {
  try {
    globalThis.sessionStorage?.removeItem(RELOAD_BUDGET_KEY)
  } catch {
    // ignore — nothing to clear if storage is unavailable
  }
}

/** The sentence the panel shows once the guard has spent its budget. */
export const RELOAD_BUDGET_SENTENCE =
  'Podium reloaded this page automatically to match the server and it did not help, ' +
  'so the app you are looking at may be an older build than the server is serving.'
