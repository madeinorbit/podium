import { randomUUID } from 'node:crypto'
import { asMachineId, asSessionId, type IssueId, type SessionId, type MachineId } from '@podium/model'
import { ApprovalOp, type ApprovalWire, describeApprovalOp, type LiveServerMessage } from '@podium/protocol'
import { type ControlMessage, type DaemonMessage } from '@podium/protocol/daemon'
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
 *
 * NOT the daemon-RPC correlator (POD-318), judged deliberately. The `pending`
 * set here is DURABLE SQLITE rows, not in-memory correlation state: it survives
 * a restart, has no timeout (an approval waits for a human, indefinitely), and
 * its state machine is pending → executing → approved/denied rather than a
 * single settle. `approvalExecResult` is the daemon reporting an outcome the
 * store already knows it is waiting for, not a reply resolving a promise.
 */

export interface ApprovalServiceDeps {
  store: ApprovalsRepository
  now(): string
  toMachine(machineId: MachineId, msg: ControlMessage): void
  clients(): Iterable<{ send(msg: LiveServerMessage): void }>
  /** The issue the requesting session is attached to (explicit or cwd-derived). */
  sessionIssueId(sessionId: SessionId): IssueId | null
  issueInfo(issueId: IssueId): { seq: number; title: string; displayRef?: string } | null
  machineName(machineId: MachineId): string | undefined
  /** Append to the durable event log (renders in the issue activity feed). */
  logEvent(kind: string, issueId: IssueId | null, payload: Record<string, unknown>): void
  /** Push the outcome to the requesting agent via issue mail (stop-hook/nudge
   *  delivery) — the agent must not have to poll to learn the decision. */
  notifyIssue(issueId: IssueId, body: string): void
  /** Server-owned operations return a result string. null means this operation
   * belongs to the daemon executor. */
  executeServerOp?(op: ApprovalOp, sessionId: SessionId): string | null
  /** True when `machineId` has a live daemon socket RIGHT NOW. The stall deadline
   *  below runs only while this is true — see {@link ApprovalService.sweepStalledExecutions}. */
  hasDaemon?(machineId: MachineId): boolean
  /** Elapsed-time clock for the stall deadline, separate from `now()` because that one
   *  yields the ISO string that goes ON the row and this one only ever gets subtracted.
   *  Both the dispatch that starts a row's clock and the sweep that reads it must come
   *  from the SAME source, or the deadline measures the gap between two clocks. */
  nowMs?(): number
}

/**
 * How long a daemon-executed approval may sit `executing` with a reachable daemon
 * before the server calls it stalled (POD-2223).
 *
 * Bounded on both sides, and both bounds are load-bearing:
 *   - ABOVE the daemon's own executor ceiling. `runApprovalExec` spawns the podium
 *     binary with `timeout: 300_000` and reports EITHER outcome, so a daemon that is
 *     merely slow always answers inside 5 minutes. 7 gives that two minutes of slack.
 *   - BELOW `APPROVAL_WAIT_MS` (10 min), the window the requesting agent's CLI blocks
 *     for. Firing inside it means the agent's own command prints the real answer and
 *     exits, instead of printing "the request is still live … you will be told the
 *     outcome" — which, for a row nobody will ever answer, is false twice over.
 */
export const APPROVAL_EXEC_DEADLINE_MS = 7 * 60_000

/** How often {@link ApprovalService.sweepStalledExecutions} should be driven. One
 *  minute keeps the fire window at 7–8 min, still two minutes inside the CLI's wait. */
export const APPROVAL_STALL_SWEEP_MS = 60_000

export class ApprovalService {
  /** When the requesting CLI last polled (it blocks on the decision, so a recent
   *  poll means it is still there and WILL print the outcome itself). */
  private readonly lastPolledAt = new Map<string, number>()

  /** A blocked CLI counts as live if it polled within this window (it polls every
   *  1.5s); anything staler means nobody is listening on that command. */
  private static readonly WAITER_LIVE_MS = 15_000

