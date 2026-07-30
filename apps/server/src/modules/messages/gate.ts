/**
 * The `messages` command surface (#237) [spec:SP-34d7 acks/read-toolkit]:
 * `podium mail send/inbox/show/reply` and the stop-hook's pendingReminders,
 * served to BOTH the daemon relay (agent capability) and the tRPC router
 * (operator). Sender identity is stamped from the capability — client input
 * never contributes sender fields (mailIdentity pattern).
 *
 * POD-728 split this file along ADR 3 D1's line. The five agent-mail mutations
 * (`send`, `reply`, `spawnAgent`, `awaitAgent`, `inbox`) plus the `ledger` query
 * are now CONTRACT + HANDLER pairs: the contracts are L1 data in
 * `@podium/commands`, the handlers are in `./handlers`, and `./registry.ts`
 * joins them. What is left here is the shipped hand-written remainder
 * (`show`, `dismiss`, `status`, `pendingReminders`, `ask`), which POD-729 cuts
 * over and deletes.
 *
 * The two structural properties the migration preserves, deliberately:
 *  - ONE authz path. Both transports dispatch through this class into the same
 *    `MailAccess`; the relay arm and the tRPC arm share it verbatim.
 *  - Sender identity from the capability, never from payload (ADR 3 D7 / the
 *    mailIdentity pattern) — `senderFromCapability` is still the single site.
 */

import { type HumanCeiling, SINGLE_USER_CEILING } from '@podium/commands'
import { IssueIdField, type IssueId, type SessionId, SessionIdField, type SessionMeta } from '@podium/model'
import { z } from 'zod'
import type { Capability } from '../../issue-authz'
import type { MessageRow } from '../../store'
import type { IssueService } from '../issues/service'
import {
  type MachineAccess,
  MailAccess,
  type MailHandlerContext,
  SINGLE_USER_MACHINE_ACCESS,
} from './handlers/context'
import { dispatchMailCommand, isMailProc } from './registry'
import { type MessageDeliveryService, senderFromCapability } from './service'

