import { randomUUID } from 'node:crypto'
import { describeError } from '@podium/logger'
import {
  APPROVAL_EFFECT_KIND,
  AWAITING_DECISION_STAGE,
  asMachineId,
  asSessionId,
  type EffectDecision,
  type IssueId,
  type MachineId,
  type SessionId,
  type UserId,
} from '@podium/model'
import {
  ApprovalEffectInput,
  ApprovalOp,
  type ApprovalWire,
  approvalStatusOf,
  describeApprovalOp,
} from '@podium/protocol'
import type { ControlMessage, DaemonMessage } from '@podium/protocol/daemon'
import type { LedgerWriter } from '@podium/sync'
import { attributionOf, type CommandPrincipal, onBehalfOfUser } from '../../command-principal'
import type { EffectRow, EffectsRepository } from '../../store/effects'
import { withWriteProvenance } from '../../write-provenance'
import type { EffectExecutor, EffectOutcome, EffectRunContext } from '../effects/registry'
import { WRITER_NO_LONGER_ALLOWED } from '../effects/writer'
import { SyncWriteRefused } from '../sync-write/entry'
import { NO_TARGET, type SyncWriteContext, type SyncWriteTarget } from '../sync-write/registry'
import { type ApprovalOpPermissionDeps, isRequestPerson, mayRunApprovalOp } from './op-permission'

/**
 * Approval broker [spec:SP-edbb] (#410) — the server half. AN APPROVAL IS AN
 * EFFECT RECORD WITH A HUMAN GATE (POD-6674, ADR 12 D5 E2).
 *
 * Agents INITIATE management ops via the issue relay (`approvals.request`,
 * gated in relay-gate.ts, session+machine bound by the relay context). The
 * request is an `effects` row of kind `approval`, written in the command's unit
 * of work: `pending`, stage `awaiting-approval`, its decision `awaiting`, no
 * deadline. It reaches every device of the people who may see it on the feed,
 * like any other effect: its person and the readers of the requesting issue
 * (or session).
 *
 * The person decides with `records.effect.edit` (`decision`, against the record
 * revision; see `modules/records/effect-record.ts`), and only they may: the
 * owner of the requesting session (POD-6284). The first decision wins. A deny
 * ends the record `cancelled` in the same write. An approve leaves it `pending`
 * for the one effect trigger, which claims it (`running`, exactly once per
 * record id) and runs it here:
 *
 *  - a server-catalog op (workflow publish and default, a one-off automation)
 *    runs through the same doors every transport uses, and settles at once;
 *  - every other op is handed to the OWNING DAEMON (`approvalExecRequest`,
 *    queued while it is away), and its `approvalExecResult` settles the record.
 *    The run hands off and leaves the record `running`; the sweep's recovery
 *    keeps the stall deadline ({@link APPROVAL_EXEC_DEADLINE_MS}) and never
 *    sends the request again.
 *
 * Every step is appended to the requesting issue's activity log, and the
 * outcome is mailed to the requesting agent when its CLI is no longer waiting.
 */

/** The records an approval reads and writes. */
export type ApprovalEffectsRepository = Pick<
  EffectsRepository,
  'insert' | 'get' | 'listAwaiting' | 'decide' | 'settle' | 'publishCopied'
>

