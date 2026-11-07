/**
 * The `messages` command surface (#237) [spec:SP-34d7 acks/read-toolkit]:
 * `podium mail send/inbox/show/reply`, `podium session ask` and the stop-hook's
 * pendingReminders, served to BOTH the daemon relay (agent capability) and the
 * tRPC router. Sender identity is stamped from the capability — client input
 * never contributes sender fields (mailIdentity pattern).
 *
 * POD-728 split this file along ADR 3 D1's line and POD-729 finished the cut.
 * EVERY proc this class ever served is now a CONTRACT + HANDLER pair: the
 * contracts are L1 data in `@podium/commands`, the handlers are in `./handlers`,
 * and `./registry.ts` joins them. What is left here is a dispatcher and the
 * dependency surface the handlers share — the hand-written bodies, their input
 * schemas and the switch that reached them are DELETED, which is the point of
 * the issue rather than a side effect of it.
 *
 * The two structural properties the migration preserves, deliberately:
 *  - ONE authz path. Both transports dispatch through this class into the same
 *    `MailAccess`; the relay arm and the tRPC arm share it verbatim.
 *  - Sender identity from the capability, never from payload (ADR 3 D7 / the
 *    mailIdentity pattern) — `senderFromCapability` is still the single site.
 */

import { type HumanCeiling, SINGLE_USER_CEILING, type TransportTag } from '@podium/commands'
import type {
  AccountId,
  HarnessRefEntry,
  IssueId,
  MachineId,
  MessageHeld,
  MessageRecordWire,
  SessionId,
  SessionMeta,
  ThreadId,
  TranscriptItemRef,
  UserId,
} from '@podium/model'
import { type MessageDeliveryStatus, spawnedByParentSessionId } from '@podium/model'
import type { MutationLedgerPort } from '@podium/sync'
import { type CommandPrincipal, resolvePrincipalAsync } from '../../command-principal'
import type { Capability } from '../../issue-authz'
import type { MessageRow } from '../../store'
import { spanOpen } from '../../store/executor/executor'
import { withReadScope } from '../../store/executor/read-scope'
import type { FrontDoorTransport } from '../front-door'
import type { IssueService } from '../issues/service'
import type { SyncWriteEntry } from '../sync-write/entry'
import {
  type MachineAccess,
  MailAccess,
  type MailCaller,
  type MailHandlerContext,
  SINGLE_USER_MACHINE_ACCESS,
} from './handlers/context'
import type { SpawnBudgetExhausted } from './handlers/spawn-agent'
import { dispatchMailCommand, isMailProcExposedOn, type MailProcName } from './registry'
import type { MessageDeliveryService } from './service'
import {
  answerAsBefore,
  isMailWriteProc,
  mailWriteError,
  submitAwaitObserved,
  submitMailWrite,
} from './sync-write'

