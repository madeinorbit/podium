/**
 * THE COMPATIBILITY ADAPTER — POD-351.
 *
 * One command moves to the target path; every other command keeps its legacy
 * path, unchanged. This module is the seam that makes that true and auditable,
 * and it is deliberately tiny: a walking skeleton whose adapter is complicated is
 * a walking skeleton that has started migrating things.
 *
 * ---------------------------------------------------------------------------
 * WHY A SEAM AT ALL, RATHER THAN JUST SWITCHING THE PROCEDURE OVER
 * ---------------------------------------------------------------------------
 *
 * Two reasons, and only the second is the usual one.
 *
 * 1. THE SHADOW COMPARISON NEEDS BOTH PATHS ALIVE AND CALLABLE ON ONE INPUT.
 *    "Shadow-compared" is the easiest criterion in this issue to fake — two green
 *    tests, one per path, prove only that each path is self-consistent. The
 *    comparison has to run both on the SAME input and FAIL on divergence, which
 *    means both must remain reachable from one call site after the cutover.
 * 2. ROLLBACK. If the target path misbehaves in production the fix is an env var,
 *    not a deploy.
 *
 * ---------------------------------------------------------------------------
 * THE DEFAULT IS THE TARGET PATH, AND THAT IS THE POINT
 * ---------------------------------------------------------------------------
 *
 * The acceptance criterion is that `session.rename` RUNS ON THE TARGET PATH IN
 * PRODUCTION CONFIG behind a flag — not that it is available behind one. A flag
 * defaulting to the legacy path would leave the target path with zero production
 * callers, which is the "a flag nothing sets" form of mechanism-presence the
 * review protocol names as stopped-short. So:
 *
 *   default                        → target path
 *   PODIUM_SESSION_RENAME_PATH=legacy → legacy path (the rollback)
 *   PODIUM_SESSION_RENAME_PATH=target → target path (explicit, for tests)
 *
 * An UNRECOGNISED value takes the target path and is not an error, deliberately:
 * this flag's only job is rollback, and a typo that silently disabled a shipped
 * command would be worse than a typo that leaves it on. The one value that does
 * anything is spelled out above and is checked exactly.
 */

import type { MutationLedgerPort } from '@podium/sync'
import type { CommandPrincipal } from '../../command-principal'
import type { SessionStatePrincipal, SessionStateRegistry } from './session-state/registry'
import { renameOnTargetPath, type RenameServices } from './rename-target-path'

/** Which path a rename should take. */
export type RenamePath = 'target' | 'legacy'

/** The env var name, exported so tests and docs cannot misspell it separately. */
export const RENAME_PATH_ENV = 'PODIUM_SESSION_RENAME_PATH'

/** The one value that selects the legacy path. */
export const LEGACY_PATH_VALUE = 'legacy'

/**
 * Read the flag. A FUNCTION, not a module-level constant: a constant is captured
 * at import time, so a test that sets the env var after the module loads would
 * silently exercise the wrong path and pass — the "green gate that stopped
 * looking" failure mode, arriving as a test that proves nothing.
 */
export function renamePath(env: Record<string, string | undefined> = process.env): RenamePath {
  return env[RENAME_PATH_ENV] === LEGACY_PATH_VALUE ? 'legacy' : 'target'
}

/**
 * The commands that have moved. EXACTLY ONE, and the assertion in
 * `rename-shadow.test.ts` pins that — the acceptance criterion is that the legacy
 * path is unchanged for all OTHER commands, and a list that grew without a test
 * noticing is how "one low-risk command" becomes a broad migration nobody signed
 * off on.
 */
export const MIGRATED_COMMANDS: readonly string[] = ['sessions.rename']

/**
 * THE WHOLE DISPATCH, so the router reaches into state ONCE.
 *
 * The two paths need the same three things (the sessions service, the session
 * store, a clock), and building them at the call site meant `router.ts` reaching
 * through `mods(ctx)` / `ctx.registry.sessionStore` five separate times. POD-314's
 * deletion ratchet counts exactly that pattern and it GREW — correctly, the rewrite
 * may not add to the debt it is deleting.
 *
 * So the wiring lives here, beside the flag it belongs to, and the router hands in
 * one already-resolved bundle. That is the replacement seam the ratchet is pointing
 * at, not a way around it: `router.ts` now names the state once for this command
 * instead of once per dependency.
 */
export interface RenameDispatchDeps {
  sessions: RenameServices
  /** THE composition root's mutation ledger — both envelopes share this one
   *  instance, so a replay is seen once no matter which path served the original. */
  mutations: MutationLedgerPort
  /** The target path's principal — the real one, chain already resolved. */
  principal: CommandPrincipal
  /** The legacy path's principal. Different type, deliberately: see rename-target-path.ts. */
  legacyPrincipal: SessionStatePrincipal
  /**
   * The legacy envelope, as a THUNK.
   *
   * Built by the caller rather than here because `SessionStateRegistry` needs the
   * session store and this module has no business reaching for it — and lazily
   * because the target path is the default, so the rollback envelope must not be
   * constructed on every rename just to be discarded.
   */
  legacyRegistry: () => SessionStateRegistry
}

/**
 * Route one rename. Returns nothing: BOTH paths are `void` at the tRPC boundary,
 * which is §3.1.5's consistent-error rule — surfacing the target path's richer
 * outcome to this transport would make a denial distinguishable from a not-found.
 */
export function dispatchRename(deps: RenameDispatchDeps, input: unknown): void {
  const { sessions, mutations } = deps
  if (renamePath() === 'legacy') {
    deps.legacyRegistry().execute('sessions.rename', input, deps.legacyPrincipal, 'trpc')
    return
  }
  renameOnTargetPath({ sessions, mutations }, input, deps.principal, 'trpc')
}
