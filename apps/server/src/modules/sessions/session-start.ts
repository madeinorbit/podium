import { createLogger } from '@podium/logger'
import { CAP_DAEMON_GEOMETRY_APPLIED } from '@podium/protocol'
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
 * ---------------------------------------------------------------------------
 * WHAT THIS MODULE DOES DECIDE, AND DID NOT USED TO
 * ---------------------------------------------------------------------------
 *
 * WHOSE preferences a spawning read uses. This arrived as a `settingsViewer`
 * port whose only implementation answered `firstAdminMemberId()`, beside a
 * comment promising that POD-315 would replace it with the requesting principal.
 * POD-315 CLOSED WITHOUT DOING SO, so that was an orphan rather than a deferral
 * and every spawn read the earliest admin's `roles.*`. PDM-295 removed the port:
 * the viewer is now a required parameter on `SessionLaunchConfig`, supplied here
 * from the human this module has ALREADY resolved. Both paths have one —
 * `spawn()`'s `ownerUserId` is required, and `create()` resolves its owner
 * before it asks — so there is no arm left that needs a stand-in.
 *
 * WHO OWNS A SESSION THIS MODULE STARTS. The initiating human, resolved from the
 * binding principal (its parent session's owner for an agent spawn) or supplied
 * explicitly by the caller — NEVER the attached issue's owner. B1 (PDM-133)
 * removed the issue term, which used to come first and outrank both.
 *
 * Of the two `?? firstAdminMemberId()` ambient-principal fallbacks that stood
 * behind those sites, `spawn()`'s is GONE (its owner is now a required
 * parameter) and `create()`'s SURVIVES as the last term only — see the comment
 * at that line for why, and for what has to happen before it can go. Census
 * (`bun run audit:ambient-principals`) usage delta for this file: -1, not -2.
 */

import { randomUUID } from 'node:crypto'
import { basename } from 'node:path'
import type { Attribution, ResumeRef } from '@podium/model'
import {
  type AccountId,
  AgentKind,
  asMachineId,
  asSessionId,
  type IssueId,
  type MachineId,
  type SessionId,
  type SessionMeta,
  type UserId,
} from '@podium/model'
import type {
  AgentInstruction,
  DaemonPtyInputBatch,
  RuntimeContractRequest,
  SessionBindingSpawnInstruction,
} from '@podium/protocol'
import type { ControlMessage } from '@podium/protocol/daemon'
import { nativeAccountId, resolveRole } from '@podium/runtime'
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
const log = createLogger('server:sessions:start')

export interface SessionSpawnResult {
  sessionId: SessionId
  agentId: string
  harness: AgentKind
  model: string | null
  effort: string | null
  machine: string
  machineId: MachineId
  accountId: AccountId | null
}

export interface SessionStartPorts {
  store: SessionStore
  view: SessionView
  repository: SessionRepository
  state: SessionStateService
  launchConfig: SessionLaunchConfig
  terminalProof: SessionTerminalProof
  durableLabelFor(sessionId: SessionId): string | Promise<string>
  /** Narrow session-registry access. Deliberately not the raw Map: this module
   *  needs exactly these three operations, and widening the shared map's reach
   *  is the coupling POD-1396's first cut existed to remove. */
  hasSession(sessionId: SessionId): boolean
  registerSession(session: Session): void
  sessionMachineId(sessionId: SessionId): string | undefined
  defaultMachine(): Promise<MachineId>
  machineName(machineId: MachineId): Promise<string>
  nativeAccountIdForMachine(
    machineId: MachineId,
    agentKind: AgentKind,
    accountId: AccountId,
  ): Promise<AccountId>
  resolveMachineForAgent(
    requested: string | undefined,
    cwd: string,
    agentKind: AgentKind,
    use?: MachineUseResolver,
  ): Promise<MachineId>
  onSpawnTargetLogin?(input: {
    machineId: MachineId
    agentKind: AgentKind
    ownerUserId: UserId
  }): void
  toMachine(machineId: MachineId, message: ControlMessage): void
  /** Does the daemon attached for this machine RIGHT NOW have `cap`? (POD-3239) */
  machineSupports(machineId: MachineId, cap: string): boolean
  toPtyInput(machineId: MachineId, input: DaemonPtyInputBatch): void
  broadcastSessions(): void
  /** The issue that owns this cwd's worktree, if exactly one does. */
  soleOwnerForCwd(cwd: string): Promise<IssueId | undefined>
  instructionsForStart(input: {
    sessionId: SessionId
    cwd: string
    agentKind: AgentKind
    issueId?: IssueId
    workflowRevisionId?: string
  }): Promise<{ instructions: AgentInstruction[]; commit(): Promise<void> }>
  sessionOwner(sessionId: SessionId): Promise<{ owner: UserId; grants: string[] } | undefined>
  /** Seed the non-argv creation prompt into the recoverable composer draft. */
  setSessionDraft?(input: { sessionId: SessionId; text: string }): Promise<void>
  queueInitialPrompt(input: { sessionId: SessionId; text: string }): Promise<{
    ok: boolean
    queued?: boolean
    reason?: string
  }>
  emitSessionCreated(payload: {
    sessionId: SessionId
    agentKind: AgentKind
    issueId?: IssueId
  }): void
}

