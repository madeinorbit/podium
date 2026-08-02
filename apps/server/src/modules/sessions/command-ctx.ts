/**
 * The composition root for session commands: turn a transport's authenticated
 * capability into a {@link SessionCommandCtx}.
 *
 * Split out of `commands.ts` so the contracts stay a pure table over ports and
 * do not import the whole module graph — and so both transports build the
 * context the SAME way. A transport that built its own principal would be a
 * second answer to "who is calling", which is the failure D7 exists to prevent.
 */

import type { TransportTag } from '@podium/commands'
import type { Capability } from '@podium/model'
import { type CommandPrincipal, resolvePrincipal } from '../../command-principal'
import {
  canSeeMachine,
  type MachineOwnershipIndex,
  machineUseDecision,
  ownershipFromMachines,
} from '../../machine-access'
import { sessionSpawnerParentId } from '../../steward'
import type { RegistryModules } from '../../relay'
import {
  SessionCommandCtx,
  type SessionCommandDeps,
  type SessionCommandServices,
} from './command-plane'

/** Explicit L3 command service: core session capabilities plus atomic issue workflows. */
export function sessionCommandServices(modules: RegistryModules): SessionCommandServices {
  const sessions = modules.sessions
  const issueSessions = modules.issueSessionLifecycle
  return {
    createSession: sessions.createSession.bind(sessions),
    workspace: sessions.workspace,
    killSession: sessions.killSession.bind(sessions),
    hibernateSession: sessions.hibernateSession.bind(sessions),
    answerAskUserQuestion: sessions.answerAskUserQuestion,
    continueSession: sessions.continueSession.bind(sessions),
    listSessions: sessions.listSessions.bind(sessions),
    resumeSession: issueSessions.resumeSession.bind(issueSessions),
    resurrectSession: issueSessions.resurrectSession.bind(issueSessions),
    stopSession: issueSessions.stopSession.bind(issueSessions),
  }
}
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
  /**
   * Which transport is asking. Load-bearing, not decoration: the mail port below
   * runs ADR 3 D3's default-closed exposure check with it, so a transport that
   * `mail.send` does not name cannot reach delivery through the chat path
   * either. Defaults to the relay — the narrower of the two, so a caller that
   * forgets to say gets the stricter answer rather than the looser one.
   */
  transport: TransportTag = 'relay',
): SessionCommandCtx {
  const sessions = modules.sessions
  const issues = modules.issues
  const commandSessions = sessionCommandServices(modules)
  const principal = resolvePrincipal(capability, {
    // One parser for the `session:<id>` tag, and it brands what it extracts
    // (POD-362) — see sessionSpawnerParentId for why the TAG stays raw.
    parentSessionOf: (sessionId) =>
      sessionSpawnerParentId(
        sessions.listSessions().find((s) => s.sessionId === sessionId)?.spawnedBy,
      ),
    onBehalfOfFor: (sessionId) => sessions.sessionOwner(sessionId)?.owner ?? undefined,
  })
  const deps: SessionCommandDeps = {
    sessions: () => commandSessions,
    // THE CHAT PATHS' SEND, as a dispatch of the `mail.send` contract (POD-729).
    //
    // The capability is closed over HERE, at the composition root, so no handler
    // takes a principal as an argument and none can invent one — the same rule
    // the rest of this function follows. `immediate` is the delivery mode, set
    // by the server: `mailSendInput` has no field for it, so a client cannot ask
    // a send not to be confirmed. See MailDeliveryMode for why the chat path
    // needs it (POD-379 pins `disposition: 'queued'`; blocking would say
    // `accepted`).
    //
    // The non-null assertion is safe by the same argument the router's makes: a
    // `undefined` here would mean `mail.send` does not name this transport, and
    // both transports that build this context are in its exposure set.
    mailSend: (input) =>
      modules.messageGate.dispatch(
        capability,
        overrideScope,
        'send',
        input,
        transport,
        'immediate',
      )!,
    createDraftIssue: (repoPath, agentKind, issueId, ownership) =>
      issues.createDraftFor(repoPath, agentKind, issueId, ownership),
    issueOwner: (issueId) => issues.ownedTarget(issueId, 'read')?.owner ?? undefined,
    access: {
      listSessions: () => sessions.listSessions(),
      issues,
      // POD-1075 supplies the owner/grant answer; today one account sees all.
    },
    rpc: () => modules.rpc,
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
  modules: Pick<RegistryModules, 'machines'>,
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
  modules: Pick<RegistryModules, 'machines'>,
  principal: CommandPrincipal,
  ownership: MachineOwnershipIndex = ownershipFromMachines(modules.machines),
): ReturnType<RegistryModules['machines']['listMachines']> {
  return modules.machines
    .listMachines((machineId) => machineUseDecision(principal, machineId, ownership))
    .filter((machine) => canSeeMachine(principal, machine.id, ownership))
}