export interface ApprovalServiceDeps {
  effects: ApprovalEffectsRepository
  /** The broker's own writer (`approvals.results`): a daemon's result, and the
   *  boot step that puts copied rows on the feed. Never inside a command. */
  writer: Pick<LedgerWriter, 'commit'>
  /** Epoch milliseconds: record times and the stall clock. */
  nowMs(): number
  toMachine(machineId: MachineId, msg: ControlMessage): void
  /**
   * The requesting session's own owner (POD-6284). An approval belongs to that
   * person alone: only they decide it. Absent (unit tests that predate it) = the
   * record's own person.
   */
  sessionOwnerUserId?(sessionId: SessionId): Promise<UserId | undefined>
  /** Whether the person an approval is routed to may still act (an account
   *  disabled since the decision is refused). Absent: always. */
  personActive?(userId: UserId): Promise<boolean>
  /** The issue the requesting session is attached to (explicit or cwd-derived). */
  sessionIssueId(sessionId: SessionId): IssueId | null | Promise<IssueId | null>
  issueInfo(
    issueId: IssueId,
  ):
    | { seq: number; title: string; displayRef?: string }
    | null
    | Promise<{ seq: number; title: string; displayRef?: string } | null>
  machineName(machineId: MachineId): string | undefined | Promise<string | undefined>
  /** Append to the durable event log (renders in the issue activity feed). */
  logEvent(
    kind: string,
    issueId: IssueId | null,
    payload: Record<string, unknown>,
  ): void | Promise<void>
  /**
   * Push the outcome to the requesting agent via issue mail (stop-hook/nudge
   * delivery) — the agent must not have to poll to learn the decision.
   *
   * `Promise<void>`, NOT `void | Promise<void>` [POD-3806]: a mail send opens
   * its own store transaction, and a discarded promise would join whatever span
   * the decision was running inside and die orphaned when it closed.
   */
  notifyIssue(issueId: IssueId, body: string): Promise<void>
  /** Server-owned operations return a result string. null means this operation
   * belongs to the daemon executor. */
  executeServerOp?(op: ApprovalOp, sessionId: SessionId): string | null | Promise<string | null>
  /** True when `machineId` has a live daemon socket RIGHT NOW. The stall deadline
   *  runs only while this is true. Absent: always. */
  hasDaemon?(machineId: MachineId): boolean
  /**
   * The operation's own permission (`op-permission.ts`): a decider must hold
   * it, checked live. Absent (unit fixtures): the request's person alone.
   */
  opPermission?: ApprovalOpPermissionDeps
  /** The principal a person acts as now, for the check when the agent asks. */
  personPrincipal?(userId: UserId): Promise<CommandPrincipal | undefined>
  /** Every active admin as they act now: who a request its owner may not run goes to. */
  activeAdmins?(): Promise<CommandPrincipal[]>
}

/**
 * How long a daemon-executed approval may sit `running` with a reachable daemon
 * before the server says it lost track (POD-2223).
 *
 * Bounded on both sides, and both bounds are load-bearing:
 *   - ABOVE the daemon's own executor ceiling. `runApprovalExec` spawns the podium
 *     binary with `timeout: 300_000` and reports EITHER outcome, so a daemon that is
 *     merely slow always answers inside 5 minutes. 7 gives that two minutes of slack.
 *   - BELOW `APPROVAL_WAIT_MS` (10 min), the window the requesting agent's CLI blocks
 *     for, so the agent's own command prints the real answer.
 * The effect sweep drives it (once a minute), so it fires at 7–8 minutes.
 */
export const APPROVAL_EXEC_DEADLINE_MS = 7 * 60_000

/** The most waiting requests one duplicate check reads. */
const AWAITING_LIMIT = 500

/** How many copied rows one boot write republishes. */
const PUBLISH_BATCH = 100

/**
 * The closed server catalog (POD-6415): the ops the SERVER runs after approval,
 * through the same doors every transport uses (`executeServerOp`). Every other
 * op belongs to the owning daemon.
 */
export const SERVER_APPROVAL_OPS: ReadonlySet<ApprovalOp['kind']> = new Set([
  'workflow-publish',
  'workflow-set-default',
  'automation-schedule',
])

export const isServerApprovalOp = (op: ApprovalOp): boolean => SERVER_APPROVAL_OPS.has(op.kind)

/** The record's answer: what the op printed, or why it did not run. */
interface ApprovalResult {
  readonly resultText: string
}

const MAY_HAVE_RUN =
  'The server stopped while it ran this operation; it may or may not have run. Check before asking again.'

const STOP_SENT = 'sent to the machine; a stop ends its own podium processes, so no result follows'

const DENIED = 'denied by the operator'

/** The approval behind an effect record, or undefined for any other record. */
function approvalOf(row: EffectRow): ApprovalEffectInput | undefined {
  if (row.kind !== APPROVAL_EFFECT_KIND) return undefined
  const parsed = ApprovalEffectInput.safeParse(row.input)
  return parsed.success ? parsed.data : undefined
}