/**
 * WHO THE SESSION IS FOR, STATED RATHER THAN ASSUMED (PDM-276).
 *
 * `create()` used to end its owner chain with `?? firstAdminMemberId(store)`, so
 * a caller that mentioned no human got one anyway -- the earliest-enrolled
 * account. That is the last of B1's ownerless-creation paths, and it was NOT
 * unreachable in production: `spawnOwner()` answers "nobody" for a system
 * principal by design, and three conditional spreads between there and here drop
 * the key when it is falsy, so an unattributable spawn arrived with no owner and
 * left owned by, bound to and attributed to the first admin. The witness is
 * `ownerless-creation.test.ts`.
 *
 * THE FIX IS A TYPE, NOT A GUARD, because a guard is one edit away from being
 * removed and a convention ("every caller happens to pass it") is not a
 * property. Either shape is accepted and nothing else is:
 *
 *   - an explicit `ownerUserId` -- the caller resolved a human and says so; or
 *   - a `binding`, whose principal already carries one (for an agent spawn, its
 *     parent session's owner), which is what makes "child agents keep their
 *     human ceiling" true by construction.
 *
 * `spawn()` took this route in B1 for the same reason; this is `create()`
 * catching up. What a caller may NOT do any more is stay silent and be assigned
 * somebody -- ADR 3 Amendment 1 D17.5/D21.2, "representable none, never
 * defaulted to an operator or to a row's owner".
 */
type SessionOwnerInput =
  | {
      /** The binding principal carries the human; an explicit owner is optional. */
      binding: Omit<SessionBindingSpawnInstruction, 'transitionId' | 'machineAccess' | 'issueId'>
      ownerUserId?: UserId
    }
  | {
      binding?: undefined
      /** No binding, so the caller must name the human this run belongs to. */
      ownerUserId: UserId
    }

export class SessionStart {
  constructor(private readonly ports: SessionStartPorts) {}

