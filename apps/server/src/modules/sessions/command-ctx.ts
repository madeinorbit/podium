/**
 * The composition root for session commands: turn a transport's authenticated
 * capability into a {@link SessionCommandCtx}.
 *
 * Split out of `commands.ts` so the contracts stay a pure table over ports and
 * do not import the whole module graph — and so both transports build the
 * context the SAME way. A transport that built its own principal would be a
 * second answer to "who is calling", which is the failure D7 exists to prevent.
 */

import { randomUUID } from 'node:crypto'
import type { TransportTag } from '@podium/commands'
import type {
  Capability,
  MachineId,
  MachineUseDecision,
  SessionDesired,
  SessionId,
} from '@podium/model'
import { asMutationId, asSessionId, mintDeviceId, spawnedByParentSessionId } from '@podium/model'
import type { SyncSubmitRefusal, SyncSubmitReply } from '@podium/protocol'
import {
  attributionOf,
  type CommandPrincipal,
  onBehalfOfUser,
  resolvePrincipal,
  resolvePrincipalAsync,
} from '../../command-principal'
import {
  canManageMachineCustody,
  canSeeMachine,
  isMachineOwner,
  type MachineOwnershipIndex,
  machineUseDecision,
  machineVerbsFor,
  ownershipSnapshotFromMachines,
} from '../../machine-access'
import type { RegistryModules } from '../../relay'
import { answerThroughEffect, settledResult } from '../interactions/answer-effect'
import {
  type LifecycleEditsPort,
  SessionCommandCtx,
  type SessionCommandDeps,
  type SessionCommandServices,
} from './command-plane'
import type { SessionWriter } from './lifecycle'
import type { LifecycleOutcome, ReconcileResult } from './lifecycle-controller'
import { asyncSessionIssueAccess } from './session-access'
import { configureThroughEffect } from './session-configure-effect'
import { interruptThroughEffect } from './session-interrupt-effect'
import {
  createThroughLaunchEffect,
  resumeThroughLaunchEffect,
  SESSION_LAUNCH_KIND,
} from './session-launch-effect'

