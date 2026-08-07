/**
 * THE SIDEBAR'S FOLD KEYS (POD-407).
 *
 * The collapsible things in the worklist persist their open/closed state: the
 * per-group snoozed and closed folds. Since POD-516 flattened the column these
 * GROUP folds are the only foldable things in it — the per-issue row disclosure
 * is gone, and so is its key. Their keys were inline template literals at the
 * call sites, which is a hazard rather than an untidiness — see below.
 *
 * A third key, `proposed-fold`, went with the Proposed section the operator cut
 * in POD-516 round 2. Removing the key is deliberate rather than tidy-up: a
 * stale `podium:sidebar:proposed-fold:*` row is per-user replicated state with
 * no reader, and leaving the spelling behind invites a future fold to adopt it
 * and inherit somebody's year-old collapse.
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