  /**
   * When each in-flight approval's stall clock started — the moment the exec request
   * was handed to a REACHABLE daemon.
   *
   * It is a clock, not a timestamp, because `toMachine` QUEUES for an offline machine
   * and flushes on its next attach: a row parked for three days has not been waiting on
   * anything, and failing it the instant its machine comes back would report a stall for
   * a frame the daemon has not even seen yet. So the sweep DELETES the entry whenever the
   * daemon is away and restarts it on the next tick that finds it back — the deadline
   * only ever measures time a daemon had the frame and stayed silent.
   *
   * In memory on purpose. A server restart loses it, the next sweep re-seeds from `now`,
   * and the only cost is one extra deadline of patience on a row that was already stuck —
   * the conservative direction. Making it durable would be a column, a migration and a
   * ledger for an error path measured in minutes.
   */
  private readonly stallClock = new Map<string, number>()

  /** True while a stall sweep is running — see {@link sweepStalledExecutions}. */
  private sweepingStalled = false

  /** Rows this server failed for stalling. Kept so a result that arrives ANYWAY can
   *  correct the record rather than be dropped on a transition that no longer matches
   *  — being told "it failed" about an op that ran is worse than being told nothing. */
  private readonly stalled = new Set<string>()

  constructor(private readonly deps: ApprovalServiceDeps) {}

