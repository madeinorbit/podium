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
 *
 * THE ENGINE SWITCH [POD-6980]. Under `PODIUM_TEST_STORE_ENGINE=pg` (the
 * `server-store-pg` lane) an in-memory store becomes a store on a fresh Postgres
 * database cloned from the run's template: one database per store, so two stores in
 * one test share no rows, exactly as two `':memory:'` SQLite stores do not. The store
 * opens it from its URL; choosing the engine from the location is the store's job
 * (POD-6979). A file path is SQLite by definition, so a Postgres run refuses it and
 * names the list where such a file belongs.
 */

import {
  firstAdminMemberId,
  type MachineId,
  primeFirstAdminMember,
  type WorkspaceId,
} from '@podium/model'
import type { SnapshotVerifierDeps } from '../migrations/snapshot-verifier'
import { SELF_HOSTED_WORKSPACE_ID } from '../self-hosted-workspace'
import { SessionStore } from '../store'
import { clonePgTestDatabase, testStoreEngine } from './pg-test-database'

/**
 * Build a `SessionStore` for a test. The parameters are the constructor's, in
 * its order: the database path (`':memory:'` unless the test needs a file), the
 * host machine identity, and the snapshot-verifier seam; then the options.
 *
 * `workspace` is the workspace the store is for, and the one its database boots
 * (POD-7010). The self-hosted install's when absent; a test that must not lean
 * on that id passes another (POD-6959 task C2 runs the boot-wiring files so).
 * Several workspaces over one database: `openWorkspaceStores`.
 */
export async function openTestStore(
  path?: string,
  hostMachineId?: MachineId,
  snapshotVerifierDeps?: SnapshotVerifierDeps,
  options: { workspace?: WorkspaceId } = {},
): Promise<SessionStore> {
  // Every parameter of the constructor has a default and an explicit `undefined`
  // selects it, so forwarding all three keeps the state-dir path, the freshly
  // minted machine id and the real verifier exactly as a bare `await SessionStore.open()`
  // would have them.
  // No change capture until the test attaches a change log (POD-6920): a
  // store-level fixture seeds with no log to bypass.
  const location = testStoreEngine() === 'pg' ? await postgresLocation(path) : path
  const store = await SessionStore.open(location, hostMachineId, {
    ...snapshotVerifierDeps,
    changeCapture: 'whenLogAttaches',
    workspace: options.workspace ?? SELF_HOSTED_WORKSPACE_ID,
  })
  primeFirstAdminMember(await firstAdminMemberId(store))
  return store
}

/** The location of a Postgres test store standing in for `path`. */
async function postgresLocation(path: string | undefined): Promise<string> {
  if (path !== undefined && path !== ':memory:') {
    throw new Error(
      `openTestStore: ${path} is a SQLite file, and this run uses Postgres. A test that needs ` +
        'a store file tests SQLite itself: list it under sqliteOnly in ' +
        'apps/server/test-store-engines.json.',
    )
  }
  return (await clonePgTestDatabase()).url
}
