import { asIssueId, asSessionId, asUserId, type SessionId } from '@podium/model'
import type { ApprovalOp, LiveServerMessage } from '@podium/protocol'
import type { ControlMessage } from '@podium/protocol/daemon'
import { describe, expect, it } from 'vitest'
import { ApprovalsRepository } from '../../store/approvals'
import { createBunStoreExecutor } from '../../store/executor'
import { openMigratedTestDatabase } from '../../test-support/migrated-database'
import { openTestStore } from '../../test-support/open-test-store'
import { APPROVAL_EXEC_DEADLINE_MS, ApprovalService } from './service'

/** The human who owns session `s1`, which is the session every request below
 *  names. Approvals are that person's to see and to decide (B1, PDM-133). */
const OWNER = asUserId('user:owner')
/** A second, unrelated human. Never owns anything here. */
const STRANGER = asUserId('user:stranger')

function harness(executeServerOp?: (op: ApprovalOp, sessionId: SessionId) => string | null) {
  const db = openMigratedTestDatabase()
  const sent: Array<{ machineId: string; msg: ControlMessage }> = []
  const broadcasts: LiveServerMessage[] = []
  const events: Array<{ kind: string; issueId: string | null }> = []
  const mails: string[] = []
  /** Whether the owning machine's daemon is attached — the stall deadline's one gate. */
  const daemon = { attached: true }
  /** The stall deadline's clock, driven by the tests rather than the wall. */
  const clock = { ms: 1_000_000 }
  /** A service over the SAME durable store. Called twice, it models a server restart:
   *  the rows survive, every in-memory field (the stall clock) does not. */
  const build = () => {
    const stage = createBunStoreExecutor({ database: db }).queries
    if (!stage) throw new Error('the test database is not bun-backed')
    return new ApprovalService({
      store: new ApprovalsRepository(stage),
      now: () => '2026-07-13T00:00:00.000Z',
      toMachine: (machineId, msg) => sent.push({ machineId, msg }),
      hasDaemon: () => daemon.attached,
      nowMs: () => clock.ms,
      clients: () => [
        { send: (m: LiveServerMessage) => broadcasts.push(m), principal: { user: OWNER } },
      ],
      sessionOwner: async () => OWNER,
      sessionIssueId: () => asIssueId('iss_1'),
      issueInfo: () => ({ seq: 410, title: 'Approval broker' }),
      machineName: () => 'ludovico',
      logEvent: (kind, issueId) => {
        events.push({ kind, issueId })
      },
      notifyIssue: async (_issueId, body) => {
        mails.push(body)
      },
      ...(executeServerOp ? { executeServerOp } : {}),
    })
  }
  return { svc: build(), restart: build, sent, broadcasts, events, mails, daemon, clock }
}

const req = (svc: ApprovalService, op: unknown = { kind: 'update' }) =>
  svc.request({ op, sessionId: asSessionId('s1'), machineId: 'm1' })

