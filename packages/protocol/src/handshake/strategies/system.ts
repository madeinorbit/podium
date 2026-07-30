/**
 * SYSTEM — the steward, expiry jobs, boot reconcile, derived-field maintenance.
 * ADR 3 Amendment 1 D21, readiness §3.1.6 S5.
 *
 * What authenticates it: IN-PROCESS CONSTRUCTION, and nothing else. D21.2 is
 * explicit that a system principal "is constructed in-process only … and
 * therefore cannot be reached, impersonated or borrowed from any transport".
 *
 * A NOTE ON A TENSION, resolved from the ADR (POD-388 brief §6 says "if any of
 * them arrive over a peer connection, the strategy resolves them as SYSTEM"; D21.2
 * says they cannot arrive over a connection at all). The ADR wins: a system
 * credential presented over a socket is REFUSED, because accepting one would make
 * the system class impersonable — the precise property D21 exists to guarantee.
 * The brief's substance is preserved: when a system job does reach this strategy,
 * in process, it resolves as `system` with NO on-behalf-of, and every write it
 * makes is attributed as system (D17.5). There is no credential material for a
 * peer to steal because there is no credential.
 *
 * What it may then address: reads may cross owners; every write is attributed as
 * `system` and lands in the scope of whatever it acted on, widening nobody's
 * visibility and never acting AS a person (D21.1). That is the command layer's
 * enforcement; here the only obligation is that `onBehalfOf` is `null` and can
 * never be anything else — see `attributionOf` in `../../planes/principal.ts`.
 *
 * What it is refused: any transport at all, and any attempt to give it a user.
 */

import type { SystemPrincipal } from '../../planes/principal'
import type { AuthInput, AuthOutcome, PeerAuthStrategy } from './types'
import type { PeerCredential } from '../envelope'

/**
 * The named system jobs. A closed list, so a new instance-wide job is a decision
 * someone makes on purpose rather than a string someone passes.
 */
export const SYSTEM_JOBS = [
  'steward',
  'expiry',
  'boot-reconcile',
  'derived-fields',
  'migration',
] as const
export type SystemJob = (typeof SYSTEM_JOBS)[number]

/**
 * Construct a system principal. The ONLY way to get one, and it is not reachable
 * from a frame: nothing in the handshake path calls it.
 */
export const systemPrincipal = (job: SystemJob): SystemPrincipal => ({ kind: 'system', job })

/**
 * Registered so the registry is TOTAL over `AuthRole` — a role with no strategy
 * would fall through to whatever the acceptor does with an unknown role, and
 * "unknown" is a worse answer here than an explicit refusal. It refuses every
 * transport, which is the whole content of D21.2.
 */
export const createSystemStrategy = (): PeerAuthStrategy<
  Extract<PeerCredential, { kind: 'operatorChannel' }>
> => ({
  role: 'system',
  // No credential kind of its own exists on the wire, on purpose. The key is
  // unreachable in practice because the acceptor never resolves the `system`
  // role from an endpoint or a `peerRole` (both are ADR 5 D2 peer roles only).
  credentialKind: 'operatorChannel',
  name: 'system-in-process-only',
  authenticate(_input: AuthInput<Extract<PeerCredential, { kind: 'operatorChannel' }>>): AuthOutcome {
    return {
      ok: false,
      reason: 'auth-failed',
      diagnostic:
        'system principals are constructed in-process only (ADR 3 Amendment 1 D21.2) and are not reachable from any transport',
    }
  },
})