/** Explicit L3 command service: core session capabilities plus atomic issue workflows. */
export function sessionCommandServices(modules: RegistryModules): SessionCommandServices {
  const sessions = modules.sessions
  const issueSessions = modules.issueSessionLifecycle
  return {
    createSession: sessions.createSession.bind(sessions),
    workspace: sessions.workspace,
    // The direct kill of the plane's hand-built contexts (`command-plane.ts`);
    // the routes kill through `records.session.remove`.
    killSession: (input) => sessions.killSession(sessions.serverWriter, input),
    hibernateSession: sessions.hibernateSession.bind(sessions),
    interruptTurn: sessions.interruptTurn,
    configureSession: sessions.configureSession,
    answerAskUserQuestion: sessions.answerAskUserQuestion,
    continueSession: sessions.continueSession.bind(sessions),
    explicitWakeSelection: sessions.explicitWakeSelection.bind(sessions),
    sessionById: sessions.sessionById.bind(sessions),
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
export async function sessionCommandCtx(
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
  /**
   * THE WRITER OF THE COMMAND THIS CONTEXT SERVES (ADR 12 D9, POD-6601): the
   * sync handler's own, or the named origin of the run that acts for it (a
   * launch). The issue rows a session command writes (a claimed upload, a
   * start's draft) and a send's wake record are written with it. A context
   * built for reads, or for a route that writes through `submit`, has none,
   * and refuses such a write.
   */
  writer?: SessionWriter,
): Promise<SessionCommandCtx> {
  const writerFor = (what: string): SessionWriter => {
    if (writer === undefined) throw new Error(`${what}: this command context has no writer`)
    return writer
  }
  const sessions = modules.sessions
  const issues = modules.issues
  const commandSessions = sessionCommandServices(modules)
  const principal = await resolvePrincipalAsync(capability, {
    // The ONE reader of the `session:<id>` tag, in `@podium/model` alongside
    // the one writer (POD-1133). It brands what it extracts, so `parentSessionOf`
    // hands back a `SessionId` with no cast here.
    parentSessionOf: async (sessionId) =>
      // POD-1646: the narrow read. Authorization runs on essentially every
      // request, so the full reader-scoped pass this used to build was pure
      // waste — `sessionSpawnedBy` reads the one field under the same check.
      spawnedByParentSessionId(await sessions.sessionSpawnedBy(sessionId)),
    onBehalfOfFor: async (sessionId) =>
      (await sessions.sessionOwner(sessionId))?.owner ?? undefined,
  })
  const deps: SessionCommandDeps = {
    sessions: () => commandSessions,
    stageAttachment: async (input) => await sessions.runtimeGateway.stageAttachment(input),
    holdUpload: async (input) => await modules.pendingUploads.put(input),
    claimUpload: async (issueId, input) =>
      await issues.crud.panelChatUploadClaim(writerFor('claimUpload'), issueId, input),
    isAgentDriven: async (sessionId) => await sessions.receiptSender.onContract(sessionId),
    // THE CHAT PATHS' SEND, as a dispatch of the `mail.send` contract (POD-729).
    //
    // The capability is closed over HERE, at the composition root, so no handler
    // takes a principal as an argument and none can invent one — the same rule
    // the rest of this function follows. The send answers at once for every
    // session: it never waits on the agent's turn [POD-4661], so a Stop or the
    // next message right behind it is never queued behind a delivery poll.
    //
    // The non-null assertion is safe by the same argument the router's makes: a
    // `undefined` here would mean `mail.send` does not name this transport, and
    // both transports that build this context are in its exposure set.
    mailSend: async (input) =>
      (await modules.messageGate.dispatch(capability, overrideScope, 'send', input, transport))!,
    createDraftIssue: async (repoPath, agentKind, issueId, ownership) =>
      await issues.attention.createDraftFor(
        writerFor('createDraftIssue'),
        repoPath,
        agentKind,
        issueId,
        ownership,
      ),
    attachDraftArtifacts: async (issueId, artifacts) => {
      for (const artifact of artifacts) {
        await issues.crud.panelArtifactUpload(writerFor('attachDraftArtifacts'), issueId, artifact)
      }
    },
    discardUnlaunchedDraft: async (issueId) =>
      await issues.attention.discardUnlaunchedDraft(issueId),
    issueOwner: async (issueId) =>
      (await issues.reports.ownedTarget(issueId, 'read'))?.owner ?? undefined,
    access: {
      sessionById: async (sessionId) => await sessions.sessionById(sessionId),
      // Unambiguous prefix only (POD-4536) — ids by a range read on the primary
      // key, never the full projection. Consulted only after an exact miss.
      sessionIdsWithPrefix: async (prefix) =>
        (await sessions.readSessionFactsByIdPrefix(prefix)).map((s) => s.sessionId),
      issues: asyncSessionIssueAccess(issues),
      // POD-1075 supplies the owner/grant answer; today one account sees all.
    },
    rpc: () => modules.rpc,
    ownership: await ownershipSnapshotFromMachines(modules.machines),
    // THE composition root's ledger (POD-382), never a fresh one: two ledgers over
    // one durable table have two in-flight maps, and a replay arriving on the other
    // transport while the original is still running would apply twice.
    mutations: modules.mutations,
    // The lifecycle routes onto `records.session.*` (POD-6356). Their
    // contracts are operator-only (tRPC and the in-process MCP; never the
    // relay), and `records.session.*` is served over tRPC, so the envelope is
    // submitted as a tRPC call. Absent in a hand-built module set.
    ...(modules.sessionLifecycleController
      ? { lifecycleEdits: lifecycleEditsFor(modules, principal, overrideScope, writer) }
      : {}),
  }
  return new SessionCommandCtx(deps, principal, overrideScope)
}

/** One route call as one envelope: a fresh id, because the route's own
 *  mutationId (if any) is already held by its dedup envelope around this call. */
const routeMutationId = () => asMutationId(`mut_route_${randomUUID()}`)

/** How often a lifecycle route re-reads the revision after a concurrent edit. */
const REVISION_ATTEMPTS = 3

/** The lifecycle primitives' pinned not-found answer (POD-379). */
const UNKNOWN_SESSION: LifecycleOutcome = { ok: false, reason: 'unknown session' }

/** A refused lifecycle edit, in the routes' `{ ok, reason }` shape. */
function refusedEdit(refusal: SyncSubmitRefusal): LifecycleOutcome & { reason: string } {
  switch (refusal.kind) {
    // The route's own gate passed a moment ago; a refusal now means the session
    // went away or out of reach meanwhile, which reads as an unknown one.
    case 'unauthorized':
    case 'target-not-found':
      return { ok: false, reason: 'unknown session' }
    case 'conflict':
      return { ok: false, reason: 'the session kept changing; try again' }
    case 'confirmation-required':
      return { ok: false, reason: 'outside your scope; re-run with --outside-scope to confirm' }
    case 'invalid':
      return { ok: false, reason: refusal.message ?? 'invalid lifecycle edit' }
  }
}

/**
 * THE ROUTE'S ANSWER WHEN THE CONTROLLER TOOK NO ACTION for this edit. The edit
 * is committed either way; what the route says is what the record now shows.
 *
 *  - Already so (the pass acknowledged without acting): a hibernate of a
 *    session that is not running keeps the refusal it always had (POD-379);
 *    a resume of a running one is the idempotent `ok` `resurrectSession` gives.
 *  - Waiting for its machine: accepted, and done when the daemon attaches
 *    (ADR 12 D5 E1: "if the daemon is offline, nothing is lost").
 *  - A transient failure: the session stays pending for the next trigger.
 *
 * Never a service call: the controller is the only thing that acts.
 */
function answerWithoutAction(desired: SessionDesired, pass: ReconcileResult): LifecycleOutcome {
  if (pass.kind === 'waiting') {
    return pass.why === 'offline'
      ? {
          ok: true,
          pending: true,
          reason: 'its machine is offline; this happens when it reconnects',
        }
      : {
          ok: false,
          pending: true,
          reason:
            'the session could not be reached; this is tried again when its machine reconnects',
        }
  }
  return desired === 'hibernated' ? { ok: false, reason: 'not running' } : { ok: true }
}

/** The lifecycle edits as `principal` (`records.session` on the entry point):
 *  for the routes here, and `cloud.moveSession`'s local hibernate (POD-6417). */
export function lifecycleEditsFor(
  modules: RegistryModules,
  principal: CommandPrincipal,
  overrideScope: boolean | undefined,
  /** The send's own writer, for the wake record it creates in its unit. */
  writer?: SessionWriter,
): LifecycleEditsPort {
  const controller = modules.sessionLifecycleController
  const submit = async (command: string, input: unknown) =>
    (
      await modules.syncWrite.submitDetailed(
        {
          mutationId: routeMutationId(),
          command,
          version: 1,
          input,
          ...(overrideScope === true ? { confirmed: true as const } : {}),
        },
        principal,
        'trpc',
      )
    ).reply
  /**
   * Submit `command` against the record's current revision. A `conflict` means a
   * newer edit landed between the read and the submit; the route asks again, as
   * the app's outbox does, a bounded number of times.
   */
  const submitAtRevision = async (
    sessionId: SessionId,
    command: string,
    input: (revision: number) => Record<string, unknown>,
  ): Promise<SyncSubmitReply | undefined> => {
    let reply: SyncSubmitReply | undefined
    for (let attempt = 0; attempt < REVISION_ATTEMPTS; attempt++) {
      const state = await modules.sessions.desiredStateOf(sessionId)
      if (!state) return undefined
      reply = await submit(command, input(state.lifecycle.revision))
      if (reply.outcome === 'applied' || reply.refusal.kind !== 'conflict') return reply
    }
    return reply
  }
  return {
    desire: async (sessionId, desired, force) => {
      const reply = await submitAtRevision(sessionId, 'records.session.edit', (revision) => ({
        id: sessionId,
        patch: { desired, ...(force ? { force: true } : {}) },
        expectedRevision: revision,
      }))
      if (reply === undefined) return UNKNOWN_SESSION
      if (reply.outcome !== 'applied') return refusedEdit(reply.refusal)
      const revision = (reply.result as { revision?: unknown } | null)?.revision
      if (typeof revision !== 'number') {
        throw new Error('records.session.edit answered without a revision')
      }
      // Joins the pass the commit already started, and waits for its action.
      const pass = await controller.reconcile(sessionId, { principal })
      return controller.outcomeFor(sessionId, revision) ?? answerWithoutAction(desired, pass)
    },
    kill: async (sessionId) => {
      const reply = await submitAtRevision(sessionId, 'records.session.remove', (revision) => ({
        id: sessionId,
        expectedRevision: revision,
      }))
      // No row: already gone, which is kill's pinned no-op.
      if (reply === undefined || reply.outcome === 'applied') return
      if (reply.refusal.kind === 'target-not-found') return
      throw new Error(refusedEdit(reply.refusal).reason)
    },
    // `sessions.create` as a `session.launch` effect record (POD-6398).
    create: async (input) => {
      if (modules.sessionLaunches === undefined) throw new Error('no session.launch executor')
      return await createThroughLaunchEffect(modules, principal, modules.sessionLaunches, input)
    },
    // `sessions.interrupt` as a `session.interrupt` effect record (POD-6397).
    interrupt: async (input) => {
      if (modules.sessionInterrupts === undefined) throw new Error('no session.interrupt executor')
      return await interruptThroughEffect(modules, principal, modules.sessionInterrupts, input)
    },
    // `sessions.configure` as a `session.configure` effect record (POD-6416).
    configure: async (input) => await configureThroughEffect(modules, principal, input),
    // `sessions.answerAskUserQuestion` as a `session.answer` record (POD-6415).
    answer: async ({ sessionId, interactionId, choices, skip }) => {
      const settled = await answerThroughEffect(
        modules,
        principal,
        { kind: 'session', id: sessionId },
        {
          via: 'menu',
          ...(interactionId !== undefined ? { interactionId } : {}),
          ...(choices !== undefined ? { choices: choices as Record<string, unknown>[] } : {}),
          ...(skip === true ? { skip: true } : {}),
        },
        overrideScope ? { confirmed: true } : {},
      )
      if (settled.kind === 'refused') return { ok: false }
      const answer = settledResult(settled)
      return 'result' in answer
        ? (answer.result as { ok: boolean; reason?: string })
        : { ok: false, reason: answer.message }
    },
    // `sessions.resume` as a `session.launch` record with a resume ref (POD-6416).
    resume: async (input) => {
      if (modules.sessionLaunches === undefined) throw new Error('no session.launch executor')
      return await resumeThroughLaunchEffect(modules, principal, modules.sessionLaunches, input)
    },
    // A chat send's explicit wake (POD-6415): a `session.launch` resume record
    // created in the SEND's own unit of work, under a fresh target id; its run
    // lands on the parked row that holds the conversation and wakes it with
    // the caller's choice.
    wakeWith: async ({ session, wake }) => {
      const effects = modules.effects
      if (effects === undefined) throw new Error('no effects module is composed')
      if (writer === undefined) throw new Error('a wake is created in its send: no writer')
      await effects.createInUnit(writer, {
        id: mintDeviceId('eff_'),
        kind: SESSION_LAUNCH_KIND,
        target: { kind: 'session', id: randomUUID() },
        input: {
          agentKind: session.agentKind,
          cwd: session.cwd,
          resume: session.resume,
          conversationId: session.resume.value,
          ...(session.machineId !== undefined ? { machineId: session.machineId } : {}),
          wake,
        },
        createdBy: onBehalfOfUser(principal),
        actor: attributionOf(principal).actor,
      })
    },
  }
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
export async function visibleMachinesFor(
  modules: Pick<RegistryModules, 'machines'>,
  capability: Capability,
): Promise<Awaited<ReturnType<RegistryModules['machines']['listMachines']>>> {
  return await machinesForPrincipal(
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
export async function machinesForPrincipal(
  modules: Pick<RegistryModules, 'machines'>,
  principal: CommandPrincipal,
  ownership?: MachineOwnershipIndex,
): Promise<Awaited<ReturnType<RegistryModules['machines']['listMachines']>>> {
  const resolvedOwnership = ownership ?? (await ownershipSnapshotFromMachines(modules.machines))
  return (
    await modules.machines.listMachines(
      (machineId) => machineUseDecision(principal, machineId, resolvedOwnership),
      // Ownership stays a fact; custody permission is projected separately below.
      (machineId) => isMachineOwner(principal, machineId, resolvedOwnership),
    )
  )
    .filter((machine) => canSeeMachine(principal, machine.id, resolvedOwnership))
    .map((machine) => {
      const unowned = resolvedOwnership.rowFor(machine.id)?.owner === null
      // SEE includes identity, liveness, assignment and update/transport health.
      // Inventory (paths/provider identities) and harness installation history
      // require USE even when the viewer is an admin with MANAGE.
      const { inventory, harnessVersions, ...visible } = machine
      return {
        ...visible,
        ...(machine.use === 'granted' ? { inventory, harnessVersions } : {}),
        supersedable:
          !machine.supersededBy &&
          principal.kind !== 'system' &&
          principal.capability.role === 'admin' &&
          machineVerbsFor(principal, machine.id, resolvedOwnership).has('manage'),
        transferable:
          !machine.revokedAt && canManageMachineCustody(principal, machine.id, resolvedOwnership),
        unowned,
        adoptable:
          unowned &&
          principal.kind !== 'system' &&
          principal.capability.role === 'admin' &&
          machineVerbsFor(principal, machine.id, resolvedOwnership).has('manage'),
      }
    })
}

/** One registered checkout, as the fleet view reports it. */
export interface FleetRepoRow {
  machineId: MachineId
  path: string
}

/**
 * THE FLEET VIEW (POD-1386) — the machine projection plus the checkout paths that
 * make it ACTIONABLE, for `podium machine list`.
 *
 * An enumeration without repos cannot answer "which machine can take this work",
 * because work is placed into a checkout. But repo rows are stored unscoped —
 * `listRepos()` returns every row on every machine — so joining them naively
 * would disclose checkout paths on machines the caller cannot even see, a worse
 * leak than the gap this closes.
 *
 * The cut is `use`, not `see`, and it is the same line the model already draws
 * around `inventory`: both a machine's harnesses and its checkouts answer "what
 * can I run on your hardware, and as whom" (readiness §3.1.4 M2), which is a
 * code-execution question. A principal with `see` alone learns that the machine
 * exists and whether it is alive — and nothing about what is on it.
 *
 * SEPARATE FROM THE PROJECTION, ON PURPOSE. `machines` here IS
 * `visibleMachinesFor`'s output, unmodified: this function adds a join, never a
 * second scoping rule. Widen the projection and this follows; fork it and the two
 * drift with nobody watching.
 */
export async function fleetViewFor(
  modules: Pick<RegistryModules, 'machines'>,
  capability: Capability,
  allRepos: FleetRepoRow[],
): Promise<{
  machines: Awaited<ReturnType<RegistryModules['machines']['listMachines']>>
  repos: FleetRepoRow[]
}> {
  const machines = await visibleMachinesFor(modules, capability)
  return { machines, repos: usableRepos(machines, allRepos) }
}

/**
 * The join itself, over an ALREADY-PROJECTED machine list.
 *
 * Split out from {@link fleetViewFor} so the rule can be tested against a list
 * containing all three cases at once — usable, see-only, invisible — which is the
 * only way to watch it REFUSE. Given a projection that already dropped the
 * invisible machines, a filter that merely echoed its input would look correct
 * against a one-machine fixture and would be a no-op disclosure bug against a
 * real fleet.
 */
export function usableRepos(
  machines: { id: MachineId; use?: MachineUseDecision }[],
  allRepos: FleetRepoRow[],
): FleetRepoRow[] {
  const usable = new Set(
    machines.filter((machine) => machine.use === 'granted').map((machine) => machine.id),
  )
  return allRepos
    .filter((repo) => usable.has(repo.machineId))
    .map((repo) => ({ machineId: repo.machineId, path: repo.path }))
}