export interface MessageGateDeps {
  messages: MessageDeliveryService
  issues: IssueService
  /** ONE session by id, without the full reader-scoped pass [POD-1646].
   *  REQUIRED since POD-3857: the full-list port it used to fall back to is
   *  gone, so the compiler is what keeps the gate off the projection. */
  sessionById(sessionId: SessionId): Promise<SessionMeta | undefined>
  /** A person's own chat message records, by id, as the feed scopes them
   *  (`readMessageRecords`, POD-4811) — `mail.records`. */
  messageRecords(
    userId: UserId,
    ids: readonly string[],
    transcriptSessionId?: SessionId,
  ): Promise<MessageRecordWire[]>
  /** A session's owner and grants, as the session reads decide access
   *  (`SessionAuthz.sessionOwner`) — lets a person read mail sent by or
   *  delivered to a session they may read (POD-2143, POD-2146). Absent (tests) = `mayView` alone. */
  sessionOwner?(sessionId: SessionId): Promise<{ owner: UserId; grants: string[] } | undefined>
  /** Cross-harness subagent spawn seam (#237 [spec:SP-34d7 cross-harness]) —
   *  SessionLifecycle.createSession, the one spawn path. Absent = spawn proc
   *  reports unwired (tests / partial deployments). */
  spawnSession?(input: {
    ownerUserId: UserId
    cwd: string
    agentKind?: string
    initialPrompt?: string
    model?: string
    effort?: string
    forceUnknownModel?: boolean
    issueId?: IssueId
    spawnedBy?: string
    machineId?: MachineId
    /** Curated child session name (spawner-prescribed) [spec:SP-4ef9][spec:SP-eb60]. */
    name?: string
    workflowRunId?: string
    workflowStepId?: string
    /** The agent profile to start from (POD-6107); SessionStart resolves it. */
    agentProfileId?: string
  }): Promise<{
    sessionId: SessionId
    agentId?: string
    harness?: string
    model?: string | null
    effort?: string | null
    machine?: string
    machineId?: MachineId
    accountId?: AccountId | null
    /** The task prompt as the spawner's message, when it was queued as one. */
    promptMessageId?: string
  }>
  /** Wait for the current daemon connection's first inventory before spawning. */
  awaitMachineInventory?(machineId: MachineId): Promise<void>
  /** The launch for a workflow run step that pins an agent profile (POD-6114):
   *  the profile AS THE RUN PINNED IT, its first usable candidate picked, and
   *  the placement re-checked against the caller's current grants. Null when
   *  the step names no profile. */
  resolveWorkflowStepLaunch?(input: {
    runId: string
    stepId: string
    cwd: string
    caller?: MailCaller
  }): Promise<{
    profile: { id: string; name: string }
    agentKind: string
    model: string
    effort: string
    machineId: MachineId | null
  } | null>
  /** An agent profile by name or id (POD-6107), for `agent spawn --profile`. */
  findAgentProfile?(ref: string): Promise<{ id: string; name: string } | null>
  /** The DELIBERATE `--new` issue-create path (never automatic), written with
   *  the spawn command's own writer (POD-6602). */
  createIssue?(
    writer: NonNullable<MailHandlerContext['writer']>,
    input: {
      ownerUserId: UserId
      createdByActor: string
      createdByOnBehalfOf: UserId
      repoPath: string
      title: string
      description?: string
      parentId?: IssueId
      origin: 'human' | 'agent'
    },
  ): Promise<{ id: string }>
  /** The applied-mutation ledger, keyed here by a spawn's `requestId`
   *  (POD-4763): a rerun of `agent spawn` after a lost answer is answered with
   *  the child the first run started. Absent = no dedupe (bare fixtures). */
  mutations?: MutationLedgerPort
  /** Durable ledger for spawn events (best-effort). */
  appendEvent?(e: { ts: string; kind: string; subject: string; payload: unknown }): Promise<void>
  /** await polling seam (tests inject a fake clock/sleep). */
  sleep?(ms: number): Promise<void>
  awaitPollMs?: number
  now?(): string
  /**
   * Consume a notification_facts claim (POD-917/POD-923): when a parent
   * await observes its child settled, clear `sessionparentnudge:phase-reported`
   * so a later genuine re-completion can re-wake once. Optional — absent in
   * partial test harnesses; never required for await correctness.
   */
  retireNotificationFact?(factKey: string, target: string): unknown
  /**
   * THE SYNC WRITE ENTRY POINT (POD-6525). With it, the mail writes go through
   * `submit` from every transport, with that transport's tag; the gate is their
   * adapter. Absent (bare fixtures) = every proc dispatches directly.
   */
  syncWrite?(): Pick<SyncWriteEntry, 'submitDetailed'> | undefined
  /**
   * THE WRITER OF A DIRECT DISPATCH WHOSE CALLER BRINGS NONE (POD-6602). The
   * served gate has none: every mail write is a sync command (POD-6525), or
   * runs inside another command's write and is handed that command's writer.
   * Set only by a gate a test builds by hand, with no entry point.
   */
  directWriter?: MailHandlerContext['writer']
  /**
   * AN AGENT'S SPAWN AS A `session.launch` RECORD (POD-6525). The spawn's write
   * creates the record in its own unit of work; the adapter waits for it.
   * Absent (bare fixtures) = the spawn runs `spawnSession` directly.
   */
  spawnRecord?: SpawnRecordPort
}

/** The `session.launch` record an agent's spawn is (see `MessageGateDeps.spawnRecord`). */
export interface SpawnRecordPort {
  /** No daemon can take it now: refused now, as the start always refused it. Reads only. */
  refuseUnplaceable(
    principal: CommandPrincipal,
    input: { machineId?: MachineId; cwd: string; agentKind?: string },
  ): Promise<void>
  /** The record, created in the write's unit of work under `sessionId`. */
  create(
    writer: NonNullable<MailHandlerContext['writer']>,
    principal: CommandPrincipal,
    launch: { sessionId: SessionId; input: Record<string, unknown> },
  ): Promise<{ effectId: string }>
  /** Wait for the record to settle: what the start answered, or the start's
   *  own refusal thrown. */
  settled(effectId: string): Promise<SpawnSettled>
}

