/**
 * The assembled strategy set — the composition root's one call.
 *
 * TOTALITY IS THE POINT. Every `(role, credentialKind)` pair the envelope can
 * express gets an entry, because a MISSING entry and a REFUSING entry fail
 * differently: a missing one falls through to a generic "unsupported credential"
 * that reads like an accident, and it is the shape in which a new credential kind
 * silently arrives unhandled. `registry.test.ts` pins the matrix.
 *
 * A port that is not wired yet produces an explicit REFUSING strategy naming the
 * missing port, not a gap. That is how the console cookie strategy behaves in
 * production until POD-1075 lands per-user client sessions: refused, loudly, in
 * the server log — never resolved to an ambient operator.
 */

import type { PeerCredential } from '../envelope'
import { createAgentRelayStrategy } from './agent-relay-delegation'
import { createConsoleCookieStrategy } from './console-cookie'
import { createMachineLocalSecretStrategy } from './machine-local-secret'
import { createMachinePairCodeStrategy } from './machine-pair-code'
import { createMachineTokenStrategy } from './machine-token'
import { createNodeReservedStrategy } from './node-reserved'
import { createOperatorChannelStrategy } from './operator-channel'
import { type AuthStrategyRegistry, createAuthStrategyRegistry } from './registry'
import { createSystemStrategy } from './system'
import type { AuthOutcome, PeerAuthStrategy, StrategyPorts } from './types'

/** A registered refusal for a role whose port this deployment has not wired. */
export const unavailableStrategy = (
  role: PeerAuthStrategy['role'],
  credentialKind: PeerCredential['kind'],
  missingPort: string,
  // biome-ignore lint/suspicious/noExplicitAny: a refuser is credential-agnostic.
): PeerAuthStrategy<any> => ({
  role,
  credentialKind,
  name: `unavailable(${role}/${credentialKind})`,
  authenticate(): AuthOutcome {
    return {
      ok: false,
      reason: 'auth-failed',
      diagnostic: `no ${missingPort} port is wired in this deployment — refusing rather than resolving an ambient identity`,
    }
  },
})

export const createDefaultAuthRegistry = (ports: StrategyPorts): AuthStrategyRegistry =>
  createAuthStrategyRegistry([
    // console — ADR 5 D5 row 1
    ports.clientSessions === undefined
      ? unavailableStrategy('console', 'sessionCookie', 'ClientSessionDirectory (POD-1075)')
      : createConsoleCookieStrategy({ clientSessions: ports.clientSessions, mint: ports.mint }),
    // machine — ADR 5 D5 rows 2 and 3
    ports.machines === undefined
      ? unavailableStrategy('machine', 'daemonSecret', 'MachineDirectory')
      : createMachineLocalSecretStrategy({ machines: ports.machines, mint: ports.mint }),
    ports.machines === undefined
      ? unavailableStrategy('machine', 'pairCode', 'MachineDirectory')
      : createMachinePairCodeStrategy({ machines: ports.machines, mint: ports.mint }),
    ports.machines === undefined
      ? unavailableStrategy('machine', 'machineToken', 'MachineDirectory')
      : createMachineTokenStrategy({ machines: ports.machines, mint: ports.mint }),
    // node — ADR 5 D5 row 4: reserved, inert, refuses
    createNodeReservedStrategy(),
    // agent relay — ADR 3 Am.1 D14, NOT a peer role (ADR 5 D7 keeps them apart)
    ports.delegations === undefined
      ? unavailableStrategy('agent-relay', 'delegationRef', 'DelegationDirectory')
      : createAgentRelayStrategy({ delegations: ports.delegations, mint: ports.mint }),
    // operator channel — ADR 3 Am.1 D14 row 2
    ports.clientSessions === undefined
      ? unavailableStrategy('operator-channel', 'operatorChannel', 'ClientSessionDirectory')
      : createOperatorChannelStrategy({
          clientSessions: ports.clientSessions,
          mint: ports.mint,
          ...(ports.boundUser === undefined ? {} : { boundUser: ports.boundUser }),
        }),
    // system — in-process only (D21.2); registered so the matrix is total
    createSystemStrategy(),
  ])
