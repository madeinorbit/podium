/**
 * The one way a test builds a `SessionStore` [POD-3262, spec step 13].
 *
 * WHY A HELPER RATHER THAN THE CONSTRUCTOR. At the async flip the constructor
 * becomes private and the store is built by `await SessionStore.open(path, …)`,
 * so an un-opened store can never reach a registry. There are 481 constructions
 * across 121 test files; routing them through one function now means the flip
 * edits ONE line of test-support instead of 481 lines of tests, and the flip's
 * reviewer rule — changed test lines differ only by `await`, `async` or the
 * helper rename — stays checkable by eye.
 *
 * WHY IT IS SYNCHRONOUS TODAY AND AWAITED ANYWAY. It returns a store, not a
 * promise, because nothing in the store is asynchronous yet. Its callers already
 * write `await openTestStore(…)`: `await` on a non-promise is legal and resolves
 * on the next microtask, so the awaits land while the store is still synchronous
 * and the suite that is green before the flip is byte-identical to the suite that
 * is green after it. That is what makes the existing tests a usable oracle for the
 * flip (spec §5.1). Twelve timing-sensitive suites call it WITHOUT `await` — the
 * yield would move a frame-cache boundary or a fake-timer tick — and they are
 * listed in the flip issue.
 *
 * WHY IT DOES NOT REPLACE THE PRE-MIGRATED FIXTURE. It is not a second way to
 * build a database: it constructs the store through exactly the path production
 * takes, so the ambient opener seam in `store-database.ts` — and with it the
 * pre-migrated image and its `globalSetup` env channel — applies here unchanged.
 * The seam stays synchronous at the flip and is called from inside `open()`.
 */

import type { MachineId } from '@podium/model'
import type { SnapshotVerifierDeps } from '../migrations/snapshot-verifier'
import { SessionStore } from '../store'

/**
 * Build a `SessionStore` for a test. The parameters are the constructor's, in
 * its order: the database path (`':memory:'` unless the test needs a file), the
 * host machine identity, and the snapshot-verifier seam.
 */
export function openTestStore(
  path?: string,
  hostMachineId?: MachineId,
  snapshotVerifierDeps?: SnapshotVerifierDeps,
): SessionStore {
  // Every parameter of the constructor has a default and an explicit `undefined`
  // selects it, so forwarding all three keeps the state-dir path, the freshly
  // minted machine id and the real verifier exactly as a bare `new SessionStore()`
  // would have them.
  return new SessionStore(path, hostMachineId, snapshotVerifierDeps)
}