/** What a settled spawn record answers: the start's result. */
export interface SpawnSettled {
  sessionId: string
  agentId?: string
  harness?: string
  model?: string | null
  effort?: string | null
  machine?: string
  machineId?: MachineId
  promptMessageId?: string
}

/** The wire shape `podium mail` renders. */
export interface MessageWire {
  id: string
  threadId: ThreadId
  inReplyTo: string | null
  from: string
  to: string
  kind: string
  urgency: string
  lifecycle: string
  body: string
  createdAt: string
  /** Where delivery stands, forward-only (`MessageDelivery` in @podium/model). */
  deliveryStatus: MessageDeliveryStatus
  /** How the agent program holds it, once it took it (`accepted`, POD-4885):
   *  `memory` or `durable`. Absent until then. */
  held?: MessageHeld
  /** Current 1-based position in the recipient session FIFO, read at projection time. */
  queuePosition?: number
  ackedBy: string | null
  // Delivery-ledger fields (#237) [spec:SP-34d7 web] — additive, so the CLI
  // renderers ignore them; the web ledger view answers "what happened to my
  // message / why didn't my wake fire" from these.
  deliveredAt: string | null
  deliveredTo: string | null
  /** When it was handed on toward `deliveredTo`. A timestamp only: where
   *  delivery stands is `deliveryStatus`, never this stamp [POD-4765]. */
  injectedAt: string | null
  expiresAt: string | null
  /** JSON of the REQUESTED axes when the clamp matrix downgraded them. */
  clampedFrom: string | null
  hop: number
  // Message-lifecycle timestamps (#834 [POD-834 §04d]) — the sender-queryable
  // "what happened to my message" answer that `podium mail status` renders.
  readAt: string | null
  deadLetteredAt: string | null
  deliveryDeferredAt: string | null
  deliveryDeferredReason: string | null
  /** The notice that told the sender this message was not delivered, when one
   *  was written with the failure (POD-4778). */
  noticeId?: string
  /** The entry in the recipient agent's history this message became, once
   *  its machine named it (POD-4774). */
  transcriptItem?: TranscriptItemRef
  /** The recipient agent program's own ids for this message (POD-4841): how
   *  to find it in that program's history. */
  harnessRef?: HarnessRefEntry[]
  /** A reply was requested [POD-835 §04b]: the recipient owes a response and the
   *  settle-nag will fire if none comes. Lets a reader see it must reply. */
  expectsResponse: boolean
}

export class MessageGate {
  /** The shared authz + projection arithmetic (L3), also handed to every joined
   *  handler so there is exactly ONE authz path rather than one per command. */
  private readonly access: MailAccess
  private readonly principalForCapability?: (
    capability: Capability,
  ) => CommandPrincipal | Promise<CommandPrincipal>
  private readonly policyFor?: (
    principal: CommandPrincipal,
  ) =>
    | { ceiling: HumanCeiling; machines: MachineAccess }
    | Promise<{ ceiling: HumanCeiling; machines: MachineAccess }>

