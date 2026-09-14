import type { Principal } from '@podium/sync'
import type { WriteFunnel } from './funnel'
import type { SessionLifecycle } from './sessions/lifecycle'

/** Compile-only contract: a new sync reader must name its principal.
 * Checked by the server tsconfig's src include; never invoked at runtime.
 * Restoring any permissive default makes its @ts-expect-error unused (TS2578).
 */
export function syncReadPrincipalContract(
  funnel: WriteFunnel,
  sessions: SessionLifecycle,
  principal: Principal,
): void {
  void funnel.changesSince(null, principal)
  void funnel.snapshot(principal)
  void sessions.syncChangesSince(null, principal)

  // @ts-expect-error WriteFunnel.changesSince requires a principal.
  void funnel.changesSince(null)
  // @ts-expect-error WriteFunnel.snapshot requires a principal.
  void funnel.snapshot()
  // @ts-expect-error SessionLifecycle.syncChangesSince requires a principal.
  void sessions.syncChangesSince(null)

  // @ts-expect-error An explicit undefined must not select an unrestricted read.
  void funnel.changesSince(null, undefined)
  // @ts-expect-error An explicit undefined must not select an unrestricted read.
  void funnel.snapshot(undefined)
  // @ts-expect-error An explicit undefined must not select an unrestricted read.
  void sessions.syncChangesSince(null, undefined)
}
