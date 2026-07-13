/**
 * The `messages` command surface (#237) [spec:SP-34d7 acks/read-toolkit]:
 * `podium mail send/inbox/show/reply` and the stop-hook's pendingReminders,
 * served to BOTH the daemon relay (agent capability) and the tRPC router
 * (operator). Sender identity is stamped from the capability — client input
 * never contributes sender fields (mailIdentity pattern).
 */

import type { SessionMeta } from '@podium/protocol'
import { z } from 'zod'
import { type Capability, checkIssueAccess } from '../../issue-authz'
import type { MessageRow } from '../../store'
import type { IssueService } from '../issues/service'
import { type MessageDeliveryService, senderFromCapability } from './service'

const sendInput = z.object({
  to: z.string().min(1),
  body: z.string().min(1).max(32_768),
  urgency: z.enum(['fyi', 'next-turn', 'interrupt']).optional(),
  lifecycle: z.enum(['wait', 'wake']).optional(),
})
const inboxInput = z.object({ issue: z.string().optional() }).optional()
const showInput = z.object({ id: z.string() })
const replyInput = z.object({
  id: z.string(),
  body: z.string().min(1).max(32_768),
  kind: z.enum(['ack', 'message']).optional(),
})

export interface MessageGateDeps {
  messages(): MessageDeliveryService
  issues(): IssueService
  listSessions(): SessionMeta[]
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
}

export class MessageGate {
  constructor(private readonly deps: MessageGateDeps) {}

  /** Undefined = no such proc (the relay shapes its own error). */
  dispatch(
    capability: Capability,
    overrideScope: boolean | undefined,
    proc: string,
    input: unknown,
  ): Promise<unknown> | undefined {
    const caller = { capability, ...(overrideScope ? { overrideScope: true } : {}) }
    switch (proc) {
      case 'send':
        return Promise.resolve().then(() => this.send(caller, sendInput.parse(input)))
      case 'inbox':
        return Promise.resolve().then(() => this.inbox(caller, inboxInput.parse(input)))
      case 'show':
        return Promise.resolve().then(() => this.show(caller, showInput.parse(input)))
      case 'reply':
        return Promise.resolve().then(() => this.reply(caller, replyInput.parse(input)))
      case 'pendingReminders':
        return Promise.resolve().then(() => this.pendingReminders(caller))
      default:
        return undefined
    }
  }

  private send(
    caller: { capability: Capability; overrideScope?: boolean },
    input: z.infer<typeof sendInput>,
  ): unknown {
    const svc = this.deps.messages()
    const to = this.resolveRecipient(input.to)
    if (to.kind === 'session') {
      this.assertSessionTargetAccess(caller, to.id, 'messages.send')
    } else {
      // Issue-addressed: a write gated against the RESOLVED target issue
      // [spec:SP-34d7 authz] — messages carry urgency/lifecycle (wake →
      // resurrect / spawn), so unlike append-only mailSend a cross-subtree
      // send needs the --outside-scope confirmation. The confirmation only
      // crosses scope; it never elevates the clamp matrix. The spawn-on-wake
      // seam is downstream of this same check, so a spawn always required
      // write access to the target issue.
      checkIssueAccess(caller, this.deps.issues(), 'messages.send', 'write', to.id)
    }
    const r = svc.send(senderFromCapability(caller.capability), {
      to,
      body: input.body,
      ...(input.urgency ? { urgency: input.urgency } : {}),
      ...(input.lifecycle ? { lifecycle: input.lifecycle } : {}),
    })
    return {
      id: r.message.id,
      ok: r.ok,
      ...(r.queued !== undefined ? { queued: r.queued } : {}),
      ...(r.reason !== undefined ? { reason: r.reason } : {}),
      urgency: r.message.urgency,
      lifecycle: r.message.lifecycle,
      ...(r.message.clampedFrom ? { clamped: true } : {}),
    }
  }

  private inbox(
    caller: { capability: Capability },
    input: z.infer<typeof inboxInput>,
  ): MessageWire[] {
    const svc = this.deps.messages()
    if (input?.issue) {
      // Peek at a named issue's box: a read (scope-free, like mailInbox peeks) —
      // never consumes queued status unless it IS the caller's own issue.
      const id = this.deps.issues().resolveRef(input.issue)
      const own =
        caller.capability.scope.kind === 'subtree' && caller.capability.scope.rootId === id
      const consume = own ? (caller.capability.actorSessionId ?? null) : undefined
      return svc
        .readInbox([{ kind: 'issue', id }], consume !== undefined ? { consume } : {})
        .map((m) => this.wire(m))
    }
    const principals = this.callerPrincipals(caller.capability)
    if (principals.length === 0) throw new Error('no mailbox bound to this caller')
    return svc
      .readInbox(principals, { consume: caller.capability.actorSessionId ?? null })
      .map((m) => this.wire(m))
  }

  private show(caller: { capability: Capability }, input: z.infer<typeof showInput>): MessageWire {
    const m = this.deps.messages().message(input.id)
    if (!m) throw new Error(`unknown message ${input.id}`)
    if (!this.mayView(caller.capability, m)) {
      throw new Error('not allowed to view a message you neither sent nor received')
    }
    return this.wire(m)
  }

