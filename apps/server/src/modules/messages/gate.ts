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
// Cross-harness subagent spawn (#237) [spec:SP-34d7 cross-harness]. The child
// is a FULL Podium session (real PTY, human-attachable) spawned through the
// existing session machinery; `newTitle` is the DELIBERATE `--new` issue-create
// path — an issue is never auto-created when `issue` is supplied. The workflow
// fields are #285 pass-through metadata: stored on the child, never interpreted.
const spawnAgentInput = z.object({
  issue: z.string().optional(),
  newTitle: z.string().min(1).optional(),
  /** Repo for --new when the caller has no issue scope to inherit from. */
  repo: z.string().optional(),
  harness: z.string().optional(),
  prompt: z.string().min(1).max(32_768),
  worktree: z.boolean().optional(),
  model: z.string().optional(),
  effort: z.string().optional(),
  workflowRunId: z.string().max(256).optional(),
  workflowStepId: z.string().max(256).optional(),
  executionProfileId: z.string().max(256).optional(),
})
// Bounded parent wait [spec:SP-34d7 cross-harness]: ALWAYS returns — the
// child's ack/settle result, or "still working" + a status snapshot at timeout.
const awaitAgentInput = z.object({
  sessionId: z.string(),
  timeoutSeconds: z.number().min(0).max(300).optional(),
})
// The seance [spec:SP-34d7 read-toolkit tier 4]: a `question` message
// (next-turn + wake, ack expected) + a bounded wait for the answer. Not a new
// mechanism — it rides the send pipeline, so the clamp matrix, wake cooldown
// and hop brake all apply unchanged (it costs a turn of the target's quota).
const askInput = z.object({
  sessionId: z.string(),
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
    issueId?: string
    spawnedBy?: string
    machineId?: string
    workflowRunId?: string
    workflowStepId?: string
    executionProfileId?: string
  }): { sessionId: string }
  /** The DELIBERATE `--new` issue-create path (never automatic). */
  createIssue?(input: {
    repoPath: string
    title: string
    description?: string
    parentId?: string
    origin: 'human' | 'agent'
  }): { id: string }
  /** Durable ledger for spawn events (best-effort). */
  appendEvent?(e: { ts: string; kind: string; subject: string; payload: unknown }): void
  /** await polling seam (tests inject a fake clock/sleep). */
  sleep?(ms: number): Promise<void>
  awaitPollMs?: number
  now?(): string
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
      case 'spawnAgent':
        return Promise.resolve().then(() => this.spawnAgent(caller, spawnAgentInput.parse(input)))
      case 'awaitAgent':
        return this.awaitAgent(caller, awaitAgentInput.parse(input))
      case 'ask':
        return this.ask(caller, askInput.parse(input))
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

  // ---- cross-harness subagents (#237) [spec:SP-34d7 cross-harness] ----

  /**
   * `podium agent spawn`: a full Podium session on the target issue, via the
   * ONE spawn path (SessionsService.createSession). Authz = write access to
   * the target issue (same posture as messages.send). The caller becomes the
   * child's parent (spawnedBy 'session:<id>') — which is what unlocks the
   * parent-grade clamps (interrupt + wake) the clamp matrix already implements.
   * No issue is EVER auto-created: `newTitle` is the explicit --new path.
   */
  private spawnAgent(
    caller: { capability: Capability; overrideScope?: boolean },
    input: z.infer<typeof spawnAgentInput>,
  ): unknown {
    if (!this.deps.spawnSession) throw new Error('agent spawn is not wired on this server')
    const issues = this.deps.issues()
    if (input.issue && input.newTitle) throw new Error('pass --issue OR --new, not both')
    let issueId: string
    if (input.issue) {
      issueId = issues.resolveRef(input.issue)
      checkIssueAccess(caller, issues, 'agent.spawn', 'write', issueId)
    } else if (input.newTitle) {
      if (!this.deps.createIssue) throw new Error('issue creation is not wired on this server')
      // Deliberate --new: inherit the caller's repo/parent from its own issue
      // scope when it has one (keeps the child inside the parent's subtree);
      // otherwise --repo names the repository explicitly.
      const scopeIssue =
        caller.capability.scope.kind === 'subtree'
          ? issues.get(caller.capability.scope.rootId ?? '')
          : null
      const repoPath = input.repo ?? scopeIssue?.repoPath
      if (!repoPath) throw new Error('--new needs --repo (no issue scope to inherit a repo from)')
      issueId = this.deps.createIssue({
        repoPath,
        title: input.newTitle,
        description: input.prompt,
        ...(scopeIssue ? { parentId: scopeIssue.id } : {}),
        origin: caller.capability.scope.kind === 'all' ? 'human' : 'agent',
      }).id
    } else {
      throw new Error('pass --issue <ref> or --new "title"')
    }
    const issue = issues.get(issueId)
    if (!issue) throw new Error(`unknown issue ${issueId}`)
    if (input.worktree && !issue.worktreePath) {
      // Starting an issue (worktree + branch) stays a deliberate coordinator
      // action — podium issue start owns that flow; spawn never forks a second one.
      throw new Error(`issue #${issue.seq} has no worktree — run \`podium issue start\` first`)
    }
    const cwd = issue.worktreePath ?? issue.repoPath
    const spawnedBy = caller.capability.actorSessionId
      ? `session:${caller.capability.actorSessionId}`
      : caller.capability.scope.kind === 'all'
        ? 'user'
        : 'agent'
    const { sessionId } = this.deps.spawnSession({
      cwd,
      agentKind: input.harness ?? issue.defaultAgent,
      initialPrompt: input.prompt,
      issueId,
      spawnedBy,
      ...(input.model ? { model: input.model } : {}),
      ...(input.effort ? { effort: input.effort } : {}),
      ...(issue.machineId ? { machineId: issue.machineId } : {}),
      // #285 pass-through — stored on the child, never interpreted here.
      ...(input.workflowRunId ? { workflowRunId: input.workflowRunId } : {}),
      ...(input.workflowStepId ? { workflowStepId: input.workflowStepId } : {}),
      ...(input.executionProfileId ? { executionProfileId: input.executionProfileId } : {}),
    })
    try {
      this.deps.appendEvent?.({
        ts: this.deps.now?.() ?? new Date().toISOString(),
        kind: 'agent.spawned',
        subject: sessionId,
        payload: {
          sessionId,
          issueId,
          spawnedBy,
          harness: input.harness ?? issue.defaultAgent,
          ...(input.workflowRunId ? { workflowRunId: input.workflowRunId } : {}),
          ...(input.workflowStepId ? { workflowStepId: input.workflowStepId } : {}),
        },
      })
    } catch {}
    return { ok: true, sessionId, issueId, issueSeq: issue.seq, cwd }
  }

  /**
   * `podium agent await <sessionId>`: bounded wait for the child. Returns the
   * child's ack (a `kind: ack` row from that session addressed back to the
   * caller since the wait began) or its settle state — or, at the deadline,
   * "still working" plus a status snapshot. NEVER hangs (every wait bounded —
   * the codex-plugin-cc lesson).
   */
  private async awaitAgent(
    caller: { capability: Capability; overrideScope?: boolean },
    input: z.infer<typeof awaitAgentInput>,
  ): Promise<unknown> {
    // The parent relationship (spawnedBy provenance) is sufficient authority to
    // await its own child — even across issue scopes (it already crossed them,
    // confirmed, at spawn time). Everyone else passes the session-target gate.
    const child = this.deps.listSessions().find((x) => x.sessionId === input.sessionId)
    const isParent =
      caller.capability.actorSessionId !== undefined &&
      child?.spawnedBy === `session:${caller.capability.actorSessionId}`
    if (!isParent) this.assertSessionTargetAccess(caller, input.sessionId, 'agent.await')
    const svc = this.deps.messages()
    const timeoutMs = (input.timeoutSeconds ?? 30) * 1000
    const pollMs = this.deps.awaitPollMs ?? 500
    const sleep = this.deps.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)))
    const principals = this.callerPrincipals(caller.capability)
    const deadline = Date.now() + timeoutMs
    // biome-ignore lint/nursery/noConstantCondition: loop exits via return
    for (;;) {
      const s = this.deps.listSessions().find((x) => x.sessionId === input.sessionId)
      if (!s) return { done: true, result: 'gone', snapshot: null }
      // Rich agent ack first (it carries WHAT the child did): the child's most
      // recent ack addressed back to this caller.
      const ack = svc
        .inbox(principals, { limit: 50 })
        .filter((m) => m.kind === 'ack' && m.fromSession === input.sessionId)
        .at(-1)
      if (ack) return { done: true, result: 'acked', ack: this.wire(ack), snapshot: snap(s) }
      // … else a settle (parked, or the harness reports a settled phase).
      const phase = s.agentState?.phase
      if (
        s.status === 'hibernated' ||
        s.status === 'exited' ||
        phase === 'idle' ||
        phase === 'needs_user' ||
        phase === 'errored' ||
        phase === 'ended'
      ) {
        return { done: true, result: 'settled', snapshot: snap(s) }
      }
      if (Date.now() >= deadline) return { done: false, result: 'working', snapshot: snap(s) }
      await sleep(Math.min(pollMs, Math.max(1, deadline - Date.now())))
    }
    function snap(s: SessionMeta) {
      return {
        sessionId: s.sessionId,
        status: s.status,
        ...(s.agentState?.phase ? { phase: s.agentState.phase } : {}),
        title: s.title,
        ...(s.issueId ? { issueId: s.issueId } : {}),
        ...(s.lastActiveAt ? { lastActiveAt: s.lastActiveAt } : {}),
        ...(s.queuedMessageCount ? { queuedMessageCount: s.queuedMessageCount } : {}),
      }
    }
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
    this.assertSessionTargetAccess(caller, input.sessionId, 'messages.ask')
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
