/**
 * STARTING A SESSION (POD-1396, from POD-1385's god-object audit).
 *
 * Two entry points and one job: turn a request for a session into a live
 * `Session` object and the daemon frame that starts it.
 *
 *   create()  resolves the REQUEST — harness, model validity, curated name,
 *             issue attachment, owner, machine — then calls spawn().
 *   spawn()   mints the session, persists it, fences its observation lease and
 *             sends the daemon its `spawn` frame.
 *
 * They are one module rather than two because `create` is `spawn` plus the
 * resolution that precedes it: splitting them puts a call across a boundary and
 * leaves `spawn` — which is not independently meaningful — alone on one side.
 *
 * `spawn` is public because it has a SECOND caller: the resume path re-spawns a
 * parked session with an already-resolved request, and must not re-run
 * resolution.
 *
 * ---------------------------------------------------------------------------
 * ORDER INSIDE spawn IS A CONTRACT
 * ---------------------------------------------------------------------------
 *
 * mint → register → allocate the permanent ref → persist → FENCE → send.
 *
 * The fence must happen BEFORE the daemon frame is sent, because the frame
 * carries the lease generation it just allocated; sending first would tell the
 * daemon to observe under a generation that does not exist yet. The ref
 * allocation rides the same persist as the row (`additionalWrite`) so a session
 * cannot exist durably without its ref.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS MODULE DOES NOT DECIDE
 * ---------------------------------------------------------------------------
 *
 * WHOSE preferences a spawning read uses. `settingsViewer` arrives as a port and
 * stays owned by `SessionLifecycle`, which has five callers for it. It resolves
 * to `FIRST_ADMIN_USER_ID` today and POD-315 replaces that with the requesting
 * principal; this module needs no change when it does.
 *
 * The two `?? FIRST_ADMIN_USER_ID` fallbacks below ARE ambient-principal sites,
 * and they moved here from `lifecycle.ts` rather than being created. The census
 * (`bun run audit:ambient-principals`) counts USAGE and reads the delta, so a
 * move like this is 0 and only a genuinely NEW default is +1.
 */

import { randomUUID } from 'node:crypto'
import { basename } from 'node:path'
import type { Attribution, ResumeRef } from '@podium/model'
import {
  type AccountId,
  AgentKind,
  asMachineId,
  asSessionId,
  FIRST_ADMIN_USER_ID,
  type IssueId,
  type MachineId,
  type SessionId,
  type SessionMeta,
  type UserId,
} from '@podium/model'
import type {
  AgentInstruction,
  ControlMessage,
  SessionBindingSpawnInstruction,
} from '@podium/protocol'
import { resolveRole } from '@podium/runtime'
import { harnessSupportsInitialPrompt } from '../../harness-manifest'
import { assertModelSelectionValid } from '../../model-validation'
import type { SessionStore } from '../../store'
import type { MachineUseResolver } from '../machines/service'
import { createdByForBinding } from './command-plane'
import type { SessionLaunchConfig } from './launch-config'
import { normalizeAgentName } from './naming'
import type { SessionRepository } from './repository'
import { Session } from './session'
import { DEFAULT_GEOMETRY } from './session-shared'
import type { SessionStateService } from './session-state/service'
import type { SessionTerminalProof } from './terminal-proof'
import type { SessionView } from './view'

/**
 * What the caller of a spawn is told about the session it just created.
 *
 * DECLARED HERE because this module is what produces it — both `create()` and
 * `spawn()` return it, and the resume path gets it back through `spawn()`.
 * POD-302's representation registry records this file as its site; a type whose
 * registered site is a module that merely re-exports it is exactly the rot that
 * audit caught after the extraction.
 *
 * It reports the RESOLVED launch tuple — model/effort/account as the server
 * actually chose them, which the request may have left to defaults — and it
 * carries both `machine` and `machineId`, a duality the aggregate does not have.
 */
export interface SessionSpawnResult {
  sessionId: SessionId
  agentId: string
  harness: AgentKind
  model: string | null
  effort: string | null
  machine: string
  machineId: string
  accountId: AccountId | null
}

