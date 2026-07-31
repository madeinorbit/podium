/**
 * THE BROWSER'S REPLICA COMPOSITION ROOT (POD-1239).
 *
 * ---------------------------------------------------------------------------
 * WHY THIS FILE HAD TO EXIST BEFORE THE BUG COULD BE FIXED
 * ---------------------------------------------------------------------------
 *
 * POD-307 specifies the client's persisted store as fail-closed: a store that
 * cannot be attributed to the current principal is DISCARDED and re-bootstrapped,
 * never adopted. POD-377 built the gate, POD-378 verified it, and no client ever
 * called it — every site that opens persisted client storage skipped the question.
 *
 * The web client's instance of that hole had no site at all. `AppShell` passes
 * `createReplicaFn` only when the kernel-replica flag resolves to `kernel` or the
 * Tauri SQLite factory resolved; a plain browser with the flag off passed nothing,
 * the engine called `createReplica()` with no argument, and the replica resolved
 * `window.localStorage` itself. So the SHIPPING browser path adopted whatever the
 * last person on the device left behind — and, being a construction nobody
 * performed, it appeared in no audit population and had no root to be graded.
 *
 * Fixing the six known roots individually would have left this one standing,
 * because you cannot fix a caller that does not exist. Hence: the ambient reach is
 * gone from the replica (`legacyMigrationStorage`), the engine now REQUIRES a
 * factory, and the browser's construction happens HERE, in the open, where the
 * client audit's discovery walk finds it and grades it like every other root.
 *
 * ---------------------------------------------------------------------------
 * THIS ROOT IS DELIBERATELY UNATTRIBUTED, AND SAYING SO IS THE POINT
 * ---------------------------------------------------------------------------
 *
 * It does not call the gate yet. Wiring the browser's attribution belongs to
 * POD-1223, which owns the web client's identity plumbing; inventing a second,
 * competing call here would collide with the work already in flight.
 *
 * What changed is that the omission is now VISIBLE. Before this file the audit
 * reported the browser path clean because it had no root to look at — the gate
 * pointed at a wall the path was not behind. Now the path is a named root that
 * builds a persisted replica without asking, so it is a FINDING: red today, green
 * the day POD-1223's attribution lands here. A hole that shows up in the count is
 * a different object from a hole that cannot.
 */

import { createReplica, type Replica } from '@podium/client-core/replica'

/**
 * Everything ambient, stated.
 *
 * These three used to be implicit defaults inside the replica, each keyed on
 * `init.storage === undefined` — so injecting a store silently also turned off
 * cross-tab sync and the ui-state key enumeration. Passing them explicitly keeps
 * the browser's behaviour byte-for-byte what it was while removing the coupling:
 * the replica no longer infers "you are the real browser" from an absent argument.
 *
 *  - `storage`          the durable web store the collections persist into.
 *  - `storageEventApi`  cross-tab consistency (another tab's write repaints this one).
 *  - `enumerateKeys`    the one-time ui-state migration folds prefix-matched legacy
 *                       keys in, and prefix matching cannot probe keys individually.
 */
export function createWebReplica(): Replica {
  return createReplica({
    storage: window.localStorage,
    storageEventApi: window,
    enumerateKeys: () => Object.keys(window.localStorage),
  })
}
