/**
 * THE `use`-VERB CHECK POINT for handoff — POD-642, readiness §3.1.4 / ADR 3
 * Amendment 1 D18.
 *
 * ===========================================================================
 * THIS FILE USED TO CONTAIN A POLICY. NOW IT CONTAINS ONE CALL.
 * ===========================================================================
 *
 * While POD-381 was in flight this module carried a stand-in: an admin-only
 * backing plus a `grantedMachineUse` shaped like the grant table POD-1079 will
 * land, so the denial paths this issue must prove were testable before the shared
 * resolver existed. Both are DELETED. `apps/server/src/machine-access.ts` is now
 * on the branch and it is the one answer:
 *
 *   `checkMachineUse(principal, machineId, ownership)` →
 *       `'absent' | 'unauthorized' | undefined`
 *
 * Two rules that were mine to state and are now THEIRS to enforce, kept here as
 * the reason this file is a call and not a copy:
 *
 *   - `absent` covers a machine that does not exist AND one the principal cannot
 *     `see`, with one message, so the handoff path is not a fleet-enumeration
 *     oracle (§3.1.5's consistent-error rule applied to machines);
 *   - `unauthorized` is reachable only INSIDE the see set, which is what keeps
 *     "denied" distinguishable from "offline" for a machine the principal can see
 *     (§3.1.4 M5). The two rules pull in opposite directions and the shared
 *     resolver is where that tension is settled once.
 *
 * THE LOCAL SENTINEL IS NOT EXEMPTED, and this is the second time that mattered.
 * `machine-access.ts` resolves `local` / `__local__` to a SYNTHESIZED row owned by
 * the instance owner, so the sentinels run through the ordinary rules; POD-381
 * found that after an exemption-shaped fix broke 24 oracle tests. My own first cut
 * hit the same class from the other side — it asked whether the machineId was in
 * the machine list, which refused a handoff FROM the local machine on installs
 * whose `local` row is written lazily. The generalisation, and the reason there is
 * no existence question left in this file: A RIGHTS GATE THAT ALSO ANSWERS
 * EXISTENCE GETS ONE OF THE TWO QUESTIONS WRONG. Existence and reachability are
 * the choreography's answers (`target machine is offline`); this gate answers only
 * "may this caller use it".
 */

import type { Capability, SessionId } from '@podium/model'
import { type CommandPrincipal, resolvePrincipal } from '../../../command-principal'
import {
  checkMachineUse,
  machineAccessMessage,
  type MachineOwnershipIndex,
} from '../../../machine-access'
import type { AssertMachineUse } from './ports'

/**
 * The gate, over a principal and an ownership index — both resolved by the
 * caller, neither captured here.
 *
 * A FACTORY, and the closure re-reads on every call, because the coordinator
 * calls the gate again at each apply point: before the irreversible kill and
 * again before the import leg. A gate that answered from a captured decision
 * would turn ADR 3 D8's apply-time re-authorization into a replay of one
 * dispatch-time answer, which is exactly the rights snapshot D16 forbids.
 */
export const machineUseGateFor = (deps: {
  principal: CommandPrincipal
  ownership: MachineOwnershipIndex
}): AssertMachineUse => {
  return (machineId: string) => {
    const failure = checkMachineUse(deps.principal, machineId, deps.ownership)
    if (!failure) return
    throw new Error(
      machineAccessMessage(failure, machineId, deps.ownership.rowFor(machineId)?.name),
    )
  }
}

/**
 * The same gate from a transport capability — the shape the composition root
 * uses. `delegations` is POD-381's index: it walks `spawnedBy` from live rows, so
 * an agent's chain roots at exactly one human and a sub-agent cannot carry a
 * delegator its parent lacks (D16.2). Nothing is read from payload.
 */
export const machineUseGateForCapability = (deps: {
  capability: Capability
  parentSessionOf: (sessionId: SessionId) => SessionId | undefined
  ownership: MachineOwnershipIndex
}): AssertMachineUse =>
  machineUseGateFor({
    principal: resolvePrincipal(deps.capability, { parentSessionOf: deps.parentSessionOf }),
    ownership: deps.ownership,
  })