export interface SessionStartPorts {
  store: SessionStore
  view: SessionView
  repository: SessionRepository
  state: SessionStateService
  launchConfig: SessionLaunchConfig
  terminalProof: SessionTerminalProof
  /** Whose preferences a spawning read uses. NOT this module's decision. */
  settingsViewer(): UserId
  durableLabelFor(sessionId: SessionId): string
  /** Narrow session-registry access. Deliberately not the raw Map: this module
   *  needs exactly these three operations, and widening the shared map's reach
   *  is the coupling POD-1396's first cut existed to remove. */
  hasSession(sessionId: SessionId): boolean
  registerSession(session: Session): void
  sessionMachineId(sessionId: SessionId): string | undefined
  defaultMachine(): MachineId
  machineName(machineId: string): string
  nativeAccountIdForMachine(
    machineId: string,
    agentKind: AgentKind,
    accountId: AccountId,
  ): AccountId
  resolveMachineForAgent(
    requested: string | undefined,
    cwd: string,
    agentKind: AgentKind,
    use?: MachineUseResolver,
  ): MachineId
  onSpawnTargetLogin?(input: { machineId: string; agentKind: AgentKind; ownerUserId: UserId }): void
  toMachine(machineId: string, message: ControlMessage): void
  broadcastSessions(): void
  /** The issue that owns this cwd's worktree, if exactly one does. */
  soleOwnerForCwd(cwd: string): IssueId | undefined
  instructionsForStart(input: {
    sessionId: SessionId
    cwd: string
    agentKind: AgentKind
    issueId?: IssueId
    workflowRevisionId?: string
  }): { instructions: AgentInstruction[]; commit(): void }
  sessionOwner(sessionId: SessionId): { owner: UserId; grants: string[] } | undefined
  setSessionDraft(input: { sessionId: SessionId; text: string }, fromClientId?: string): void
  emitSessionCreated(payload: { sessionId: SessionId; agentKind: AgentKind }): void
}

export class SessionStart {
  constructor(private readonly ports: SessionStartPorts) {}

