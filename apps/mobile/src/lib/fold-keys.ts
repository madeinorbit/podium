import type { IssueStage } from '@podium/model'

/**
 * THE PHONE'S FOLD KEYS [POD-724] — the twin of
 * `apps/web/src/features/worklist/fold-keys.ts`, and for the same reason.
 *
 * ---------------------------------------------------------------------------
 * THE KEY SPELLING DECIDES WHERE THE STATE LIVES — AND WHETHER IT EXISTS AT ALL
 * ---------------------------------------------------------------------------
 *
 * `useCollapsed` writes through `Store.uiState`, which routes by KEY through
 * `uiStateRoute`. That classifier is DEFAULT-CLOSED: it maps
 * `podium:sidebar:<name>` onto `sidebar.section.<name>` (a per-user REPLICATED
 * layout row), keeps a short list of keys device-local, and THROWS on anything
 * it does not recognise. It is not a fallback — an unregistered key takes the
 * whole screen down on first render, which is exactly what a freshly-invented
 * `tasks.stage.<stage>` did to the Tasks tab.
 *
 * So these folds reuse the ALREADY-CLASSIFIED namespace rather than minting a
 * new one. That is not merely the cheap fix: a collapsed board section is the
 * same class of preference as the desktop board's display options, which POD-540
 * established as per-user replicated precisely so the operator's view of the
 * board is theirs and not their laptop's. Folding Backlog away on the couch and
 * finding it folded at the desk is the behaviour we want; a device-local fold
 * would be a second, silently-diverging opinion about the same board.
 *
 * A rename to `podium.tasks.stage` would keep every test green, keep the UI
 * working, and quietly stop replicating — which is why the spellings live here
 * with this note instead of in template literals at three call sites.
 */

/** Fold state for one stage section of the Tasks board. */
export const stageFoldKey = (stage: IssueStage): string =>
  `podium:sidebar:tasks-stage-fold:${stage}`

/** Fold state for the task page's Details block. */
export const TASK_DETAILS_FOLD_KEY = 'podium:sidebar:task-details-fold'