describe('ApprovalService', () => {
  it('request files a pending row, logs, and broadcasts', async () => {
    const { svc, broadcasts, events } = harness()
    const r = await req(svc)
    expect(r.status).toBe('pending')
    expect(r.message).toContain('awaiting the operator')
    expect(events).toEqual([{ kind: 'issue.approval_requested', issueId: 'iss_1' }])
    expect(broadcasts.at(-1)).toMatchObject({ type: 'approvalsChanged' })
    expect(await svc.listPending(OWNER)).toHaveLength(1)
    expect((await svc.listPending(OWNER))[0]).toMatchObject({
      machineName: 'ludovico',
      issueSeq: 410,
      op: { kind: 'update' },
    })
  })

  it('an identical pending op on the same machine is deduped, not stacked', async () => {
    const { svc } = harness()
    const a = await req(svc)
    const b = await req(svc)
    expect(b.id).toBe(a.id)
    expect(await svc.listPending(OWNER)).toHaveLength(1)
  })

  it('rejects an op outside the closed catalog', async () => {
    const { svc } = harness()
    await expect(req(svc, { kind: 'rm-rf' })).rejects.toThrow()
    await expect(req(svc, { kind: 'set-server' })).rejects.toThrow() // missing target
  })

  it('approve → executing + exec request to the owning daemon; result lands', async () => {
    const { svc, sent, events } = harness()
    const { id } = await req(svc)
    const w = await svc.approve(id, OWNER)
    expect(w.status).toBe('executing')
    expect(sent).toEqual([
      {
        machineId: 'm1',
        msg: { type: 'approvalExecRequest', requestId: id, op: { kind: 'update' } },
      },
    ])
    await svc.onExecResult({
      type: 'approvalExecResult',
      requestId: id,
      ok: true,
      exitCode: 0,
      output: 'ok',
    })
    expect((await svc.get({ id })).status).toBe('succeeded')
    expect(events.map((e) => e.kind)).toEqual([
      'issue.approval_requested',
      'issue.approval_approved',
      'issue.approval_succeeded',
    ])
  })

  it('deny is terminal, mails the requesting issue, and double-decisions throw', async () => {
    const { svc, sent, mails } = harness()
    const { id } = await req(svc)
    expect((await svc.deny(id, OWNER)).status).toBe('denied')
    expect(mails).toEqual([expect.stringContaining('denied by the operator')])
    await expect(svc.approve(id, OWNER)).rejects.toThrow(/not pending/)
    expect(sent).toHaveLength(0)
  })
  it('executes server-owned workflow approvals without forwarding them to a daemon', async () => {
    const executed: Array<{ op: ApprovalOp; sessionId: SessionId }> = []
    const { svc, sent, events } = harness((op, sessionId) => {
      executed.push({ op, sessionId })
      return 'published workflow revision wfr_1'
    })
    const { id } = await req(svc, { kind: 'workflow-publish', revisionId: 'wfr_1' })
    const result = await svc.approve(id, OWNER)
    expect(result).toMatchObject({
      status: 'succeeded',
      resultText: 'published workflow revision wfr_1',
    })
    expect(executed).toEqual([
      { op: { kind: 'workflow-publish', revisionId: 'wfr_1' }, sessionId: asSessionId('s1') },
    ])
    expect(sent).toEqual([])
    expect(events.at(-1)?.kind).toBe('issue.approval_succeeded')
  })

  it('no mail when the requesting CLI is still blocked on the decision (it reports itself)', async () => {
    const { svc, mails } = harness()
    const { id } = await req(svc)
    await svc.getFromAgent({ id }) // the blocked CLI polling — marks a live waiter
    await svc.deny(id, OWNER)
    expect(mails).toEqual([]) // the command prints "denied" itself; no duplicate push
  })

  it('failed execution records the output and mails the outcome', async () => {
    const { svc, mails } = harness()
    const { id } = await req(svc)
    await svc.approve(id, OWNER)
    await svc.onExecResult({
      type: 'approvalExecResult',
      requestId: id,
      ok: false,
      exitCode: 1,
      output: 'signature verification failed',
    })
    const w = await svc.get({ id })
    expect(w.status).toBe('failed')
    expect(w.resultText).toContain('signature')
    expect(mails.at(-1)).toContain('FAILED')
  })

  /**
   * POD-2223 — the stall deadline.
   *
   * A daemon older than the release that widened `ApprovalChannelTarget` fails
   * `ControlMessage.parse` on `{ kind: 'channel', target: 'dev' }` and, before this,
   * answered nothing at all — verified by running the pre-widening protocol (98f65d411^)
   * against the frame the current server sends. The row then sat `executing` forever:
   * `listPending` is `status = 'pending'` only, so it left the operator's popup at the
   * moment of approval; `notify` only fires on a transition, so the mail fallback never
   * ran; and the agent's CLI gave up after ten minutes saying the outcome would be
   * reported, which was false.
   *
   * The daemon now answers such a frame — but that arm ships in the same release as the
   * value that needs it, so ON MERGE DAY every daemon in the fleet is one without it.
   * This deadline is what covers that fleet.
   */
  describe('stalled executions (POD-2223)', () => {
    const t0 = 1_000_000
    /** Approve a channel op and hand it to the daemon, returning its row id. */
    const approveChannelDev = async (svc: ApprovalService) => {
      const { id } = await req(svc, { kind: 'channel', target: 'dev' })
      await svc.approve(id, OWNER)
      return id
    }

    it('fails a row whose connected daemon never answered, saying what to do about it', async () => {
      const { svc, mails, broadcasts, events } = harness()
      const id = await approveChannelDev(svc)
      await svc.sweepStalledExecutions(t0) // first sight starts the clock

      expect((await svc.get({ id })).status).toBe('executing')
      await svc.sweepStalledExecutions(t0 + APPROVAL_EXEC_DEADLINE_MS)

      const w = await svc.get({ id })
      expect(w.status).toBe('failed')
      // The three things an operator can act on: which machine, the likely cause, and
      // that the outcome is UNKNOWN rather than known-not-to-have-happened.
      expect(w.resultText).toContain('ludovico')
      expect(w.resultText).toMatch(/predates this operation/i)
      expect(w.resultText).toMatch(/may or may not have run/i)
      expect(mails.at(-1)).toContain('FAILED')
      expect(events.at(-1)?.kind).toBe('issue.approval_failed')
      // The operator's clients learn about it too — the row is gone from `pending`, so
      // the broadcast is what re-settles their view.
      expect(broadcasts.at(-1)).toMatchObject({ type: 'approvalsChanged' })
    })

    it('leaves a row alone until the deadline actually passes', async () => {
      const { svc } = harness()
      const id = await approveChannelDev(svc)
      await svc.sweepStalledExecutions(t0)
      await svc.sweepStalledExecutions(t0 + APPROVAL_EXEC_DEADLINE_MS - 1)
      expect((await svc.get({ id })).status).toBe('executing')
    })

    it('never fails a row on first sight, so a server restart is not a mass failure', async () => {
      const { svc, restart } = harness()
      const id = await approveChannelDev(svc)
      // The clock lives in memory, so a restarted server meets rows that are old but
      // UNOBSERVED. Its first sweep, however late, must start their clocks rather than
      // fail every one of them at once.
      const afterRestart = restart()
      await afterRestart.sweepStalledExecutions(t0 + 60 * 60_000)
      expect((await afterRestart.get({ id })).status).toBe('executing')
      // And then hold to the same deadline from there.
      await afterRestart.sweepStalledExecutions(t0 + 60 * 60_000 + APPROVAL_EXEC_DEADLINE_MS)
      expect((await afterRestart.get({ id })).status).toBe('failed')
    })

    it('does not fail a row parked for an absent daemon, and restarts its clock on attach', async () => {
      const { svc, daemon } = harness()
      const id = await approveChannelDev(svc)
      await svc.sweepStalledExecutions(t0)

      // `toMachine` QUEUES for an offline machine: the frame is parked, not lost, so no
      // amount of waiting here is a stall.
      daemon.attached = false
      await svc.sweepStalledExecutions(t0 + 24 * 60 * 60_000)
      expect((await svc.get({ id })).status).toBe('executing')

      // Back on the wire a day later — the clock restarts from here, so the daemon gets
      // its full deadline to answer a frame it has only just received.
      daemon.attached = true
      const back = t0 + 24 * 60 * 60_000 + 60_000
      await svc.sweepStalledExecutions(back)
      expect((await svc.get({ id })).status).toBe('executing')
      await svc.sweepStalledExecutions(back + APPROVAL_EXEC_DEADLINE_MS)
      expect((await svc.get({ id })).status).toBe('failed')
    })

    it('exempts stop, whose daemon kills itself before it can report', async () => {
      const { svc } = harness()
      const { id } = await req(svc, { kind: 'stop' })
      await svc.approve(id, OWNER)
      await svc.sweepStalledExecutions(t0)
      await svc.sweepStalledExecutions(t0 + 10 * APPROVAL_EXEC_DEADLINE_MS)
      // Still `executing`, which the service's own doc calls honest for this op.
      expect((await svc.get({ id })).status).toBe('executing')
    })

    it('lets a late result correct a row the deadline had already failed', async () => {
      const { svc, mails } = harness()
      const id = await approveChannelDev(svc)
      await svc.sweepStalledExecutions(t0)
      await svc.sweepStalledExecutions(t0 + APPROVAL_EXEC_DEADLINE_MS)
      expect((await svc.get({ id })).status).toBe('failed')

      // The machine answers anyway. Being told "it failed" about an op that ran is worse
      // than being told nothing, so the record moves to what actually happened.
      await svc.onExecResult({
        type: 'approvalExecResult',
        requestId: id,
        ok: true,
        exitCode: 0,
        output: 'channel set to dev',
      })
      const w = await svc.get({ id })
      expect(w.status).toBe('succeeded')
      expect(w.resultText).toBe('channel set to dev')
      expect(mails.at(-1)).toMatch(/LATE/)
    })

    it('does not re-open a row that reached a terminal state on its own', async () => {
      const { svc } = harness()
      const id = await approveChannelDev(svc)
      await svc.onExecResult({
        type: 'approvalExecResult',
        requestId: id,
        ok: false,
        exitCode: 1,
        output: 'no such channel',
      })
      expect((await svc.get({ id })).status).toBe('failed')
      // A stray duplicate result must not move a settled row.
      await svc.onExecResult({
        type: 'approvalExecResult',
        requestId: id,
        ok: true,
        exitCode: 0,
        output: 'surprise',
      })
      expect((await svc.get({ id })).resultText).toBe('no such channel')
    })
  })
})