const resultTextOf = (row: EffectRow): string | null => {
  const text = (row.result as Partial<ApprovalResult> | undefined)?.resultText
  if (typeof text === 'string') return text
  if (row.error !== undefined) return row.error.message
  return row.decision === 'deny' ? DENIED : null
}

const iso = (ms: number | undefined): string | null =>
  ms === undefined ? null : new Date(ms).toISOString()

const succeeded = (resultText: string): EffectOutcome => ({
  status: 'succeeded',
  result: { resultText } satisfies ApprovalResult,
})

const failed = (code: string, resultText: string): EffectOutcome => ({
  status: 'failed',
  error: { code, message: resultText },
  result: { resultText } satisfies ApprovalResult,
})

export class ApprovalService {
  /** When the requesting CLI last polled (it blocks on the decision, so a recent
   *  poll means it is still there and WILL print the outcome itself). */
  private readonly lastPolledAt = new Map<string, number>()

  /** A blocked CLI counts as live if it polled within this window (it polls every
   *  1.5s); anything staler means nobody is listening on that command. */
  private static readonly WAITER_LIVE_MS = 15_000

  /**
   * When each handed-off approval's stall clock started: the first sweep that
   * found its daemon reachable.
   *
   * A clock, not a timestamp, because `toMachine` QUEUES for an offline machine
   * and flushes on its next attach: a record parked for three days has not been
   * waiting on anything. So the recovery DELETES the entry whenever the daemon is
   * away and restarts it on the next sweep that finds it back; the deadline only
   * ever measures time a daemon had the frame and stayed silent.
   *
   * In memory on purpose. A server restart loses it, the next sweep re-seeds from
   * now, and the only cost is one extra deadline of patience on a record that was
   * already stuck: the conservative direction.
   */
  private readonly stallClock = new Map<string, number>()

  constructor(private readonly deps: ApprovalServiceDeps) {}

  private async toWire(row: EffectRow, approval: ApprovalEffectInput): Promise<ApprovalWire> {
    const issue = approval.issueId ? await this.deps.issueInfo(approval.issueId) : null
    const machineName = await this.deps.machineName(approval.machineId)
    return {
      id: row.id,
      machineId: approval.machineId,
      ...(machineName ? { machineName } : {}),
      sessionId: approval.sessionId,
      issueId: approval.issueId,
      issueSeq: issue?.seq ?? null,
      issueTitle: issue?.title ?? null,
      ...(issue?.displayRef ? { issueDisplayRef: issue.displayRef } : {}),
      op: approval.op,
      status: approvalStatusOf(row.status, row.decision === 'awaiting' ? null : row.decision),
      createdAt: new Date(row.createdAt).toISOString(),
      decidedAt: iso(row.decision === 'deny' ? row.finishedAt : row.startedAt),
      resultText: resultTextOf(row),
    }
  }

  /**
   * Outcome delivery. The normal path needs NO push: the agent's command BLOCKS
   * on the decision and prints the result itself. Mail is the fallback for the
   * cases a blocked CLI cannot see — it timed out, its session ended, or the op
   * killed its own daemon mid-flight — so a decision is never lost.
   */
  private async notify(id: string, approval: ApprovalEffectInput, outcome: string): Promise<void> {
    if (!approval.issueId) return
    const polled = this.lastPolledAt.get(id) ?? 0
    if (Date.now() - polled < ApprovalService.WAITER_LIVE_MS) return // the CLI reports it
    try {
      await this.deps.notifyIssue(
        approval.issueId,
        `approval ${id} ("${describeApprovalOp(approval.op)}"): ${outcome}`,
      )
    } catch {}
  }

  private async log(
    id: string,
    approval: ApprovalEffectInput,
    kind: string,
    extra: Record<string, unknown> = {},
  ): Promise<void> {
    await this.deps.logEvent(kind, approval.issueId, {
      approvalId: id,
      machineId: approval.machineId,
      sessionId: approval.sessionId,
      op: describeApprovalOp(approval.op),
      ...extra,
    })
  }

