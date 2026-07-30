/**
 * The composition root for session commands: turn a transport's authenticated
 * capability into a {@link SessionCommandCtx}.
 *
 * Split out of `commands.ts` so the contracts stay a pure table over ports and
 * do not import the whole module graph — and so both transports build the
 * context the SAME way. A transport that built its own principal would be a
 * second answer to "who is calling", which is the failure D7 exists to prevent.
 */

import type { Capability } from '@podium/model'
import { type CommandPrincipal, resolvePrincipal } from '../../command-principal'
import {
  canSeeMachine,
  machineUseDecision,
  type MachineOwnershipIndex,
  ownershipFromMachines,
} from '../../machine-access'
import type { RegistryModules } from '../../relay'
import { SessionCommandCtx, type SessionCommandDeps } from './command-plane'

/**
 * Build the per-call context.
 *
 * The delegation index reads `spawnedBy` — today's agent-ancestry provenance —
 * so a sub-agent's chain is walked from live rows rather than from anything the
 * caller supplied. `onBehalfOfFor` is absent until POD-1075 lands accounts, so
 * every chain roots at the instance's one human.
 */
export function sessionCommandCtx(
  modules: RegistryModules,
  capability: Capability,
  overrideScope?: boolean,
): SessionCommandCtx {
  const sessions = modules.sessions
  const issues = modules.issues
  const principal = resolvePrincipal(capability, {
    parentSessionOf: (sessionId) => {
      const spawnedBy = sessions.listSessions().find((s) => s.sessionId === sessionId)?.spawnedBy
      return spawnedBy?.startsWith('session:') === true ? spawnedBy.slice('session:'.length) : undefined
    },
  })
  const deps: SessionCommandDeps = {
    sessions: () => sessions,
    messages: () => modules.messages,
    createDraftIssue: (repoPath, agentKind, issueId) =>
      issues.createDraftFor(repoPath, agentKind, issueId),
    access: {
      listSessions: () => sessions.listSessions(),
      issues,
      // POD-1075 supplies the owner/grant answer; today one account sees all.
    },
    ownership: ownershipFromMachines(modules.machines),
    // THE composition root's ledger (POD-382), never a fresh one: two ledgers over
    // one durable table have two in-flight maps, and a replay arriving on the other
    // transport while the original is still running would apply twice.
    mutations: modules.mutations,
  }
  return new SessionCommandCtx(deps, principal, overrideScope)
}

/**
 * The fleet as ONE principal may see it, with its `use` decision attached —
 * readiness §3.1.4 M5's "the spawn surface must not OFFER a machine the
 * principal lacks `use` on", applied where the offer is actually made.
 *
 * Two different operations, and collapsing them would be the M2 mistake:
 *  - machines the principal cannot SEE are FILTERED OUT, because for them the
 *    machine does not exist (D18.5 / D20);
 *  - machines it can see carry `use`, so the client's existing predicate
 *    (`agentCapabilityRejection`, which checks the denial FIRST, before
 *    liveness) refuses them with a reason that is not "offline".
 *
 * Today's single-account default sees everything and uses everything, so this is
 * behaviour-preserving; it is the seam POD-1079 fills, not a new policy.
 */
export function visibleMachinesFor(
  modules: RegistryModules,
  capability: Capability,
): ReturnType<RegistryModules['machines']['listMachines']> {
  return machinesForPrincipal(
    modules,
    resolvePrincipal(capability, { parentSessionOf: () => undefined }),
  )
}

/**
 * The same projection, for a principal that is already resolved.
 *
 * Exported because the capability-taking wrapper above cannot express a second
 * human before POD-1075 lands accounts — every capability resolves to the one
 * account — so it is the only way to TEST the scoping rather than merely ship
 * it. The router uses the wrapper; the wrapper is one line over this.
 */
export function machinesForPrincipal(
  modules: RegistryModules,
  principal: CommandPrincipal,
  ownership: MachineOwnershipIndex = ownershipFromMachines(modules.machines),
): ReturnType<RegistryModules['machines']['listMachines']> {
  return modules.machines
    .listMachines((machineId) => machineUseDecision(principal, machineId, ownership))
    .filter((machine) => canSeeMachine(principal, machine.id, ownership))
}