const showInput = z.object({ id: z.string() })
const dismissInput = z.object({ id: z.string() })
// Sender-queryable lifecycle (#834 [POD-834 §04d]): "what happened to the
// message I sent?" — reachable by the sender/recipient (not operator-only like
// the ledger), so an agent can pull delivered/read/dead_letter after a
// synchronous send returned at queued.
const statusInput = z.object({ id: z.string() })
// The seance [spec:SP-34d7 read-toolkit tier 4]: a `question` message
// (next-turn + wake, ack expected) + a bounded wait for the answer. Not a new
// mechanism — it rides the send pipeline, so the clamp matrix, wake cooldown
// and hop brake all apply unchanged (it costs a turn of the target's quota).
const askInput = z.object({
  sessionId: SessionIdField,
  question: z.string().min(1).max(32_768),
  timeoutSeconds: z.number().min(0).max(300).optional(),
})

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
  resolveExecutionProfile?(input: { profileId: string; runId?: string; stepId?: string }): {
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

  constructor(
    private readonly deps: MessageGateDeps,
    opts?: { ceiling?: HumanCeiling; machines?: MachineAccess },
  ) {
    this.access = new MailAccess(
      deps,
      opts?.ceiling ?? SINGLE_USER_CEILING,
      opts?.machines ?? SINGLE_USER_MACHINE_ACCESS,
    )
  }

  /** Undefined = no such proc (the relay shapes its own error). */
  dispatch(
    capability: Capability,
    overrideScope: boolean | undefined,
    proc: string,
    input: unknown,
  ): Promise<unknown> | undefined {
    const caller = { capability, ...(overrideScope ? { overrideScope: true } : {}) }
    // THE MIGRATED PATH (POD-728): contract + handler pairs, validated through
    // the contract's own schema. Everything in the switch below is still
    // hand-written and is POD-729's cutover.
    if (isMailProc(proc)) {
      const ctx: MailHandlerContext = { caller, deps: this.deps, access: this.access }
      return Promise.resolve().then(() => dispatchMailCommand(proc, ctx, input))
    }
    switch (proc) {
      case 'show':
        return Promise.resolve().then(() => this.show(caller, showInput.parse(input)))
      case 'dismiss':
        return Promise.resolve().then(() => this.dismiss(caller, dismissInput.parse(input)))
      case 'status':
        return Promise.resolve().then(() => this.status(caller, statusInput.parse(input)))
      case 'pendingReminders':
        return Promise.resolve().then(() => this.pendingReminders(caller))
      case 'ask':
        return this.ask(caller, askInput.parse(input))
      default:
        return undefined
    }
  }

  /** Sender-queryable message lifecycle [POD-834 §04d]: the sender (or recipient,
   *  or operator) pulls "what happened to msg X" after a synchronous send returned
   *  at queued. Same mayView gate as `show` — you may query a message you sent or
   *  received, never a stranger's. */
  private status(
    caller: { capability: Capability },
    input: z.infer<typeof statusInput>,
  ): MessageWire {
    const m = this.deps.messages().message(input.id)
    if (!m) throw new Error(`unknown message ${input.id}`)
    if (!this.access.mayView(caller.capability, m)) {
      throw new Error('not allowed to view a message you neither sent nor received')
    }
    return this.access.wire(m)
  }

  private show(caller: { capability: Capability }, input: z.infer<typeof showInput>): MessageWire {
    const m = this.deps.messages().message(input.id)
    if (!m) throw new Error(`unknown message ${input.id}`)
    if (!this.access.mayView(caller.capability, m)) {
      throw new Error('not allowed to view a message you neither sent nor received')
    }
    return this.access.wire(m)
  }

  private dismiss(
    caller: { capability: Capability },
    input: z.infer<typeof dismissInput>,
  ): MessageWire {
    const svc = this.deps.messages()
    const message = svc.message(input.id)
    if (!message) throw new Error(`unknown message ${input.id}`)
    if (
      caller.capability.scope.kind !== 'all' &&
      !this.access.isRecipient(caller.capability, message)
    ) {
      throw new Error('only the recipient of a message may dismiss it')
    }
    return this.access.wire(svc.dismiss(message.id, caller.capability.actorSessionId ?? null))
  }

  /** Stop-hook single-reminder query: the CALLING session's delivered-but-
   *  unacked non-fyi messages, marked reminded on return (never repeats). */
  private pendingReminders(caller: {
    capability: Capability
  }): { id: string; from: string; body: string }[] {
    const sessionId = caller.capability.actorSessionId
    if (!sessionId) return []
    return this.deps.messages().pendingReminders(sessionId)
  }

  /**
   * `podium session ask <id> --question "…"` — the seance [spec:SP-34d7
   * read-toolkit tier 4]. Implemented AS A MESSAGE: a `kind:'question'` row at
   * next-turn + wake whose server-rendered envelope constrains the receiver to
   * answer-then-resume; a dead/parked target wakes via harness-native resume so
   * the predecessor's full context answers, and only the answer (the ack)
   * crosses back. Authz = the session-target gate (same as send); the send
   * pipeline's clamps/cooldown apply unchanged — a question is never exempt.
   * The wait is BOUNDED: the answer, or "no answer yet" + a status snapshot.
   */
  private async ask(
    caller: { capability: Capability; overrideScope?: boolean },
    input: z.infer<typeof askInput>,
  ): Promise<unknown> {
    this.access.assertSessionTargetAccess(caller, input.sessionId, 'messages.ask')
    const svc = this.deps.messages()
    const r = svc.send(senderFromCapability(caller.capability), {
      to: { kind: 'session', id: input.sessionId },
      body: input.question,
      kind: 'question',
      urgency: 'next-turn',
      lifecycle: 'wake',
    })
    const sleep = this.deps.sleep ?? undefined
    const ack = await svc.awaitAck(r.message.id, {
      timeoutMs: (input.timeoutSeconds ?? 30) * 1000,
      ...(this.deps.awaitPollMs !== undefined ? { pollMs: this.deps.awaitPollMs } : {}),
      ...(sleep ? { sleep } : {}),
    })
    const target = this.deps.listSessions().find((s) => s.sessionId === input.sessionId)
    const snapshot = target
      ? {
          sessionId: target.sessionId,
          status: target.status,
          ...(target.agentState?.phase ? { phase: target.agentState.phase } : {}),
          ...(target.issueId ? { issueId: target.issueId } : {}),
        }
      : null
    if (ack) {
      return {
        answered: true,
        questionId: r.message.id,
        answer: ack.body,
        ackId: ack.id,
        snapshot,
      }
    }
    return {
      answered: false,
      questionId: r.message.id,
      reason: 'no answer yet — the question is delivered/queued; check back or await the ack',
      ...(r.message.clampedFrom ? { clamped: true } : {}),
      snapshot,
    }
  }
}

/** Re-exported for the handlers and the relay arm: the message row shape they
 *  project. Keeps `MessageRow` off every handler's import list. */
export type { MessageRow }