  /** The person an approval is routed to: the requesting session's owner now. */
  private async personOf(row: EffectRow, approval: ApprovalEffectInput): Promise<UserId | null> {
    if (this.deps.sessionOwnerUserId === undefined) return row.createdBy
    return (await this.deps.sessionOwnerUserId(approval.sessionId)) ?? row.createdBy
  }

  /**
   * Relay entry (agent): file a request, in the `approvals.request` command's
   * unit of work (POD-6603): the record and its activity event commit together.
   * Idempotent-ish — an identical op already waiting for the same machine is
   * returned instead of duplicated, so an agent retrying doesn't stack popups.
   */
  async request(
    input: unknown,
    ctx: { readonly ledger: Pick<LedgerWriter, 'commit'>; readonly principal: CommandPrincipal },
  ): Promise<{ id: string; status: string; message: string }> {
    const raw = (input ?? {}) as Record<string, unknown>
    const op = ApprovalOp.parse(raw.op)
    // DECODE EDGE: `input` is the untyped relay payload. The guard below refuses
    // an empty value, so this brands a non-empty relay-supplied session id.
    const sessionId = asSessionId(String(raw.sessionId ?? ''))
    const machineId = asMachineId(String(raw.machineId ?? ''))
    if (!sessionId || !machineId) throw new Error('approval request lost its relay context')
    const wanted = JSON.stringify(op)
    for (const row of await this.deps.effects.listAwaiting(APPROVAL_EFFECT_KIND, AWAITING_LIMIT)) {
      const waiting = approvalOf(row)
      if (waiting?.machineId === machineId && JSON.stringify(waiting.op) === wanted) {
        return {
          id: row.id,
          status: 'pending',
          message: `already requested (${row.id}) — awaiting approval in the Podium UI`,
        }
      }
    }
    const issueId = await this.deps.sessionIssueId(sessionId)
    const approval: ApprovalEffectInput = { op, machineId, sessionId, issueId }
    const person =
      (await this.deps.sessionOwnerUserId?.(sessionId)) ?? onBehalfOfUser(ctx.principal)
    // Who it is routed to: its owner when they may run the op, else the admins
    // who may. A request nobody could decide is refused now, rather than
    // waiting forever where no one can act on it.
    const deciders = await this.decidersFor(person, approval)
    if (deciders !== undefined && deciders.length === 0) {
      throw new SyncWriteRefused({
        kind: 'unauthorized',
        message:
          `nobody can approve "${describeApprovalOp(op)}" for this session: neither its owner ` +
          'nor any admin may run that operation',
      })
    }
    const id = `apr_${randomUUID()}`
    const now = this.deps.nowMs()
    await ctx.ledger.commit({
      write: async (scope) =>
        await this.deps.effects.insert(
          scope,
          {
            id,
            kind: APPROVAL_EFFECT_KIND,
            target: issueId ? { kind: 'issue', id: issueId } : { kind: 'session', id: sessionId },
            input: approval,
            // No deadline: an approval waits for its person as long as it takes.
            deadlineAt: undefined,
            createdBy: person,
            actor: attributionOf(ctx.principal).actor,
            gated: true,
            stage: AWAITING_DECISION_STAGE,
            ...(deciders === undefined ? {} : { deciders }),
          },
          now,
        ),
      changes: () => [],
    })
    await this.log(id, approval, 'issue.approval_requested')
    return {
      id,
      status: 'pending',
      message: `requested — awaiting the operator's decision in the Podium UI`,
    }
  }

  /** Read one request's state (no side effects). */
  async get(input: unknown): Promise<ApprovalWire> {
    const id = String((input as Record<string, unknown> | undefined)?.id ?? '')
    const row = id ? await this.deps.effects.get(id) : undefined
    const approval = row === undefined ? undefined : approvalOf(row)
    if (row === undefined || approval === undefined) {
      throw new Error(`unknown approval request: ${id}`)
    }
    return await this.toWire(row, approval)
  }