  create(input: {
    /** Authenticated human owner; every production caller supplies this. */
    ownerUserId?: UserId
    agentKind?: AgentKind
    cwd: string
    title?: string
    name?: string
    machineId?: string
    initialPrompt?: string
    model?: string
    effort?: string
    accountId?: AccountId
    forceUnknownModel?: boolean
    spawnedBy?: string
    workflowRunId?: string
    workflowStepId?: string
    executionProfileId?: string
    issueId?: IssueId
    sessionId?: SessionId
    workflowRevisionId?: string
    use?: MachineUseResolver
    binding?: Omit<SessionBindingSpawnInstruction, 'transitionId' | 'machineAccess' | 'issueId'>
    loginHarness?: Exclude<AgentKind, 'shell'>
  }): SessionSpawnResult {
    // Resolve the agent down to a concrete AgentKind. `agentKind` may be absent,
    // or carry a non-AgentKind sentinel like 'auto'. 'auto' is NOT a valid
    // AgentKind: persisting or broadcasting it fails the sessionsChanged
    // zod-parse and silently wipes the whole session list on every client.
    const requested = AgentKind.safeParse(input.agentKind)
    const agentKind = requested.success
      ? requested.data
      : resolveRole(this.ports.store.settings.getSettingsFor(this.ports.settingsViewer()), 'coding')
          .harness
    // Resolve the target machine before model validation — the catalog is
    // machine-keyed (POD-1123), so we validate against THIS spawn's host.
    const machineId = this.ports.resolveMachineForAgent(
      input.machineId,
      input.cwd,
      agentKind,
      input.use,
    )
    // Reject an explicit model/effort the live catalog doesn't list BEFORE any
    // spawn side effect [spec:SP-cc60].
    const { forced } = assertModelSelectionValid(
      this.ports.store.settings.getModelCatalog(machineId),
      {
        agentKind,
        ...(input.model !== undefined ? { model: input.model } : {}),
        ...(input.effort !== undefined ? { effort: input.effort } : {}),
        ...(input.forceUnknownModel ? { force: true } : {}),
      },
    )
    // Spawner name is validated before any side effect so a bad title never
    // leaves a half-spawned session.
    let curatedName: string | undefined
    if (input.name !== undefined) {
      const norm = normalizeAgentName(input.name)
      if (!norm.ok) throw new Error(norm.reason)
      curatedName = norm.name
    }
    // Explicit attachment wins; otherwise starting in an issue-owned worktree
    // means continuing that issue (spec: issue-as-workspace).
    const issueId = input.issueId ?? this.ports.soleOwnerForCwd(input.cwd) ?? undefined
    const sessionId = input.sessionId ?? asSessionId(randomUUID())
    const preparedInstructions = this.ports.instructionsForStart({
      sessionId,
      cwd: input.cwd,
      agentKind,
      ...(issueId ? { issueId } : {}),
      ...(input.workflowRevisionId ? { workflowRevisionId: input.workflowRevisionId } : {}),
    })
    const taskPrompt = input.initialPrompt?.trim() ? input.initialPrompt.trim() : undefined
    const useArgv = taskPrompt !== undefined && harnessSupportsInitialPrompt(agentKind)
    // Session ownership is declared per class: an issue-owned child inherits the
    // issue owner; otherwise a binding resolves to its on-behalf-of human. The
    // final fallback exists only for legacy in-process callers with no binding.
    const parentOwner = issueId ? this.ports.store.issues.getIssue(issueId)?.ownerUserId : undefined
    const bindingOwner =
      input.binding?.principal.kind === 'user'
        ? input.binding.principal.userId
        : input.binding?.principal.kind === 'agent'
          ? this.ports.sessionOwner(input.binding.principal.parentBindingId)?.owner
          : undefined
    const ownerUserId = parentOwner ?? input.ownerUserId ?? bindingOwner ?? FIRST_ADMIN_USER_ID
    // THE BINDING PRINCIPAL, RESOLVED ONCE (POD-1516). It was previously built
    // inline at the `binding:` key below; hoisting it is what lets the durable
    // attribution pair and the daemon binding come from THE SAME identity rather
    // than from two constructions of it.
    const binding = input.binding ?? {
      // One ownership answer feeds both the durable row and the daemon binding;
      // this seam never invents a different principal.
      principal: { kind: 'user' as const, userId: ownerUserId },
    }
    // WHO CREATED THIS SESSION, AND FOR WHOM — stamped here, UNCONDITIONALLY, so
    // that an absent pair downstream can only ever mean "recorded before the
    // field existed" (ADR 9 D5 A3; see `SessionMeta.createdBy`). The human half
    // is the DELEGATING human off the principal, NOT `ownerUserId`: those differ
    // exactly when a session is spawned under a shared issue, and conflating
    // them would attribute the spawn to the issue's owner.
    const createdBy = createdByForBinding(binding.principal, bindingOwner ?? ownerUserId)
    const spawned = this.spawn({
      agentKind,
      ownerUserId,
      cwd: input.cwd,
      ...(input.title !== undefined ? { title: input.title } : {}),
      ...(curatedName ? { name: curatedName, nameSource: 'agent' as const } : {}),
      origin: { kind: 'spawn' },
      machineId,
      bindingMachineAccess: input.use?.(machineId) === 'denied' ? 'denied' : 'allowed',
      ...(useArgv ? { initialPrompt: taskPrompt } : {}),
      ...(preparedInstructions.instructions.length
        ? { instructions: preparedInstructions.instructions }
        : {}),
      ...(input.model !== undefined ? { model: input.model } : {}),
      ...(input.effort !== undefined ? { effort: input.effort } : {}),
      ...(input.accountId !== undefined ? { accountId: input.accountId } : {}),
      ...(input.loginHarness ? { loginHarness: input.loginHarness } : {}),
      ...(input.spawnedBy ? { spawnedBy: input.spawnedBy } : {}),
      ...(input.workflowRunId ? { workflowRunId: input.workflowRunId } : {}),
      ...(input.workflowStepId ? { workflowStepId: input.workflowStepId } : {}),
      ...(input.executionProfileId ? { executionProfileId: input.executionProfileId } : {}),
      ...(issueId ? { issueId } : {}),
      binding,
      createdBy,
      sessionId,
    })
    preparedInstructions.commit()
    if (taskPrompt !== undefined && !useArgv) {
      this.ports.setSessionDraft({ sessionId: spawned.sessionId, text: taskPrompt })
    }
    // Fire-and-forget notification (post-spawn, so subscribers observe the new
    // world). Its one consumer today is the opt-in telemetry usage counter
    // [spec:SP-f933], which is why the payload carries the harness kind and
    // nothing else — no cwd, no prompt, no issue id.
    this.ports.emitSessionCreated({ sessionId: spawned.sessionId, agentKind })
    // Forcing an unlisted model is a deliberate override — make it durable and
    // observable across every spawn path [spec:SP-cc60].
    if (forced) {
      this.ports.store.events.appendEvent({
        ts: new Date().toISOString(),
        kind: 'agent.model_forced',
        subject: spawned.sessionId,
        payload: {
          sessionId: spawned.sessionId,
          harness: agentKind,
          ...(input.model !== undefined ? { model: input.model } : {}),
          ...(issueId ? { issueId } : {}),
          ...(input.spawnedBy ? { spawnedBy: input.spawnedBy } : {}),
        },
      })
    }
    return spawned
  }

