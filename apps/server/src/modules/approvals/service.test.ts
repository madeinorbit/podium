import type { ApprovalOp, ControlMessage, LiveServerMessage } from '@podium/protocol'
import { openDatabase } from '@podium/runtime/sqlite'
import { describe, expect, it } from 'vitest'
import { up as approvalRequests } from '../../migrations/012-approval-requests'
import { ApprovalsRepository } from '../../store/approvals'
import { ApprovalService } from './service'

function harness(executeServerOp?: (op: ApprovalOp, sessionId: string) => string | null) {
  const db = openDatabase(':memory:')
  approvalRequests(db)
  const sent: Array<{ machineId: string; msg: ControlMessage }> = []
  const broadcasts: LiveServerMessage[] = []
  const events: Array<{ kind: string; issueId: string | null }> = []
  const mails: string[] = []
  const svc = new ApprovalService({
    store: new ApprovalsRepository(db),
    now: () => '2026-07-13T00:00:00.000Z',
    toMachine: (machineId, msg) => sent.push({ machineId, msg }),
    clients: () => [{ send: (m: LiveServerMessage) => broadcasts.push(m) }],
    sessionIssueId: () => 'iss_1',
    issueInfo: () => ({ seq: 410, title: 'Approval broker' }),
    machineName: () => 'ludovico',
    logEvent: (kind, issueId) => events.push({ kind, issueId }),
    notifyIssue: (_issueId, body) => mails.push(body),
    ...(executeServerOp ? { executeServerOp } : {}),
  })
  return { svc, sent, broadcasts, events, mails }
}

const req = (svc: ApprovalService, op: unknown = { kind: 'update' }) =>
  svc.request({ op, sessionId: 's1', machineId: 'm1' })

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
    const executed: Array<{ op: ApprovalOp; sessionId: string }> = []
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
      { op: { kind: 'workflow-publish', revisionId: 'wfr_1' }, sessionId: 's1' },
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
})
