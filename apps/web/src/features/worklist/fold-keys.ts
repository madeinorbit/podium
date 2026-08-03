/**
 * THE SIDEBAR'S FOLD KEYS (POD-407).
 *
 * Three collapsible things in the worklist persist their open/closed state: the
 * per-group snoozed fold, the per-group closed fold, and each issue row's own
 * disclosure. Their keys were inline template literals at three call sites, which
 * is a hazard rather than an untidiness — see below.
 *
 * ---------------------------------------------------------------------------
 * THE KEY SPELLING DECIDES WHERE THE STATE LIVES
 * ---------------------------------------------------------------------------
 *
 * `useCollapsed` writes through `Store.uiState`, and that layer routes by KEY
 * (POD-329 / POD-1076): `layoutKeyFromLegacy` maps `podium:sidebar:<name>` to
 * `sidebar.section.<name>`, which `isLayoutKey` admits, which makes it a
 * PER-USER REPLICATED layout row. Anything it does NOT recognise falls to the
 * device-local store instead.
 *
 * So the `podium:sidebar:` prefix is not decoration — it is the difference
 * between a fold that follows you to your phone and a fold that silently stops
 * replicating. A rename to, say, `podium.sidebar.snoozed` would keep every test
 * green, keep the UI working on one machine, and quietly drop the state out of
 * the per-user family. That failure is invisible from the component, which is why
 * the spelling lives here with a test on the routing rather than in three
 * template literals.
 *
 * Naming these does NOT change behaviour: the strings are byte-identical to the
 * ones the component built inline before the extraction.
 */

/** Per-project-group fold over snoozed issues. */
export const snoozedFoldKey = (groupKey: string): string =>
  `podium:sidebar:snoozed-fold:${groupKey}`

/** Per-project-group fold over closed issues. */
export const closedFoldKey = (groupKey: string): string => `podium:sidebar:closed-fold:${groupKey}`

/** One issue row's own disclosure. */
export const issueRowFoldKey = (issueId: string): string => `podium:sidebar:unified-issue:${issueId}`