  spawn(input: {
    agentKind: AgentKind
    ownerUserId?: UserId
    cwd: string
    title?: string
    /** Curated name at birth (spawner-prescribed or other); pairs with nameSource. */
    name?: string
    nameSource?: 'user' | 'agent'
    origin: SessionMeta['origin']
    resume?: ResumeRef
    machineId?: string
    initialPrompt?: string
    instructions?: AgentInstruction[]
    model?: string
    effort?: string
    accountId?: AccountId
    spawnedBy?: string
    workflowRunId?: string
    workflowStepId?: string
    executionProfileId?: string
    issueId?: IssueId
    sessionId?: SessionId
    binding?: Omit<SessionBindingSpawnInstruction, 'transitionId' | 'machineAccess' | 'issueId'>
    bindingMachineAccess?: SessionBindingSpawnInstruction['machineAccess']
    loginHarness?: Exclude<AgentKind, 'shell'>
    /** The attribution pair, already derived from the binding principal by the
     *  caller. Optional only for the in-process spawn paths that predate it. */
    createdBy?: Attribution
  }): SessionSpawnResult {
    // A server-minted uuid was unique by construction; a client-supplied id is
    // not. Reject a collision rather than let the registry overwrite the live
    // Session (orphaning its PTY/daemon binding) or re-fire a spawn.
    if (input.sessionId && this.ports.hasSession(input.sessionId)) {
      throw new Error(`refusing to reuse an existing session id: ${input.sessionId}`)
    }
    const sessionId = input.sessionId ?? asSessionId(randomUUID())
    const machineId = input.machineId ? asMachineId(input.machineId) : this.ports.defaultMachine()
    this.ports.onSpawnTargetLogin?.({
      machineId,
      agentKind: input.agentKind,
      ownerUserId: input.ownerUserId ?? FIRST_ADMIN_USER_ID,
    })
    const launch = this.ports.launchConfig.modelDefaults(
      input.agentKind,
      input.model !== undefined || input.effort !== undefined
        ? { model: input.model, effort: input.effort }
        : undefined,
    )
    const selectedAccountId =
      input.agentKind === 'shell'
        ? undefined
        : (input.accountId ??
          resolveRole(
            this.ports.store.settings.getSettingsFor(this.ports.settingsViewer()),
            'coding',
          ).accountId)
    const accountId =
      input.agentKind === 'shell' || selectedAccountId === undefined
        ? undefined
        : this.ports.nativeAccountIdForMachine(machineId, input.agentKind, selectedAccountId)
    const session = new Session({
      sessionId,
      durableLabel: this.ports.durableLabelFor(sessionId),
      ownerUserId: input.ownerUserId ?? FIRST_ADMIN_USER_ID,
      agentKind: input.agentKind,
      cwd: input.cwd,
      title: input.title || basename(input.cwd) || input.cwd,
      ...(launch.model ? { model: launch.model } : {}),
      ...(launch.effort ? { effort: launch.effort } : {}),
      ...(accountId ? { accountId } : {}),
      origin: input.origin,
      createdAt: new Date().toISOString(),
      geometry: { ...DEFAULT_GEOMETRY },
      machineId,
      // Bind the route to the LIVE machineId (tracks the local-adoption
      // reassignment), falling back to the birth machine before the row exists.
      toDaemon: (msg) =>
        this.ports.toMachine(this.ports.sessionMachineId(sessionId) ?? machineId, msg),
      onActivity: () => {
        // Shell busy transitions advance lastActiveAt (their only activity
        // signal); persist so recency is durable across a restart, then
        // rebroadcast.
        this.ports.repository.persist(session)
        this.ports.broadcastSessions()
      },
      ...(input.resume ? { resume: input.resume } : {}),
      ...(input.spawnedBy ? { spawnedBy: input.spawnedBy } : {}),
      ...(input.createdBy ? { createdBy: input.createdBy } : {}),
      ...(input.workflowRunId ? { workflowRunId: input.workflowRunId } : {}),
      ...(input.workflowStepId ? { workflowStepId: input.workflowStepId } : {}),
      ...(input.executionProfileId ? { executionProfileId: input.executionProfileId } : {}),
      ...(input.issueId ? { issueId: input.issueId } : {}),
      ...(input.name ? { name: input.name } : {}),
      ...(input.nameSource ? { nameSource: input.nameSource } : {}),
    })
    this.ports.registerSession(session)
    // Naming point (#474): input.issueId is the resolved birth issue (or absent
    // for a genuinely issueless spawn) — allocate the permanent ref now, and let
    // it ride the SAME persist as the row so a session cannot exist durably
    // without its ref.
    const additionalWrite = this.ports.view.prepareRefAllocation(session)
    this.ports.repository.persist(session, additionalWrite)
    // FENCE BEFORE SEND. The frame below carries the generation this allocates;
    // sending first would tell the daemon to observe under one that does not
    // exist yet.
    const observationLease = this.ports.terminalProof.fence(session)
    this.ports.toMachine(machineId, {
      type: 'spawn',
      sessionId,
      durableLabel: session.durableLabel,
      agentKind: input.agentKind,
      ...(input.loginHarness ? { loginHarness: input.loginHarness } : {}),
      cwd: input.cwd,
      ...(input.binding
        ? {
            binding: {
              transitionId: `spawn:${sessionId}`,
              machineAccess: input.bindingMachineAccess ?? 'allowed',
              ...input.binding,
              ...(input.issueId ? { issueId: input.issueId } : {}),
            },
          }
        : {}),
      ...(observationLease
        ? {
            observationGeneration: observationLease.observationGeneration,
            observationBindingVersion: observationLease.bindingVersion,
            observationProviderSessionId: observationLease.providerSessionId,
            ...(observationLease.checkpoint
              ? { observationCheckpoint: observationLease.checkpoint }
              : {}),
          }
        : {}),
      ...(input.resume ? { resume: input.resume } : {}),
      ...(input.initialPrompt ? { initialPrompt: input.initialPrompt } : {}),
      ...(input.instructions?.length ? { instructions: input.instructions } : {}),
      geometry: { ...DEFAULT_GEOMETRY },
      ...launch,
      // The suffix is durable session attribution only; launch with the selected account unchanged.
      ...this.ports.launchConfig.accountEnv(input.agentKind, selectedAccountId),
      ...(this.ports.state.draftSyncEnabled() ? { draftSync: true } : {}),
    })
    this.ports.broadcastSessions()
    return {
      sessionId,
      agentId: sessionId,
      harness: input.agentKind,
      model: launch.model ?? null,
      effort: launch.effort ?? null,
      machine: this.ports.machineName(machineId),
      machineId,
      accountId: accountId ?? null,
    }
  }
}