  /** RELAY entry for `get`: same read, but it also marks the caller as a live
   *  waiter — the agent's CLI blocks on the decision and polls this, so a recent
   *  poll tells `notify` the command will print the outcome itself and no mail
   *  push is needed. (Operator/test reads go through `get`, which does not.) */
  async getFromAgent(input: unknown): Promise<ApprovalWire> {
    const w = await this.get(input)
    this.lastPolledAt.set(w.id, Date.now())
    return w
  }

  /** Whether `principal` may decide this record: a person, its routed-to owner. */
  /**
   * Whether `principal` may decide this record: a person who is the request's
   * own (its session's owner, or instance-scoped) AND who may run the operation
   * itself, read now (`op-permission.ts`).
   */
  async mayDecide(row: EffectRow, principal: CommandPrincipal): Promise<boolean> {
    if (principal.kind !== 'user') return false
    const approval = approvalOf(row)
    if (approval === undefined) return false
    const person = isRequestPerson(principal, await this.personOf(row, approval))
    // An admin decides any agent's request, as the operator always could, when
    // they may run its operation.
    if (!person && principal.capability.role !== 'admin') return false
    return await this.mayRun(principal, approval)
  }

  /**
   * The people a new request is routed to: its owner when they may run the op,
   * otherwise every active admin who may. `undefined`: no permission check is
   * composed (unit fixtures), so it is its creator's, as before.
   */
  private async decidersFor(
    person: UserId | null,
    approval: ApprovalEffectInput,
  ): Promise<UserId[] | undefined> {
    if (this.deps.opPermission === undefined || this.deps.personPrincipal === undefined) {
      return undefined
    }
    const owner = person === null ? undefined : await this.deps.personPrincipal(person)
    if (owner !== undefined && person !== null && (await this.mayRun(owner, approval))) {
      return [person]
    }
    const admins = (await this.deps.activeAdmins?.()) ?? []
    const allowed: UserId[] = []
    for (const admin of admins) {
      if (admin.kind === 'user' && (await this.mayRun(admin, approval))) allowed.push(admin.user)
    }
    return allowed
  }

  private async mayRun(
    principal: CommandPrincipal,
    approval: ApprovalEffectInput,
  ): Promise<boolean> {
    const deps = this.deps.opPermission
    return deps === undefined ? true : await mayRunApprovalOp(deps, principal, approval)
  }

  /**
   * A person's decision, in the `records.effect.edit` unit of work: written once,
   * against the revision it was made on. Approve leaves the record for the
   * trigger, which runs it after the commit; deny ends it, and the agent is told
   * after the commit. A decided, ended or moved record is a conflict.
   */
  async decide(
    ctx: SyncWriteContext,
    row: EffectRow,
    decision: EffectDecision,
    revision: number,
  ): Promise<EffectRow> {
    const approval = approvalOf(row)
    if (approval === undefined) throw new SyncWriteRefused({ kind: 'target-not-found' })
    const now = this.deps.nowMs()
    const decided = (
      await ctx.ledger.commit({
        write: async (scope) =>
          await this.deps.effects.decide(scope, row.id, decision, revision, now),
        changes: () => [],
      })
    ).result
    if (decided === undefined) throw new SyncWriteRefused({ kind: 'conflict' })
    if (decision === 'approve') {
      await this.log(row.id, approval, 'issue.approval_approved')
    } else {
      await this.log(row.id, approval, 'issue.approval_denied')
      ctx.afterCommit(async () => await this.notify(row.id, approval, DENIED), 'approvals.denied')
    }
    return decided
  }

