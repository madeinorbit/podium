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
 * The web client's construction had no HOME of its own. `AppShell` passes
 * `createReplicaFn` only when the kernel-replica flag resolves to `kernel` or the
 * Tauri SQLite factory resolved; a plain browser with the flag off passed nothing,
 * the engine called `createReplica()` with no argument, and the replica resolved
 * `window.localStorage` itself. So the SHIPPING browser path adopted whatever the
 * last person on the device left behind.
 *
 * The audit was NOT blind to this — measured, not assumed: on integration it
 * reported `packages/client-core/src/engine/engine.ts:297`. The defect was that the
 * finding named a file that COULD NOT HOST ITS OWN FIX. `engine.ts` is shared and
 * platform-neutral; attribution needs the current principal, which client-core has
 * no way to know. A web agent reading that finding would find nothing there to do.
 *
 * Hence: the ambient reach is gone from the replica (`legacyMigrationStorage`), the
 * engine REQUIRES a factory, and the browser's construction happens HERE — in a web
 * file, where the answer can actually be wired. Audit membership moves by exactly
 * one, `engine.ts:297` out and this file in; the count does not change, because
 * nothing was hidden and nothing new exposed.
 *
 * ---------------------------------------------------------------------------
 * THIS ROOT IS DELIBERATELY UNATTRIBUTED, AND SAYING SO IS THE POINT
 * ---------------------------------------------------------------------------
 *
 * It does not call the gate yet. Wiring the browser's attribution belongs to
 * POD-1223, which owns the web client's identity plumbing; inventing a second,
 * competing call here would collide with the work already in flight.
 *
 * So it is a FINDING: red today at the `createReplica` call below, green the day
 * POD-1223's attribution lands here. A finding that names a file which CAN host its
 * own fix is a different object from one that cannot — both are counted, only one
 * can be closed.
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