  async create(input: {
    agentKind?: AgentKind
    cwd: string
    title?: string
    name?: string
    machineId?: MachineId
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
    loginHarness?: Exclude<AgentKind, 'shell'>
    /**
     * THE OPERATOR'S PER-SPAWN DRIVER CHOICE (POD-1761 W5; spec §9 phase 3).
     *
     * `true` drives this session through the Agent Runtime contract with
     * whatever the harness manifest's `select()` policy picks — which is the
     * terminal driver for every harness today. A DRIVER ID names one
     * explicitly, and is how a single opencode session runs on
     * `opencode-server` while every other session on the same daemon stays
     * terminal.
     *
     * ABSENT IS THE DEFAULT AND CHANGES NOTHING. The daemon takes the OR of this
     * and its machine-wide flag, so a spawn that says nothing is byte-for-byte
     * the spawn it was before this field existed.
     *
     * NO UI, deliberately (the epic's non-goals): a settings/CLI lever and this
     * field are what an operator needs to test a driver, and a picker in the
     * spawn dialog would be a product decision nobody has made.
     */
    runtimeContract?: RuntimeContractRequest
  } & SessionOwnerInput): Promise<SessionSpawnResult> {
    /**
     * RESOLVED FIRST, BECAUSE THE PREFERENCE READS BELOW ASK FOR A PERSON
     * (PDM-295). This used to sit further down, after the harness and account
     * defaults had already been read as `settingsViewer()` — the earliest admin.
     * Nothing between here and its old position contributes to it: it reads
     * `input.binding` and one session-owner lookup, so hoisting moves a pure
     * read earlier and changes no side effect. What it buys is that every
     * question below this line can be asked about the RIGHT human.
     */
    /**
     * THE SESSION IS OWNED BY THE HUMAN WHO STARTED IT (B1, PDM-133).
     *
     * This read `parentOwner ?? input.ownerUserId ?? bindingOwner ?? firstAdmin`,
     * and every term of that chain was wrong in a different way:
     *
     *  - `parentOwner` re-derived the ATTACHED ISSUE's owner and put it FIRST,
     *    so a session started by Bob on Alice's task was Alice's. Note what that
     *    did to `input.ownerUserId`: `createdOwnership` is documented as "the ONE
     *    producer of the inheritance rule, so storage consumes the decision
     *    without re-deciding it" — and this line re-decided it, discarding the
     *    caller's answer whenever an issue was attached. Two producers, and the
     *    silent one won.
     *  - `firstAdmin` is the solo-user fallback A2 was meant to retire. It cannot
     *    be right on a multi-human instance: it names whoever enrolled first, so
     *    an unattributable session became the admin's rather than being refused.
     *
     * The order is now the DELEGATION first and the caller's explicit answer
     * second, with NO ISSUE TERM. `bindingOwner` is the binding principal's
     * human — for an agent spawn, its PARENT SESSION's owner, which is what
     * makes "child agents retain the same human ceiling and do not inherit the
     * task assignee" true by construction rather than by convention.
     *
     * `firstAdminMemberId` IS GONE FROM THIS CHAIN (PDM-276), and the argument
     * that kept it was wrong. B1 left it as the last term on the ground that it
     * was reachable only when a caller supplied neither a binding nor an owner,
     * "and no production caller does". One does. `spawnOwner()` answers
     * "nobody" for a system principal deliberately — ADR 3 Amendment 1
     * D17.5/D21.2 — and `issues/registry.ts`, `issues/service/workflow.ts`
     * and `relay.ts`'s `spawnSession` each drop the key with a conditional
     * spread when it is falsy, so that "nobody" arrived here and was answered
     * with the earliest-enrolled admin. Worse than a mis-read: the binding below
     * is built FROM this value, so the run was also BOUND to that person.
     *
     * It is now a required input rather than a defaulted one — see
     * `SessionOwnerInput` above — and `ownerless-creation.test.ts` is the
     * end-to-end witness that reddens if the fallback comes back.
     *
     * `spawn()` below took the stricter route because it has exactly two callers
     * and both resolve a real human: there its `ownerUserId` is REQUIRED.
     *
     * `createdBy` below already resolved its human this way and says so in its
     * own comment ("those differ exactly when a session is spawned under a shared
     * issue, and conflating them would attribute the spawn to the issue's
     * owner"). The attribution stamp and the authority field now agree; the bug
     * was that only one of them had been fixed.
     */
    const bindingOwner =
      input.binding?.principal.kind === 'user'
        ? input.binding.principal.userId
        : input.binding?.principal.kind === 'agent'
          ? (await this.ports.sessionOwner(input.binding.principal.parentBindingId))?.owner
          : undefined
    /**
     * NO THIRD TERM. There used to be `?? (await firstAdminMemberId(store))`
     * here; `SessionOwnerInput` above is what replaced it, and the reasoning is
     * written out there. The type guarantees one of these two is present, so
     * this cannot be undefined -- and if a future edit makes it so, the compiler
     * says so at the call site rather than this line quietly picking a person.
     */
    const ownerUserId = bindingOwner ?? input.ownerUserId
    /**
     * AND IF THE BINDING'S HUMAN DOES NOT RESOLVE, REFUSE (PDM-276).
     *
     * The type above guarantees a caller stated SOMETHING, but one of its two
     * arms is a binding, and a binding can fail to yield a human at runtime: an
     * agent principal reaches its person through its parent session's owner, and
     * that lookup returns undefined for a parent that no longer exists or never
     * had one. That is precisely the hole the old `?? firstAdminMemberId(store)`
     * filled by inventing somebody.
     *
     * REFUSING IS THE SAME ANSWER `automations` ALREADY GIVES — `ownerFor()`
     * throws "automation writes require a human principal" rather than
     * substituting one — and it fails CLOSED: a spawn that cannot name its human
     * does not happen, instead of happening as the earliest admin. The session
     * has not been created at this point; the only work done above is reads.
     */
    if (ownerUserId === undefined) {
      throw new Error(
        'a session must belong to a human: pass ownerUserId, or a binding whose principal resolves to one',
      )
    }

    // Resolve the agent down to a concrete AgentKind. `agentKind` may be absent,
    // or carry a non-AgentKind sentinel like 'auto'. 'auto' is NOT a valid
    // AgentKind: persisting or broadcasting it fails the sessionsChanged
    // zod-parse and silently wipes the whole session list on every client.
    const requested = AgentKind.safeParse(input.agentKind)
    const agentKind = requested.success
      ? requested.data
      : resolveRole(
          await this.ports.store.settings.getSettingsFor(ownerUserId),
          'coding',
        ).harness
    // Resolve the target machine before model validation — the catalog is
    // machine-keyed (POD-1123), so we validate against THIS spawn's host.
    if (input.loginHarness && agentKind !== 'shell') {
      throw new Error('loginHarness is only valid for shell sessions')
    }
    const machineId = await this.ports.resolveMachineForAgent(
      input.machineId,
      input.cwd,
      agentKind,
      input.use,
    )
    // Reject an explicit model/effort the live catalog doesn't list BEFORE any
    // spawn side effect [spec:SP-cc60].
    const { forced } = assertModelSelectionValid(
      await this.ports.store.settings.getModelCatalog(machineId),
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
    const issueId = input.issueId ?? (await this.ports.soleOwnerForCwd(input.cwd)) ?? undefined
    const sessionId = input.sessionId ?? asSessionId(randomUUID())
    const preparedInstructions = await this.ports.instructionsForStart({
      sessionId,
      cwd: input.cwd,
      agentKind,
      ...(issueId ? { issueId } : {}),
      ...(input.workflowRevisionId ? { workflowRevisionId: input.workflowRevisionId } : {}),
    })
    const taskPrompt = input.initialPrompt?.trim() ? input.initialPrompt.trim() : undefined
    const useArgv = taskPrompt !== undefined && harnessSupportsInitialPrompt(agentKind)
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
    const spawned = await this.spawn({
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
      ...(input.runtimeContract !== undefined ? { runtimeContract: input.runtimeContract } : {}),
      ...(input.spawnedBy ? { spawnedBy: input.spawnedBy } : {}),
      ...(input.workflowRunId ? { workflowRunId: input.workflowRunId } : {}),
      ...(input.workflowStepId ? { workflowStepId: input.workflowStepId } : {}),
      ...(input.executionProfileId ? { executionProfileId: input.executionProfileId } : {}),
      ...(issueId ? { issueId } : {}),
      binding,
      createdBy,
      sessionId,
    })
    await preparedInstructions.commit()
    if (taskPrompt !== undefined && !useArgv) {
      await this.ports.setSessionDraft?.({ sessionId: spawned.sessionId, text: taskPrompt })
      const queued = await this.ports.queueInitialPrompt({
        sessionId: spawned.sessionId,
        text: taskPrompt,
      })
      if (!queued.ok) {
        throw new Error(queued.reason ?? 'initial prompt could not be queued')
      }
    }
    // Fire-and-forget notification (post-spawn, so subscribers observe the new
    // world). Its telemetry consumer reads the harness kind [spec:SP-f933]. The
    // issue id is also the lifecycle fact used to establish the first eligible
    // issue agent as its default coordinator; no cwd or prompt crosses this seam.
    this.ports.emitSessionCreated({
      sessionId: spawned.sessionId,
      agentKind,
      ...(issueId ? { issueId } : {}),
    })
    // Forcing an unlisted model is a deliberate override — make it durable and
    // observable across every spawn path [spec:SP-cc60].
    if (forced) {
      await this.ports.store.events.appendEvent({
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

  async spawn(input: {
    agentKind: AgentKind
    /**
     * The initiating human. REQUIRED since B1 (PDM-133) — it was optional with a
     * `?? firstAdminMemberId()` fallback below, which on a multi-human instance
     * hands an unattributable session to whoever enrolled first. Both call sites
     * (`create` above, `SessionRevival`) resolve a real human, so the fallback
     * was already unreachable in production; making the TYPE required is what
     * keeps the next caller from re-introducing the ambiguity rather than a
     * comment asking it not to.
     */
    ownerUserId: UserId
    cwd: string
    title?: string
    /** Curated name at birth (spawner-prescribed or other); pairs with nameSource. */
    name?: string
    nameSource?: 'user' | 'agent'
    origin: SessionMeta['origin']
    resume?: ResumeRef
    machineId?: MachineId
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
    /** The operator's per-spawn driver choice — see `create()`'s field of the
     *  same name. Carried straight onto the spawn frame; absent changes nothing. */
    runtimeContract?: RuntimeContractRequest
  }): Promise<SessionSpawnResult> {
    // A server-minted uuid was unique by construction; a client-supplied id is
    // not. Reject a collision rather than let the registry overwrite the live
    // Session (orphaning its PTY/daemon binding) or re-fire a spawn.
    if (input.sessionId && this.ports.hasSession(input.sessionId)) {
      throw new Error(`refusing to reuse an existing session id: ${input.sessionId}`)
    }
    const sessionId = input.sessionId ?? asSessionId(randomUUID())
    const machineId = input.machineId
      ? asMachineId(input.machineId)
      : await this.ports.defaultMachine()
    const ownerUserId = input.ownerUserId
    this.ports.onSpawnTargetLogin?.({
      machineId,
      agentKind: input.agentKind,
      ownerUserId,
    })
    // The defaults are THIS OWNER's: model, effort and subagent model are
    // `preferences-personal` and `ownerUserId` is required on this path (B1).
    const launch = await this.ports.launchConfig.modelDefaults(
      input.agentKind,
      ownerUserId,
      input.model !== undefined || input.effort !== undefined
        ? { model: input.model, effort: input.effort }
        : undefined,
    )
    const inheritedAccountId =
      input.agentKind === 'shell'
        ? undefined
        : resolveRole(
            await this.ports.store.settings.getSettingsFor(ownerUserId),
            'coding',
          ).accountId
    // A native role default names the CLI whose login it represents. Since the
    // coding default is shared across agent kinds, an omitted account must not
    // carry a different CLI's identity into per-session driver resolution. An
    // explicit account is user intent and remains byte-for-byte unchanged for
    // the existing downstream compatibility/refusal behavior.
    const inheritedNativePrefix = `native:${input.agentKind}`
    const inheritedMatchesAgent =
      inheritedAccountId === inheritedNativePrefix ||
      inheritedAccountId?.startsWith(inheritedNativePrefix + ':')
    const selectedAccountId =
      input.accountId !== undefined
        ? input.accountId
        : input.agentKind !== 'shell' &&
            inheritedAccountId?.startsWith('native:') &&
            !inheritedMatchesAgent
          ? nativeAccountId(input.agentKind)
          : inheritedAccountId
    const accountId =
      input.agentKind === 'shell' || selectedAccountId === undefined
        ? undefined
        : await this.ports.nativeAccountIdForMachine(machineId, input.agentKind, selectedAccountId)
    const session = new Session({
      sessionId,
      durableLabel: await this.ports.durableLabelFor(sessionId),
      ownerUserId,
      agentKind: input.agentKind,
      cwd: input.cwd,
      title: input.title || basename(input.cwd) || input.cwd,
      ...(launch.model ? { model: launch.model } : {}),
      ...(launch.effort ? { effort: launch.effort } : {}),
      ...(accountId ? { accountId } : {}),
      ...(input.loginHarness ? { loginHarness: input.loginHarness } : {}),
      origin: input.origin,
      createdAt: new Date().toISOString(),
      geometry: { ...DEFAULT_GEOMETRY },
      machineId,
      // Bind the route to the LIVE machineId (tracks the local-adoption
      // reassignment), falling back to the birth machine before the row exists.
      toDaemon: (msg) =>
        this.ports.toMachine(asMachineId(this.ports.sessionMachineId(sessionId) ?? machineId), msg),
      daemonReportsGeometry: () =>
        this.ports.machineSupports(
          asMachineId(this.ports.sessionMachineId(sessionId) ?? machineId),
          CAP_DAEMON_GEOMETRY_APPLIED,
        ),
      sendInput: (input) =>
        this.ports.toPtyInput(
          asMachineId(this.ports.sessionMachineId(sessionId) ?? machineId),
          input,
        ),
      onActivity: () => {
        // Shell busy transitions advance lastActiveAt (their only activity
        // signal); persist so recency is durable across a restart, then
        // rebroadcast.
        void this.ports.repository
          .persistActivityIfWritable(session)
          .then((written) => {
            if (written) this.ports.broadcastSessions()
          })
          .catch((error) => log.error('failed to persist session activity', { error }))
      },
      ...(input.resume ? { resume: input.resume } : {}),
      // THE MINT SITE STATES THE CLAIM (POD-2392). This is the one moment the
      // server can honestly say a launch has never had a conversation — it is
      // creating it — so every row born here carries the proof, and `undefined`
      // downstream can only ever mean "written before the fact existed".
      // A resume-origin spawn is bound by construction; `Session` promotes it
      // off `input.resume` regardless, and stating it here would be a second
      // place for the same rule to drift.
      conversationBinding: 'never',
      ...(input.spawnedBy ? { spawnedBy: input.spawnedBy } : {}),
      ...(input.createdBy ? { createdBy: input.createdBy } : {}),
      ...(input.workflowRunId ? { workflowRunId: input.workflowRunId } : {}),
      ...(input.workflowStepId ? { workflowStepId: input.workflowStepId } : {}),
      ...(input.executionProfileId ? { executionProfileId: input.executionProfileId } : {}),
      ...(input.issueId ? { issueId: input.issueId } : {}),
      ...(input.name ? { name: input.name } : {}),
      ...(input.nameSource ? { nameSource: input.nameSource } : {}),
      ...(typeof input.runtimeContract === 'string'
        ? { requestedDriverId: input.runtimeContract }
        : {}),
    })
    this.ports.registerSession(session)
    // Naming point (#474): input.issueId is the resolved birth issue (or absent
    // for a genuinely issueless spawn) — allocate the permanent ref now, and let
    // it ride the SAME persist as the row so a session cannot exist durably
    // without its ref.
    // THE REF IS ALLOCATED ONTO THIS WRITE'S DRAFT [POD-3330]. The allocation
    // happens inside the transaction (it takes a letter from the issue, or a
    // draft ordinal from the repo), so it has to assign into the state the row
    // is built from rather than onto the live object beside it.
    const draft = this.ports.repository.draft(session)
    const additionalWrite = await this.ports.view.prepareRefAllocation(draft)
    await this.ports.repository.persistDraft(session, draft, additionalWrite)
    // FENCE BEFORE SEND. The frame below carries the generation this allocates;
    // sending first would tell the daemon to observe under one that does not
    // exist yet.
    const observationLease = await this.ports.terminalProof.fence(session)
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
      // The credential is resolved for `ownerUserId` — the human this session
      // belongs to, required on this path since B1. Since PDM-295 the SLOT above
      // is resolved for that same person, so a member is no longer refused on a
      // slot somebody else chose (PDM-280 §7.4).
      ...(await this.ports.launchConfig.accountEnv(
        input.agentKind,
        ownerUserId,
        selectedAccountId,
      )),
      ...(this.ports.state.draftSyncEnabled() ? { draftSync: true } : {}),
      ...(input.runtimeContract !== undefined ? { runtimeContract: input.runtimeContract } : {}),
    })
    this.ports.broadcastSessions()
    return {
      sessionId,
      agentId: sessionId,
      harness: input.agentKind,
      model: launch.model ?? null,
      effort: launch.effort ?? null,
      machine: await this.ports.machineName(machineId),
      machineId,
      accountId: accountId ?? null,
    }
  }
}
