import { asIssueId, asSessionId, type SessionId } from '@podium/model'
import type { ApprovalOp, LiveServerMessage } from '@podium/protocol'
import type { ControlMessage } from '@podium/protocol/daemon'
import { describe, expect, it } from 'vitest'
import { ApprovalsRepository } from '../../store/approvals'
import { openMigratedTestDatabase } from '../../test-support/migrated-database'
import { APPROVAL_EXEC_DEADLINE_MS, ApprovalService } from './service'

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
  const build = () =>
    new ApprovalService({
      store: new ApprovalsRepository(db),
      now: () => '2026-07-13T00:00:00.000Z',
      toMachine: (machineId, msg) => sent.push({ machineId, msg }),
      hasDaemon: () => daemon.attached,
      nowMs: () => clock.ms,
      clients: () => [{ send: (m: LiveServerMessage) => broadcasts.push(m) }],
      sessionIssueId: () => asIssueId('iss_1'),
      issueInfo: () => ({ seq: 410, title: 'Approval broker' }),
      machineName: () => 'ludovico',
      logEvent: (kind, issueId) => events.push({ kind, issueId }),
      notifyIssue: (_issueId, body) => mails.push(body),
      ...(executeServerOp ? { executeServerOp } : {}),
    })
  return { svc: build(), restart: build, sent, broadcasts, events, mails, daemon, clock }
}

const req = (svc: ApprovalService, op: unknown = { kind: 'update' }) =>
  svc.request({ op, sessionId: asSessionId('s1'), machineId: 'm1' })

