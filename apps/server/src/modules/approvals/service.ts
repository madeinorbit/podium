import { randomUUID } from 'node:crypto'
import {
  ApprovalOp,
  type ApprovalWire,
  type ControlMessage,
  type DaemonMessage,
  describeApprovalOp,
  type LiveServerMessage,
} from '@podium/protocol'
import type { ApprovalRow, ApprovalsRepository } from '../../store/approvals'

/**
 * Approval broker [spec:SP-edbb] (#410) — the server half.
 *
 * Agents INITIATE management ops via the issue relay (`approvals.request`,
 * gated in relay-gate.ts, session+machine bound by the relay context). The
 * operator decides via the web tRPC slice (approve/deny). On approve the
 * OWNING DAEMON executes (approvalExecRequest → the daemon spawns the podium
 * binary) and reports back (approvalExecResult). Every step is appended to the
 * requesting issue's activity log, and the pending set is broadcast to all web
 * clients (plus re-sent on attach) to drive the approval popup.
 */

export interface ApprovalServiceDeps {
  store: ApprovalsRepository
  now(): string
  toMachine(machineId: string, msg: ControlMessage): void
  clients(): Iterable<{ send(msg: LiveServerMessage): void }>
  /** The issue the requesting session is attached to (explicit or cwd-derived). */
  sessionIssueId(sessionId: string): string | null
  issueInfo(issueId: string): { seq: number; title: string } | null
  machineName(machineId: string): string | undefined
  /** Append to the durable event log (renders in the issue activity feed). */
  logEvent(kind: string, issueId: string | null, payload: Record<string, unknown>): void
}

export class ApprovalService {
  constructor(private readonly deps: ApprovalServiceDeps) {}

  private toWire(row: ApprovalRow): ApprovalWire {
    const issue = row.issueId ? this.deps.issueInfo(row.issueId) : null
    const machineName = this.deps.machineName(row.machineId)
    return {
      id: row.id,
      machineId: row.machineId,
      ...(machineName ? { machineName } : {}),
      sessionId: row.sessionId,
      issueId: row.issueId,
      issueSeq: issue?.seq ?? null,
      issueTitle: issue?.title ?? null,
      op: row.op,
      status: row.status,
      createdAt: row.createdAt,
      decidedAt: row.decidedAt,
      resultText: row.resultText,
    }
  }

  listPending(): ApprovalWire[] {
    return this.deps.store.listPending().map((r) => this.toWire(r))
  }

  private broadcast(): void {
    const msg: LiveServerMessage = { type: 'approvalsChanged', pending: this.listPending() }
    for (const c of this.deps.clients()) c.send(msg)
  }

  private log(row: ApprovalRow, kind: string, extra: Record<string, unknown> = {}): void {
    this.deps.logEvent(kind, row.issueId, {
      approvalId: row.id,
      machineId: row.machineId,
      sessionId: row.sessionId,
      op: describeApprovalOp(row.op),
      ...extra,
    })
  }

  /** Relay entry (agent): file a request. Idempotent-ish — an identical op
   *  already pending for the same machine is returned instead of duplicated,
   *  so an agent retrying doesn't stack popups. */
  request(input: unknown): { id: string; status: string; message: string } {
    const raw = (input ?? {}) as Record<string, unknown>
    const op = ApprovalOp.parse(raw.op)
    const sessionId = String(raw.sessionId ?? '')
    const machineId = String(raw.machineId ?? '')
    if (!sessionId || !machineId) throw new Error('approval request lost its relay context')
    const dup = this.deps.store
      .listPending()
      .find((r) => r.machineId === machineId && JSON.stringify(r.op) === JSON.stringify(op))
    if (dup) {
      return {
        id: dup.id,
        status: dup.status,
        message: `already requested (${dup.id}) — awaiting approval in the Podium UI`,
      }
    }
    const row: ApprovalRow = {
      id: `apr_${randomUUID()}`,
      machineId,
      sessionId,
      issueId: this.deps.sessionIssueId(sessionId),
      op,
      status: 'pending',
      createdAt: this.deps.now(),
      decidedAt: null,
      resultText: null,
    }
    this.deps.store.insert(row)
    this.log(row, 'issue.approval_requested')
    this.broadcast()
    return {
      id: row.id,
      status: 'pending',
      message: `requested — awaiting approval in the Podium UI (check: podium approval status ${row.id})`,
    }
  }

  /** Relay entry (agent): poll one request's state. */
  get(input: unknown): ApprovalWire {
    const id = String((input as Record<string, unknown> | undefined)?.id ?? '')
    const row = this.deps.store.get(id)
    if (!row) throw new Error(`unknown approval request: ${id}`)
    return this.toWire(row)
  }

  /** Operator: approve → mark executing and hand the op to the owning daemon.
   *  toMachine queues if the daemon is briefly offline. */
  approve(id: string): ApprovalWire {
    const row = this.deps.store.get(id)
    if (!row) throw new Error(`unknown approval request: ${id}`)
    if (!this.deps.store.transition(id, 'pending', 'executing')) {
      throw new Error(`approval ${id} is not pending (already decided?)`)
    }
    this.deps.toMachine(row.machineId, { type: 'approvalExecRequest', requestId: id, op: row.op })
    this.log(row, 'issue.approval_approved')
    this.broadcast()
    return this.toWire(this.deps.store.get(id)!)
  }

  /** Operator: deny. Terminal. */
  deny(id: string): ApprovalWire {
    const row = this.deps.store.get(id)
    if (!row) throw new Error(`unknown approval request: ${id}`)
    if (!this.deps.store.transition(id, 'pending', 'denied', 'denied by the operator')) {
      throw new Error(`approval ${id} is not pending (already decided?)`)
    }
    this.log(row, 'issue.approval_denied')
    this.broadcast()
    return this.toWire(this.deps.store.get(id)!)
  }

  /** Daemon reply: execution finished. A `stop` op may never report (the daemon
   *  stops itself) — that row stays 'executing', which is honest. */
  onExecResult(msg: Extract<DaemonMessage, { type: 'approvalExecResult' }>): void {
    const row = this.deps.store.get(msg.requestId)
    if (!row) return
    const text = msg.output.slice(0, 4000) || (msg.ok ? 'ok' : `exit ${msg.exitCode ?? '?'}`)
    if (
      !this.deps.store.transition(msg.requestId, 'executing', msg.ok ? 'succeeded' : 'failed', text)
    )
      return
    this.log(row, msg.ok ? 'issue.approval_succeeded' : 'issue.approval_failed', {
      exitCode: msg.exitCode,
    })
    this.broadcast()
  }
}