  constructor(
    private readonly deps: MessageGateDeps,
    opts?: {
      ceiling?: HumanCeiling
      machines?: MachineAccess
      principalForCapability?: (
        capability: Capability,
      ) => CommandPrincipal | Promise<CommandPrincipal>
      policyFor?: (
        principal: CommandPrincipal,
      ) =>
        | { ceiling: HumanCeiling; machines: MachineAccess }
        | Promise<{ ceiling: HumanCeiling; machines: MachineAccess }>
    },
  ) {
    this.principalForCapability = opts?.principalForCapability
    this.policyFor = opts?.policyFor
    if ((this.principalForCapability === undefined) !== (this.policyFor === undefined)) {
      throw new Error('MessageGate: principalForCapability and policyFor must be wired together')
    }
    if (this.policyFor !== undefined && deps.messages.appliedPolicy !== 'dynamic') {
      throw new Error('MessageGate: principal policy requires dynamic apply-time authorization')
    }
    const ceiling = opts?.ceiling ?? SINGLE_USER_CEILING
    // THE OTHER HALF OF THE CEILING, CHECKED AT BOOT (POD-729).
    //
    // `MailAccess` applies the ceiling when an address is RESOLVED;
    // `MessageDeliveryService.authorizeAtApply` applies it at every DELIVERY.
    // Two ceilings that could disagree is the defect — a gate that refuses an
    // address while the delivery path still accepts it leaks exactly the row the
    // ceiling exists to hide. So the two must be the same OBJECT, and this is
    // where that is verified rather than hoped for. See `mailPolicy()`.
    //
    // Both directions are checked, because both are real mistakes:
    //  - a real ceiling here with NO apply port there = half a ceiling;
    //  - an apply port built from a DIFFERENT object = two ceilings.
    // A harness with neither is the single-user default and is left alone.
    const applied = deps.messages.appliedCeiling
    if (opts?.ceiling !== undefined && applied === undefined) {
      throw new Error(
        'MessageGate: a ceiling was supplied but MessageDeliveryService carries no apply-time port — wire both from mailPolicy()',
      )
    }
    if (applied !== undefined && applied !== ceiling) {
      throw new Error(
        'MessageGate: the delivery service’s apply-time ceiling is a DIFFERENT object from the gate’s — wire both from mailPolicy()',
      )
    }
    this.access = new MailAccess(deps, ceiling, opts?.machines ?? SINGLE_USER_MACHINE_ACCESS)
  }

  /**
   * THE ONLY WAY IN. Undefined = no such proc (the relay shapes its own error).
   *
   * There is no second arm any more: POD-729 cut the last five hand-written
   * procs over to contracts and DELETED the switch this used to fall through to.
   * A proc is a mail command or it is nothing, and either way the answer comes
   * from one table.
   *
   * `transport` is not decoration — it is ADR 3 D3's default-closed exposure
   * check, asked here so it cannot be forgotten by the next transport that wires
   * itself up. A command whose contract does not name this transport is
   * indistinguishable from a command that does not exist.
   */
  async dispatch(
    capability: Capability,
    overrideScope: boolean | undefined,
    proc: string,
    input: unknown,
    transport: TransportTag = 'relay',
    /**
     * The writer of the write this dispatch runs inside (POD-6602): a chat
     * send's `send` is part of the session command's write, so the row it
     * stores is written with that command's writer.
     */
    writer?: MailHandlerContext['writer'],
  ): Promise<unknown | undefined> {
    if (!isMailProcExposedOn(proc, transport)) return undefined
    // A WRITE goes through the sync write entry point (POD-6525): the gate is
    // this transport's adapter. Not from inside someone else's unit of work
    // (a chat send's own write dispatches its `send` here), where the handler
    // runs in that write, directly.
    const entry = this.deps.syncWrite?.()
    if (
      entry !== undefined &&
      isMailWriteProc(proc) &&
      isEntryTransport(transport) &&
      !spanOpen()
    ) {
      const principal = await this.principalOf(capability)
      const submitted = await submitMailWrite(entry, {
        principal,
        transport,
        proc,
        input,
        confirmed: overrideScope === true,
      })
      if (submitted.reply.outcome !== 'applied') throw mailWriteError(proc, submitted)
      const contextOf = async () => await this.handlerContext(principal, overrideScope === true)
      return await answerAsBefore(this.deps, contextOf, proc, input, submitted.reply.result)
    }
    // The AWAIT is a wait and stays here; the claim it retires on seeing its
    // child settle is its own small write on the entry point (POD-6525),
    // submitted once the wait, and its read scope, are over.
    if (
      entry !== undefined &&
      proc === 'awaitAgent' &&
      isEntryTransport(transport) &&
      !spanOpen()
    ) {
      const observed: SessionId[] = []
      const answer = await withReadScope(
        async () =>
          await this.dispatchInScope(capability, overrideScope, proc, input, (child) => {
            observed.push(child)
          }),
      )
      for (const child of observed) {
        await submitAwaitObserved(entry, await this.principalOf(capability), transport, child)
      }
      return answer
    }
    return await withReadScope(
      async () =>
        await this.dispatchInScope(capability, overrideScope, proc, input, undefined, writer),
    )
  }

  /** Retire a parent's wake claim on its child (POD-6525: `mail.awaitObserved`'s
   *  handler, and a direct await's own step). */
  async retireParentNudge(factKey: string, parentSessionId: string): Promise<void> {
    await this.deps.retireNotificationFact?.(factKey, parentSessionId)
  }