describe('ApprovalService', () => {
  it('request files a pending row, logs, and broadcasts', () => {
    const { svc, broadcasts, events } = harness()
    const r = req(svc)
    expect(r.status).toBe('pending')
    expect(r.message).toContain('awaiting the operator')
    expect(events).toEqual([{ kind: 'issue.approval_requested', issueId: 'iss_1' }])
    expect(broadcasts.at(-1)).toMatchObject({ type: 'approvalsChanged' })
    expect(svc.listPending()).toHaveLength(1)
    expect(svc.listPending()[0]).toMatchObject({
      machineName: 'ludovico',
      issueSeq: 410,
      op: { kind: 'update' },
    })
  })

  it('an identical pending op on the same machine is deduped, not stacked', () => {
    const { svc } = harness()
    const a = req(svc)
    const b = req(svc)
    expect(b.id).toBe(a.id)
    expect(svc.listPending()).toHaveLength(1)
  })

  it('rejects an op outside the closed catalog', () => {
    const { svc } = harness()
    expect(() => req(svc, { kind: 'rm-rf' })).toThrow()
    expect(() => req(svc, { kind: 'set-server' })).toThrow() // missing target
  })

  it('approve → executing + exec request to the owning daemon; result lands', () => {
    const { svc, sent, events } = harness()
    const { id } = req(svc)
    const w = svc.approve(id)
    expect(w.status).toBe('executing')
    expect(sent).toEqual([
      {
        machineId: 'm1',
        msg: { type: 'approvalExecRequest', requestId: id, op: { kind: 'update' } },
      },
    ])
    svc.onExecResult({
      type: 'approvalExecResult',
      requestId: id,
      ok: true,
      exitCode: 0,
      output: 'ok',
    })
    expect(svc.get({ id }).status).toBe('succeeded')
    expect(events.map((e) => e.kind)).toEqual([
      'issue.approval_requested',
      'issue.approval_approved',
      'issue.approval_succeeded',
    ])
  })

  it('deny is terminal, mails the requesting issue, and double-decisions throw', () => {
    const { svc, sent, mails } = harness()
    const { id } = req(svc)
    expect(svc.deny(id).status).toBe('denied')
    expect(mails).toEqual([expect.stringContaining('denied by the operator')])
    expect(() => svc.approve(id)).toThrow(/not pending/)
    expect(sent).toHaveLength(0)
  })
  it('executes server-owned workflow approvals without forwarding them to a daemon', () => {
    const executed: Array<{ op: ApprovalOp; sessionId: SessionId }> = []
    const { svc, sent, events } = harness((op, sessionId) => {
      executed.push({ op, sessionId })
      return 'published workflow revision wfr_1'
    })
    const { id } = req(svc, { kind: 'workflow-publish', revisionId: 'wfr_1' })
    const result = svc.approve(id)
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

  it('no mail when the requesting CLI is still blocked on the decision (it reports itself)', () => {
    const { svc, mails } = harness()
    const { id } = req(svc)
    svc.getFromAgent({ id }) // the blocked CLI polling — marks a live waiter
    svc.deny(id)
    expect(mails).toEqual([]) // the command prints "denied" itself; no duplicate push
  })

  it('failed execution records the output and mails the outcome', () => {
    const { svc, mails } = harness()
    const { id } = req(svc)
    svc.approve(id)
    svc.onExecResult({
      type: 'approvalExecResult',
      requestId: id,
      ok: false,
      exitCode: 1,
      output: 'signature verification failed',
    })
    const w = svc.get({ id })
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
    const approveChannelDev = (svc: ApprovalService) => {
      const { id } = req(svc, { kind: 'channel', target: 'dev' })
      svc.approve(id)
      return id
    }

    it('fails a row whose connected daemon never answered, saying what to do about it', () => {
      const { svc, mails, broadcasts, events } = harness()
      const id = approveChannelDev(svc)
      svc.sweepStalledExecutions(t0) // first sight starts the clock

      expect(svc.get({ id }).status).toBe('executing')
      svc.sweepStalledExecutions(t0 + APPROVAL_EXEC_DEADLINE_MS)

      const w = svc.get({ id })
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

    it('leaves a row alone until the deadline actually passes', () => {
      const { svc } = harness()
      const id = approveChannelDev(svc)
      svc.sweepStalledExecutions(t0)
      svc.sweepStalledExecutions(t0 + APPROVAL_EXEC_DEADLINE_MS - 1)
      expect(svc.get({ id }).status).toBe('executing')
    })

    it('never fails a row on first sight, so a server restart is not a mass failure', () => {
      const { svc, restart } = harness()
      const id = approveChannelDev(svc)
      // The clock lives in memory, so a restarted server meets rows that are old but
      // UNOBSERVED. Its first sweep, however late, must start their clocks rather than
      // fail every one of them at once.
      const afterRestart = restart()
      afterRestart.sweepStalledExecutions(t0 + 60 * 60_000)
      expect(afterRestart.get({ id }).status).toBe('executing')
      // And then hold to the same deadline from there.
      afterRestart.sweepStalledExecutions(t0 + 60 * 60_000 + APPROVAL_EXEC_DEADLINE_MS)
      expect(afterRestart.get({ id }).status).toBe('failed')
    })

    it('does not fail a row parked for an absent daemon, and restarts its clock on attach', () => {
      const { svc, daemon } = harness()
      const id = approveChannelDev(svc)
      svc.sweepStalledExecutions(t0)

      // `toMachine` QUEUES for an offline machine: the frame is parked, not lost, so no
      // amount of waiting here is a stall.
      daemon.attached = false
      svc.sweepStalledExecutions(t0 + 24 * 60 * 60_000)
      expect(svc.get({ id }).status).toBe('executing')

      // Back on the wire a day later — the clock restarts from here, so the daemon gets
      // its full deadline to answer a frame it has only just received.
      daemon.attached = true
      const back = t0 + 24 * 60 * 60_000 + 60_000
      svc.sweepStalledExecutions(back)
      expect(svc.get({ id }).status).toBe('executing')
      svc.sweepStalledExecutions(back + APPROVAL_EXEC_DEADLINE_MS)
      expect(svc.get({ id }).status).toBe('failed')
    })

    it('exempts stop, whose daemon kills itself before it can report', () => {
      const { svc } = harness()
      const { id } = req(svc, { kind: 'stop' })
      svc.approve(id)
      svc.sweepStalledExecutions(t0)
      svc.sweepStalledExecutions(t0 + 10 * APPROVAL_EXEC_DEADLINE_MS)
      // Still `executing`, which the service's own doc calls honest for this op.
      expect(svc.get({ id }).status).toBe('executing')
    })

    it('lets a late result correct a row the deadline had already failed', () => {
      const { svc, mails } = harness()
      const id = approveChannelDev(svc)
      svc.sweepStalledExecutions(t0)
      svc.sweepStalledExecutions(t0 + APPROVAL_EXEC_DEADLINE_MS)
      expect(svc.get({ id }).status).toBe('failed')

      // The machine answers anyway. Being told "it failed" about an op that ran is worse
      // than being told nothing, so the record moves to what actually happened.
      svc.onExecResult({
        type: 'approvalExecResult',
        requestId: id,
        ok: true,
        exitCode: 0,
        output: 'channel set to dev',
      })
      const w = svc.get({ id })
      expect(w.status).toBe('succeeded')
      expect(w.resultText).toBe('channel set to dev')
      expect(mails.at(-1)).toMatch(/LATE/)
    })

    it('does not re-open a row that reached a terminal state on its own', () => {
      const { svc } = harness()
      const id = approveChannelDev(svc)
      svc.onExecResult({
        type: 'approvalExecResult',
        requestId: id,
        ok: false,
        exitCode: 1,
        output: 'no such channel',
      })
      expect(svc.get({ id }).status).toBe('failed')
      // A stray duplicate result must not move a settled row.
      svc.onExecResult({
        type: 'approvalExecResult',
        requestId: id,
        ok: true,
        exitCode: 0,
        output: 'surprise',
      })
      expect(svc.get({ id }).resultText).toBe('no such channel')
    })
  })
})
