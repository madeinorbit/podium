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
import type { IssueId, SessionId, SessionMeta } from '@podium/model'
import type { Capability } from '../../issue-authz'
import type { CommandPrincipal } from '../../command-principal'
import type { MessageRow } from '../../store'
import type { IssueService } from '../issues/service'
import {
  type MachineAccess,
  MailAccess,
  type MailDeliveryMode,
  type MailCaller,
  type MailHandlerContext,
  SINGLE_USER_MACHINE_ACCESS,
} from './handlers/context'
import { dispatchMailCommand, isMailProcExposedOn, type MailProcName } from './registry'
import type { MessageDeliveryService } from './service'

export interface MessageGateDeps {
  messages(): MessageDeliveryService
  issues(): IssueService
  listSessions(): SessionMeta[]
  /** Cross-harness subagent spawn seam (#237 [spec:SP-34d7 cross-harness]) —
   *  SessionsService.createSession, the one spawn path. Absent = spawn proc
   *  reports unwired (tests / partial deployments). */
  spawnSession?(input: {
    cwd: string
    agentKind?: string
    initialPrompt?: string
    model?: string
    effort?: string
    accountId?: string
    forceUnknownModel?: boolean
    issueId?: IssueId
    spawnedBy?: string
    machineId?: string
    /** Curated child session name (spawner-prescribed) [spec:SP-4ef9][spec:SP-eb60]. */
    name?: string
    workflowRunId?: string
    workflowStepId?: string
    executionProfileId?: string
  }): {
    sessionId: SessionId
    agentId?: string
    harness?: string
    model?: string | null
    effort?: string | null
    machine?: string
    machineId?: string
    accountId?: string | null
  }
  /** Resolve a named workflow execution profile. When a run + step are present,
   *  the workflow service returns the immutable snapshot pinned to that run. */
  resolveExecutionProfile?(input: {
    profileId: string
    runId?: string
    stepId?: string
    caller?: MailCaller
  }): {
    id: string
    accountId: string
    machineId: string | null
    harness: string
    model: string
    effort: string
  }
  /** The DELIBERATE `--new` issue-create path (never automatic). */
  createIssue?(input: {
    repoPath: string
    title: string
    description?: string
    parentId?: IssueId
    origin: 'human' | 'agent'
  }): { id: string }
  /** Durable ledger for spawn events (best-effort). */
  appendEvent?(e: { ts: string; kind: string; subject: string; payload: unknown }): void
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
  retireNotificationFact?(factKey: string, target: string): void
}

/** The wire shape `podium mail` renders. */
export interface MessageWire {
  id: string
  threadId: string
  inReplyTo: string | null
  from: string
  to: string
  kind: string
  urgency: string
  lifecycle: string
  body: string
  createdAt: string
  status: string
  ackedBy: string | null
  // Delivery-ledger fields (#237) [spec:SP-34d7 web] — additive, so the CLI
  // renderers ignore them; the web ledger view answers "what happened to my
  // message / why didn't my wake fire" from these.
  deliveredAt: string | null
  deliveredTo: string | null
  expiresAt: string | null
  /** JSON of the REQUESTED axes when the clamp matrix downgraded them. */
  clampedFrom: string | null
  hop: number
  // Message-lifecycle timestamps (#834 [POD-834 §04d]) — the sender-queryable
  // "what happened to my message" answer that `podium mail status` renders.
  readAt: string | null
  deadLetteredAt: string | null
  /** A reply was requested [POD-835 §04b]: the recipient owes a response and the
   *  settle-nag will fire if none comes. Lets a reader see it must reply. */
  expectsResponse: boolean
}

export class MessageGate {
  /** The shared authz + projection arithmetic (L3), also handed to every joined
   *  handler so there is exactly ONE authz path rather than one per command. */
  private readonly access: MailAccess
  private readonly principalForCapability?: (capability: Capability) => CommandPrincipal
  private readonly policyFor?: (principal: CommandPrincipal) => {
    ceiling: HumanCeiling
    machines: MachineAccess
  }

  constructor(
    private readonly deps: MessageGateDeps,
    opts?: {
      ceiling?: HumanCeiling
      machines?: MachineAccess
      principalForCapability?: (capability: Capability) => CommandPrincipal
      policyFor?: (principal: CommandPrincipal) => {
        ceiling: HumanCeiling
        machines: MachineAccess
      }
    },
  ) {
    this.principalForCapability = opts?.principalForCapability
    this.policyFor = opts?.policyFor
    if ((this.principalForCapability === undefined) !== (this.policyFor === undefined)) {
      throw new Error('MessageGate: principalForCapability and policyFor must be wired together')
    }
    if (this.policyFor !== undefined && deps.messages().appliedPolicy !== 'dynamic') {
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
    const applied = deps.messages().appliedCeiling
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
  dispatch(
    capability: Capability,
    overrideScope: boolean | undefined,
    proc: string,
    input: unknown,
    transport: TransportTag = 'relay',
    deliveryMode?: MailDeliveryMode,
  ): Promise<unknown> | undefined {
    if (!isMailProcExposedOn(proc, transport)) return undefined
    const principal = this.principalForCapability?.(capability)
    const policy = principal && this.policyFor ? this.policyFor(principal) : undefined
    const access = policy ? new MailAccess(this.deps, policy.ceiling, policy.machines) : this.access
    const caller = {
      capability,
      ...(principal ? { principal } : {}),
      ...(overrideScope ? { overrideScope: true } : {}),
    }
    const ctx: MailHandlerContext = {
      caller,
      deps: this.deps,
      access,
      ...(deliveryMode ? { deliveryMode } : {}),
    }
    // Invoked SYNCHRONOUSLY, with a sync throw converted to a rejection.
    //
    // Every awaiting caller sees exactly what `Promise.resolve().then(…)` gave
    // them; what this preserves is the shipped `ask` behaviour, where the
    // question row is written before dispatch returns rather than a microtask
    // later. Deferring it was a timing change nobody asked for, and the kind
    // that surfaces as a flake in someone else's suite six weeks on.
    try {
      return Promise.resolve(dispatchMailCommand(proc as MailProcName, ctx, input))
    } catch (error) {
      return Promise.reject(error)
    }
  }
}

/** Re-exported for the handlers and the relay arm: the message row shape they
 *  project. Keeps `MessageRow` off every handler's import list. */
export type { MessageRow }