  private reply(caller: { capability: Capability }, input: z.infer<typeof replyInput>): unknown {
    const svc = this.deps.messages()
    const original = svc.message(input.id)
    if (!original) throw new Error(`unknown message ${input.id}`)
    // Only the RECIPIENT (or the operator) replies — the reply routes to the
    // original's sender, so recipient-ship is the natural authz boundary.
    if (caller.capability.scope.kind !== 'all' && !this.isRecipient(caller.capability, original)) {
      throw new Error('only the recipient of a message may reply to it')
    }
    const r = svc.sendReply(senderFromCapability(caller.capability), {
      inReplyTo: original.id,
      body: input.body,
      kind: input.kind ?? 'ack',
    })
    return {
      id: r.message.id,
      ok: r.ok,
      acked: (input.kind ?? 'ack') === 'ack',
      ...(r.queued !== undefined ? { queued: r.queued } : {}),
      ...(r.reason !== undefined ? { reason: r.reason } : {}),
    }
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

  // ---- helpers ----

  /** `to` is a session id when it names a known session, else an issue ref. */
  private resolveRecipient(
    to: string,
  ): { kind: 'issue'; id: string } | { kind: 'session'; id: string } {
    if (this.deps.listSessions().some((s) => s.sessionId === to)) {
      return { kind: 'session', id: to }
    }
    return { kind: 'issue', id: this.deps.issues().resolveRef(to) }
  }

  /** The session-target containment gate — same posture as the relay sessions
   *  slice (#237 authz): issue-bound targets need write access to that issue;
   *  issueless targets are parent/operator-only (--outside-scope never
   *  substitutes there). */
  private assertSessionTargetAccess(
    caller: { capability: Capability; overrideScope?: boolean },
    sessionId: string,
    proc: string,
  ): void {
    const target = this.deps.listSessions().find((s) => s.sessionId === sessionId)
    if (!target) throw new Error('session not found')
    const issues = this.deps.issues()
    const targetIssueId = target.issueId ?? issues.issueForCwd(target.cwd)
    if (targetIssueId) {
      checkIssueAccess(caller, issues, proc, 'write', targetIssueId)
      return
    }
    const isOperator = caller.capability.scope.kind === 'all'
    const isParent =
      caller.capability.actorSessionId !== undefined &&
      target.spawnedBy === `session:${caller.capability.actorSessionId}`
    if (!isOperator && !isParent) {
      throw new Error('target session has no issue; only its parent or the operator may message it')
    }
  }

  /** The mailbox principals a capability owns: its issue subtree root and its
   *  own session; the operator owns the operator box. */
  private callerPrincipals(
    capability: Capability,
  ): { kind: 'issue' | 'session' | 'operator'; id?: string }[] {
    if (capability.scope.kind === 'all') return [{ kind: 'operator' }]
    const out: { kind: 'issue' | 'session' | 'operator'; id?: string }[] = []
    if (capability.scope.kind === 'subtree') {
      out.push({ kind: 'issue', id: capability.scope.rootId })
    }
    if (capability.actorSessionId) out.push({ kind: 'session', id: capability.actorSessionId })
    return out
  }

  private isRecipient(capability: Capability, m: MessageRow): boolean {
    if (m.deliveredTo && m.deliveredTo === capability.actorSessionId) return true
    return this.callerPrincipals(capability).some(
      (p) => p.kind === m.toKind && (p.kind === 'operator' || p.id === m.toId),
    )
  }

  private mayView(capability: Capability, m: MessageRow): boolean {
    if (capability.scope.kind === 'all') return true
    if (this.isRecipient(capability, m)) return true
    // The sender may re-read what it sent.
    if (m.fromSession && m.fromSession === capability.actorSessionId) return true
    return (
      m.fromKind === 'agent' &&
      capability.scope.kind === 'subtree' &&
      m.fromIssue === capability.scope.rootId
    )
  }

  private wire(m: MessageRow): MessageWire {
    const issues = this.deps.issues()
    const label = (kind: string, issueId: string | null, sessionId: string | null): string => {
      if (kind === 'agent' || kind === 'issue') {
        if (issueId) {
          const issue = issues.get(issueId)
          if (issue) return `issue:#${issue.seq}`
          return issueId
        }
        if (sessionId) return `session:${sessionId}`
      }
      if (kind === 'session' && sessionId) return `session:${sessionId}`
      return kind
    }
    return {
      id: m.id,
      threadId: m.threadId,
      inReplyTo: m.inReplyTo,
      from: label(m.fromKind, m.fromIssue, m.fromSession),
      to: label(
        m.toKind,
        m.toKind === 'issue' ? m.toId : null,
        m.toKind === 'session' ? m.toId : null,
      ),
      kind: m.kind,
      urgency: m.urgency,
      lifecycle: m.lifecycle,
      body: m.body,
      createdAt: m.createdAt,
      status: m.status,
      ackedBy: m.ackedBy,
    }
  }
}