  private nowMs(): number {
    return this.deps.nowMs?.() ?? Date.now()
  }

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
      ...(issue?.displayRef ? { issueDisplayRef: issue.displayRef } : {}),
      op: row.op,
      status: row.status,
      createdAt: row.createdAt,
      decidedAt: row.decidedAt,
      resultText: row.resultText,
    }
  }
  private row(id: string): ApprovalRow {
    const row = this.deps.store.get(id)
    if (!row) throw new Error(`unknown approval request: ${id}`)
    return row
  }

  listPending(): ApprovalWire[] {
    return this.deps.store.listPending().map((r) => this.toWire(r))
  }

  private broadcast(): void {
    const msg: LiveServerMessage = { type: 'approvalsChanged', pending: this.listPending() }
    for (const c of this.deps.clients()) c.send(msg)
  }

  /**
   * Outcome delivery. The normal path needs NO push: the agent's command BLOCKS
   * on the decision and prints the result itself. Mail is the fallback for the
   * cases a blocked CLI cannot see — it timed out, its session ended, or the op
   * killed its own daemon mid-flight — so a decision is never lost.
   */
  private notify(row: ApprovalRow, outcome: string): void {
    if (!row.issueId) return
    const polled = this.lastPolledAt.get(row.id) ?? 0
    if (Date.now() - polled < ApprovalService.WAITER_LIVE_MS) return // the CLI reports it
    try {
      this.deps.notifyIssue(
        row.issueId,
        `approval ${row.id} ("${describeApprovalOp(row.op)}"): ${outcome}`,
      )
    } catch {}
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
    // DECODE EDGE: `input` is the untyped relay payload. The guard below refuses
    // an empty value, so this brands a non-empty relay-supplied session id.
    const sessionId = asSessionId(String(raw.sessionId ?? ''))
    const machineId = asMachineId(String(raw.machineId ?? ''))
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
      message: `requested — awaiting the operator's decision in the Podium UI`,
    }
  }

  /** Read one request's state (no side effects). */
  get(input: unknown): ApprovalWire {
    const id = String((input as Record<string, unknown> | undefined)?.id ?? '')
    const row = this.deps.store.get(id)
    if (!row) throw new Error(`unknown approval request: ${id}`)
    return this.toWire(row)
  }

  /** RELAY entry for `get`: same read, but it also marks the caller as a live
   *  waiter — the agent's CLI blocks on the decision and polls this, so a recent
   *  poll tells `notify` the command will print the outcome itself and no mail
   *  push is needed. (Operator/test reads go through `get`, which does not.) */
  getFromAgent(input: unknown): ApprovalWire {
    const w = this.get(input)
    this.lastPolledAt.set(w.id, Date.now())
    return w
  }

  /** Operator: approve → execute through the closed server catalog or hand the
   * op to the owning daemon. toMachine queues if the daemon is briefly offline. */
  approve(id: string): ApprovalWire {
    const row = this.deps.store.get(id)
    if (!row) throw new Error(`unknown approval request: ${id}`)
    if (!this.deps.store.transition(id, 'pending', 'executing')) {
      throw new Error(`approval ${id} is not pending (already decided?)`)
    }
    this.log(row, 'issue.approval_approved')
    try {
      const serverResult = this.deps.executeServerOp?.(row.op, row.sessionId) ?? null
      if (serverResult !== null) {
        this.deps.store.transition(id, 'executing', 'succeeded', serverResult)
        this.log(row, 'issue.approval_succeeded')
        this.notify(row, `succeeded — ${serverResult}`)
        this.broadcast()
        return this.toWire(this.row(id))
      }
    } catch (error) {
      const result = error instanceof Error ? error.message : String(error)
      this.deps.store.transition(id, 'executing', 'failed', result)
      this.log(row, 'issue.approval_failed')
      this.notify(row, `FAILED — ${result}`)
      this.broadcast()
      return this.toWire(this.row(id))
    }
    this.deps.toMachine(row.machineId, { type: 'approvalExecRequest', requestId: id, op: row.op })
    // Start the stall clock (POD-2223). `stop` is exempt for the same reason it gets an
    // early notify below: its row staying `executing` is honest, not stuck.
    if (row.op.kind !== 'stop') this.stallClock.set(id, this.nowMs())
    // A 'stop' kills the daemon mid-exec — its result may never arrive, so the
    // decision itself is the last thing we can reliably deliver.
    if (row.op.kind === 'stop') this.notify(row, 'approved — executing')
    this.broadcast()
    return this.toWire(this.row(id))
  }

  /** Operator: deny. Terminal. */
  deny(id: string): ApprovalWire {
    const row = this.deps.store.get(id)
    if (!row) throw new Error(`unknown approval request: ${id}`)
    if (!this.deps.store.transition(id, 'pending', 'denied', 'denied by the operator')) {
      throw new Error(`approval ${id} is not pending (already decided?)`)
    }
    this.log(row, 'issue.approval_denied')
    this.notify(row, 'denied by the operator')
    this.broadcast()
    return this.toWire(this.row(id))
  }

  /** Daemon reply: execution finished. A `stop` op may never report (the daemon
   *  stops itself) — that row stays 'executing', which is honest. */
  onExecResult(msg: Extract<DaemonMessage, { type: 'approvalExecResult' }>): void {
    const row = this.deps.store.get(msg.requestId)
    if (!row) return
    const text = msg.output.slice(0, 4000) || (msg.ok ? 'ok' : `exit ${msg.exitCode ?? '?'}`)
    this.stallClock.delete(msg.requestId)
    // A LATE result for a row the deadline already failed (POD-2223). Rare by
    // construction — the sweep only fires while the daemon is connected, and a daemon
    // that HAS the frame answers it — but if it happens, the record must move to what
    // actually occurred. Nothing else re-opens a terminal row.
    const from = this.stalled.delete(msg.requestId) ? 'failed' : 'executing'
    const late = from === 'failed'
    if (
      !this.deps.store.transition(msg.requestId, from, msg.ok ? 'succeeded' : 'failed', text)
    )
      return
    this.log(row, msg.ok ? 'issue.approval_succeeded' : 'issue.approval_failed', {
      exitCode: msg.exitCode,
      ...(late ? { late: true } : {}),
    })
    const prefix = late ? 'reported LATE, after the server had given up — ' : ''
    this.notify(row, `${prefix}${msg.ok ? 'succeeded' : 'FAILED'} — ${text.slice(0, 400)}`)
    this.broadcast()
  }

  /**
   * Fail approvals whose daemon took the exec request and never answered (POD-2223).
   *
   * WHY THIS EXISTS AT ALL, given the daemon now answers a frame it cannot read: the
   * daemon arm ships in the same release as the value that needs it, so on the day that
   * release lands every daemon in the fleet is one WITHOUT the arm — the frame is dropped
   * by `warnDropped` and no result is ever sent. That is not an edge case, it is the
   * default state of the world for as long as it takes a fleet to converge, which is the
   * thing this epic is for. Until every daemon carries the arm, this deadline is the only
   * thing standing between an operator and a row that says `executing` forever.
   *
   * The three exemptions are all about not lying:
   *   - `stop` kills its own daemon mid-exec, so no result is EXPECTED. Documented as
   *     honest where it is dispatched, and left alone here.
   *   - a machine whose daemon is away has its frame QUEUED, not lost: it still runs on
   *     the next attach. Its clock is reset instead (see {@link stallClock}).
   *   - a row seen for the first time (a restart, or one already stuck when this shipped)
   *     starts its clock now rather than being failed on sight.
   *
   * Drive it from a timer at {@link APPROVAL_STALL_SWEEP_MS}. Idempotent and cheap.
   */
  sweepStalledExecutions(now: number = this.nowMs()): void {
    // SINGLE-FLIGHT (POD-3258). The pass is a read-decide-write over
    // `stallClock`: it reads the executing rows, decides per row against a clock
    // it also mutates, then reconciles the clock against the rows it just saw.
    // Two passes interleaved would each see the other's half-written clock — the
    // reconcile at the bottom deletes every id not in ITS `live` set, so an
    // overlapping pass would drop the clock entries the first one had just
    // seeded and restart the deadline for rows that are genuinely stalling.
    // Skipped, not queued: the sweep is idempotent and the next tick is one
    // interval away, so a dropped tick costs at most that much deadline
    // resolution and never a wrong verdict.
    if (this.sweepingStalled) return
    this.sweepingStalled = true
    try {
      this.runStalledSweep(now)
    } finally {
      this.sweepingStalled = false
    }
  }

  private runStalledSweep(now: number): void {
    const rows = this.deps.store.listExecuting()
    if (rows.length === 0) {
      this.stallClock.clear()
      return
    }
    const live = new Set<string>()
    let changed = false
    for (const row of rows) {
      if (row.op.kind === 'stop') continue
      live.add(row.id)
      if (this.deps.hasDaemon && !this.deps.hasDaemon(row.machineId)) {
        // Parked, not stalled: the frame is queued for this machine's next attach.
        this.stallClock.delete(row.id)
        continue
      }
      const since = this.stallClock.get(row.id)
      if (since === undefined) {
        this.stallClock.set(row.id, now)
        continue
      }
      if (now - since < APPROVAL_EXEC_DEADLINE_MS) continue
      if (this.failStalled(row, now - since)) changed = true
    }
    for (const id of this.stallClock.keys()) if (!live.has(id)) this.stallClock.delete(id)
    if (changed) this.broadcast()
  }

  /** Move one stalled row to `failed` and tell everyone who was waiting on it. */
  private failStalled(row: ApprovalRow, waitedMs: number): boolean {
    const minutes = Math.round(waitedMs / 60_000)
    // Say what is known and no more. The machine may in fact have run the op and lost
    // its reply, so this must NOT claim nothing happened — it must name the one thing
    // that is certainly true and the one thing the operator can do about it.
    const text =
      `no result from ${this.deps.machineName(row.machineId) ?? row.machineId} after ${minutes} minutes. ` +
      `Its daemon was connected and did not answer, which usually means that machine's podium ` +
      `predates this operation and dropped the request — check its version, update it, then ask again. ` +
      `The operation may or may not have run; \`podium fleet\` shows what that machine is actually on.`
    if (!this.deps.store.transition(row.id, 'executing', 'failed', text)) return false
    this.stallClock.delete(row.id)
    this.stalled.add(row.id)
    this.log(row, 'issue.approval_failed', { stalled: true, waitedMs })
    this.notify(row, `FAILED — ${text}`)
    return true
  }
}