  /** The claimed record's run: the op, once (the runner's claim is per record id). */
  async run(ctx: EffectRunContext<ApprovalEffectInput>): Promise<EffectOutcome> {
    const { record, input: approval } = ctx
    if (record.createdBy !== null && this.deps.personActive !== undefined) {
      if (!(await this.deps.personActive(record.createdBy))) {
        return await this.finish(
          record.id,
          approval,
          failed('not-allowed', WRITER_NO_LONGER_ALLOWED),
        )
      }
    }
    await ctx.stage('executing')
    if (isServerApprovalOp(approval.op)) {
      let outcome: EffectOutcome
      try {
        const text = (await this.deps.executeServerOp?.(approval.op, approval.sessionId)) ?? null
        outcome =
          text === null
            ? failed('no-executor', `the server does not run ${approval.op.kind}`)
            : succeeded(text)
      } catch (error) {
        outcome = failed('failed', describeError(error))
      }
      return await this.finish(record.id, approval, outcome)
    }
    // The owning daemon runs it; `toMachine` queues while it is away.
    this.deps.toMachine(approval.machineId, {
      type: 'approvalExecRequest',
      requestId: record.id,
      op: approval.op,
    })
    if (approval.op.kind === 'stop') {
      // A stop kills the daemon mid-exec: its result may never arrive, so the
      // decision is the last thing we can reliably deliver.
      await this.notify(record.id, approval, 'approved — executing')
      if (this.daemonReachable(approval.machineId)) return succeeded(STOP_SENT)
    }
    // The daemon's result settles it (`onExecResult`); the sweep keeps the deadline.
    return { status: 'running' }
  }

  /**
   * A `running` approval with no live run: the server stopped mid-run, or the op
   * was handed to its daemon. Never sent again.
   */
  async recover(ctx: EffectRunContext<ApprovalEffectInput>): Promise<EffectOutcome> {
    const { record, input: approval } = ctx
    if (isServerApprovalOp(approval.op)) {
      await this.log(record.id, approval, 'issue.approval_failed', { lostTrack: true })
      await this.notify(record.id, approval, `FAILED — ${MAY_HAVE_RUN}`)
      return { status: 'unknown', error: { code: 'lost-track', message: MAY_HAVE_RUN } }
    }
    if (approval.op.kind === 'stop') {
      // Its frame reaches the daemon on attach; there is no result to wait for.
      return this.daemonReachable(approval.machineId) ? succeeded(STOP_SENT) : { status: 'running' }
    }
    if (!this.daemonReachable(approval.machineId)) {
      // Parked, not stalled: the frame is queued for this machine's next attach.
      this.stallClock.delete(record.id)
      return { status: 'running' }
    }
    const now = this.deps.nowMs()
    const since = this.stallClock.get(record.id)
    if (since === undefined) {
      this.stallClock.set(record.id, now)
      return { status: 'running' }
    }
    if (now - since < APPROVAL_EXEC_DEADLINE_MS) return { status: 'running' }
    this.stallClock.delete(record.id)
    const minutes = Math.round((now - since) / 60_000)
    // Say what is known and no more. The machine may in fact have run the op and lost
    // its reply, so this must NOT claim nothing happened.
    const text =
      `no result from ${(await this.deps.machineName(approval.machineId)) ?? approval.machineId} after ${minutes} minutes. ` +
      `Its daemon was connected and did not answer, which usually means that machine's podium ` +
      `predates this operation and dropped the request — check its version, update it, then ask again. ` +
      `The operation may or may not have run; \`podium fleet\` shows what that machine is actually on.`
    await this.log(record.id, approval, 'issue.approval_failed', {
      stalled: true,
      waitedMs: now - since,
    })
    await this.notify(record.id, approval, `FAILED — ${text}`)
    // `unknown`, not `failed`: a late result still settles it (`onExecResult`).
    return { status: 'unknown', error: { code: 'stalled', message: text } }
  }

  private daemonReachable(machineId: MachineId): boolean {
    return this.deps.hasDaemon?.(machineId) ?? true
  }

  /** Log and tell the agent how a run ended; the runner writes the status. */
  private async finish(
    id: string,
    approval: ApprovalEffectInput,
    outcome: EffectOutcome,
  ): Promise<EffectOutcome> {
    if (outcome.status === 'succeeded') {
      await this.log(id, approval, 'issue.approval_succeeded')
      const text = (outcome.result as ApprovalResult | undefined)?.resultText ?? 'ok'
      await this.notify(id, approval, `succeeded — ${text}`)
    } else if (outcome.status === 'failed') {
      await this.log(id, approval, 'issue.approval_failed')
      await this.notify(id, approval, `FAILED — ${outcome.error.message}`)
    }
    return outcome
  }