  /**
   * THE HANDLER CONTEXT FOR A PRINCIPAL (POD-6525): the caller, the shared
   * authz under the principal's own human ceiling and machines, and the
   * gate's ports. A mail write on the entry point builds it here from the
   * principal the entry point resolved (`inEntry`); a direct dispatch builds
   * the same one.
   */
  async handlerContext(
    principal: CommandPrincipal,
    overrideScope: boolean,
    inEntry = false,
    /** The write's own writer, for what it creates in its unit (POD-6601). */
    writer?: MailHandlerContext['writer'],
  ): Promise<MailHandlerContext> {
    if (principal.kind === 'system') throw new Error('mail: a system principal has no mailbox')
    const policy = await this.policyFor?.(principal)
    const access = policy ? new MailAccess(this.deps, policy.ceiling, policy.machines) : this.access
    return {
      caller: {
        capability: principal.capability,
        principal,
        ...(overrideScope ? { overrideScope: true } : {}),
      },
      deps: this.deps,
      access,
      ...(inEntry ? { inEntry: true } : {}),
      ...(writer !== undefined ? { writer } : {}),
    }
  }

  /** The trail of a spawn the budget refused (POD-6525): its event, written
   *  after the write it refused rolled back. Best-effort, as it always was. */
  async recordSpawnRefusal(refused: SpawnBudgetExhausted): Promise<void> {
    try {
      await this.deps.appendEvent?.(refused.event(this.deps.now?.() ?? new Date().toISOString()))
    } catch {}
  }

  /** The caller as a principal: the composition root's resolver, else the async
   *  delegation walk. */
  private async principalOf(capability: Capability): Promise<CommandPrincipal> {
    return (
      (await this.principalForCapability?.(capability)) ??
      // THE ASYNC TWIN, not a widened sync resolver. `resolvePrincipalAsync` is
      // the existing sanctioned shape for a delegation walk whose parent lookup
      // is a durable read; the composition root supplies
      // `principalForCapability` and this fallback is what a fixture that does
      // not gets. Using it here keeps `resolvePrincipal` — the synchronous
      // delegation resolver — untouched, which is the boundary the ruling on
      // rule 51 case 2 protects.
      (await resolvePrincipalAsync(capability, {
        parentSessionOf: async (sessionId) =>
          spawnedByParentSessionId((await this.deps.sessionById(sessionId))?.spawnedBy),
      }))
    )
  }

  private async dispatchInScope(
    capability: Capability,
    overrideScope: boolean | undefined,
    proc: string,
    input: unknown,
    observed?: (child: SessionId) => void,
    given?: MailHandlerContext['writer'],
  ): Promise<unknown> {
    const writer = given ?? this.deps.directWriter
    const principal = await this.principalOf(capability)
    const policy = await this.policyFor?.(principal)
    const access = policy ? new MailAccess(this.deps, policy.ceiling, policy.machines) : this.access
    const caller = {
      capability,
      principal,
      ...(overrideScope ? { overrideScope: true } : {}),
    }
    const ctx: MailHandlerContext = {
      caller,
      deps: this.deps,
      access,
      ...(observed ? { observed } : {}),
      ...(writer !== undefined ? { writer } : {}),
    }
    // Invoked SYNCHRONOUSLY, with a sync throw converted to a rejection.
    //
    // Every awaiting caller sees exactly what `Promise.resolve().then(…)` gave
    // them; what this preserves is the shipped `ask` behaviour, where the
    // question row is written before dispatch returns rather than a microtask
    // later. Deferring it was a timing change nobody asked for, and the kind
    // that surfaces as a flake in someone else's suite six weeks on.
    try {
      return await Promise.resolve(await dispatchMailCommand(proc as MailProcName, ctx, input))
    } catch (error) {
      return await Promise.reject(error)
    }
  }
}

/** The transports with an adapter onto the entry point; a mail contract names no other. */
const isEntryTransport = (transport: TransportTag): transport is FrontDoorTransport =>
  transport === 'trpc' || transport === 'cli' || transport === 'mcp' || transport === 'relay'

/** Re-exported for the handlers and the relay arm: the message row shape they
 *  project. Keeps `MessageRow` off every handler's import list. */
export type { MessageRow }