/**
 * The outcome mail is the same shape as the lock bug (POD-3802): a dep wired at
 * the composition root to `IssueService.sendMail`, which opens its own store
 * transaction. `ApprovalService.notify` has always awaited it, so the whole
 * defect was the single `void` at that wiring — which is why the dep is now
 * typed `Promise<void>`, making a discarded promise there a type error rather
 * than a runtime span break [POD-3806].
 *
 * This pins the half a type cannot: that `notify` still AWAITS, so the mail is a
 * properly nested savepoint of the deciding span and not a parallel one. The
 * service is built over the SAME store the span is opened on, as production
 * builds it, and the mail is production-shaped — it opens a real transaction.
 */
describe('ApprovalService under the async store (POD-3806)', () => {
  it('the outcome mail does not break the span the decision runs in', async () => {
    const store = await openTestStore(':memory:')
    const mails: string[] = []
    const svc = new ApprovalService({
      store: store.approvals,
      now: () => '2026-07-13T00:00:00.000Z',
      toMachine: () => {},
      clients: () => [],
      sessionOwner: async () => OWNER,
      sessionIssueId: () => asIssueId('iss_1'),
      issueInfo: () => ({ seq: 410, title: 'Approval broker' }),
      machineName: () => 'ludovico',
      logEvent: () => {},
      notifyIssue: async (_issueId, body) => {
        mails.push(body)
        await store.transact(async () => {
          await store.issues.getIssue(asIssueId('iss_mail'))
        })
      },
    })
    const filed = await req(svc)

    await store.transact(async () => {
      await svc.deny(filed.id, OWNER)
      // The statement the lock bug died on: same span, after the mail.
      await store.issues.getIssue(asIssueId('iss_after'))
    })

    expect(mails).toEqual([
      `approval ${filed.id} ("update podium (self-update from the configured channel)"): denied by the operator`,
    ])
  })
})