  /**
   * Daemon reply: execution finished. Settles a running record, or corrects one
   * the stall deadline gave up on (`unknown`): being told "it may not have run"
   * about an op that ran is worse than the truth arriving late.
   */
  async onExecResult(msg: Extract<DaemonMessage, { type: 'approvalExecResult' }>): Promise<void> {
    const row = await this.deps.effects.get(msg.requestId)
    const approval = row === undefined ? undefined : approvalOf(row)
    if (row === undefined || approval === undefined) return
    this.stallClock.delete(row.id)
    const text = msg.output.slice(0, 4000) || (msg.ok ? 'ok' : `exit ${msg.exitCode ?? '?'}`)
    const late = row.status === 'unknown'
    // A stop was settled when its frame reached the daemon; its result is told, not stored.
    const stopReport = approval.op.kind === 'stop' && row.status === 'succeeded'
    if (row.status !== 'running' && !late && !stopReport) return
    if (!stopReport) {
      const settled = await this.settleAsBroker(row.id, msg.ok, text)
      if (settled === undefined) return
    }
    await this.log(
      row.id,
      approval,
      msg.ok ? 'issue.approval_succeeded' : 'issue.approval_failed',
      {
        exitCode: msg.exitCode,
        ...(late ? { late: true } : {}),
      },
    )
    const prefix = late ? 'reported LATE, after the server had given up — ' : ''
    await this.notify(
      row.id,
      approval,
      `${prefix}${msg.ok ? 'succeeded' : 'FAILED'} — ${text.slice(0, 400)}`,
    )
  }

  /** The daemon's outcome, written as the broker under the record's causation. */
  private async settleAsBroker(
    id: string,
    ok: boolean,
    text: string,
  ): Promise<EffectRow | undefined> {
    const now = this.deps.nowMs()
    const settlement = ok
      ? { result: { resultText: text } satisfies ApprovalResult }
      : {
          error: { code: 'failed', message: text },
          result: { resultText: text } satisfies ApprovalResult,
        }
    return await withWriteProvenance(
      { causationId: id },
      async () =>
        (
          await this.deps.writer.commit({
            write: async (scope) =>
              await this.deps.effects.settle(
                scope,
                id,
                ok ? 'succeeded' : 'failed',
                settlement,
                now,
              ),
            changes: () => [],
          })
        ).result,
    )
  }

  /**
   * Put the approval rows the POD-6674 migration copied in on the feed: each is
   * written again through the effects funnel, so every device receives it. Run
   * once at boot; a second run finds nothing.
   */
  async publishCopiedRecords(): Promise<number> {
    let total = 0
    for (;;) {
      const batch = (
        await this.deps.writer.commit({
          write: async (scope) => await this.deps.effects.publishCopied(scope, PUBLISH_BATCH),
          changes: () => [],
        })
      ).result
      total += batch.length
      if (batch.length < PUBLISH_BATCH) return total
    }
  }

  /** The `approval` effect kind: the record is the request (see the header). */
  executor(): EffectExecutor<ApprovalEffectInput> {
    return {
      kind: APPROVAL_EFFECT_KIND,
      input: ApprovalEffectInput,
      // Never applied: a request is written with no deadline (it waits for its
      // person as long as it takes). The registry asks every kind for one.
      deadlineMs: APPROVAL_EXEC_DEADLINE_MS,
      // Nobody creates one through `effects.create`: an agent asks with
      // `podium approval` (`approvals.request`).
      target: async () => undefined,
      admit: async () => ({
        kind: 'unauthorized',
        message: 'an approval is requested with `podium approval`',
      }),
      onRecord: async (record, principal): Promise<SyncWriteTarget> =>
        (await this.mayDecide(record, principal)) ? NO_TARGET : undefined,
      gate: {
        decide: async (ctx, record, decision, revision) =>
          await this.decide(ctx, record, decision, revision),
      },
      run: async (ctx) => await this.run(ctx),
      recover: async (ctx) => await this.recover(ctx),
    }
  }
}