/**
 * APPROVALS TARGET THE ACTUAL RUN OWNER (B1, PDM-133).
 *
 * An approval names a session, a machine, an issue and a management operation,
 * and deciding one EXECUTES that operation on somebody's running agent. Before
 * B1 the queue was instance-wide and the decision took an id and nothing else:
 * `listPending()` returned every row to whoever asked, `broadcast()` pushed the
 * same payload to every connected client, and `approve(id)` / `deny(id)` ran for
 * any caller that reached /trpc.
 */
describe('an approval belongs to the human whose run it is about', () => {
  it('does not list another human\'s pending approvals', async () => {
    const { svc } = harness()
    await req(svc)

    // NON-VACUITY: the row exists and the owner can see it. Without this the
    // assertion below passes on an empty store.
    expect(await svc.listPending(OWNER)).toHaveLength(1)
    expect(await svc.listPending(STRANGER)).toEqual([])
  })

  it('refuses approve and deny from a human who does not own the run', async () => {
    const { svc, sent, events } = harness()
    const filed = await req(svc)
    const before = { sent: sent.length, events: events.length }

    // The SAME message an unknown id gets — refusing differently would confirm
    // the approval exists and name a session the caller cannot see.
    await expect(svc.approve(filed.id, STRANGER)).rejects.toThrow(
      `unknown approval request: ${filed.id}`,
    )
    await expect(svc.deny(filed.id, STRANGER)).rejects.toThrow(
      `unknown approval request: ${filed.id}`,
    )

    // AND NOTHING HAPPENED: the refusal refused, it did not act. A thrown error
    // after the daemon frame went out would be the worst of both.
    expect(sent).toHaveLength(before.sent)
    expect(events).toHaveLength(before.events)
    expect(await svc.listPending(OWNER)).toHaveLength(1)

    // THE INSTRUMENT CAN SAY YES: the owner decides the very same row.
    const denied = await svc.deny(filed.id, OWNER)
    expect(denied.status).toBe('denied')
  })

  it('broadcasts each client only its own queue', async () => {
    const db = openMigratedTestDatabase()
    const stage = createBunStoreExecutor({ database: db }).queries
    if (!stage) throw new Error('the test database is not bun-backed')
    const toOwner: LiveServerMessage[] = []
    const toStranger: LiveServerMessage[] = []
    const svc = new ApprovalService({
      store: new ApprovalsRepository(stage),
      now: () => '2026-07-13T00:00:00.000Z',
      toMachine: () => {},
      clients: () => [
        { send: (m: LiveServerMessage) => toOwner.push(m), principal: { user: OWNER } },
        { send: (m: LiveServerMessage) => toStranger.push(m), principal: { user: STRANGER } },
      ],
      sessionOwner: async () => OWNER,
      sessionIssueId: () => asIssueId('iss_1'),
      issueInfo: () => ({ seq: 410, title: 'Approval broker' }),
      machineName: () => 'ludovico',
      logEvent: () => {},
      notifyIssue: async () => {},
    })

    await req(svc)

    // Both clients were pushed to — so this is not "the stranger got nothing
    // because nothing was broadcast".
    expect(toOwner.at(-1)).toMatchObject({ type: 'approvalsChanged' })
    expect(toStranger.at(-1)).toMatchObject({ type: 'approvalsChanged' })
    // ...but only the owner's payload carries the row.
    expect((toOwner.at(-1) as { pending: unknown[] }).pending).toHaveLength(1)
    expect((toStranger.at(-1) as { pending: unknown[] }).pending).toEqual([])
  })
})
