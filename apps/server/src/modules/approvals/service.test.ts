import type { ControlMessage, LiveServerMessage } from '@podium/protocol'
import { openDatabase } from '@podium/runtime/sqlite'
import { describe, expect, it } from 'vitest'
import { up as approvalRequests } from '../../migrations/012-approval-requests'
import { ApprovalsRepository } from '../../store/approvals'
import { ApprovalService } from './service'

function harness() {
  const db = openDatabase(':memory:')
  approvalRequests(db)
  const sent: Array<{ machineId: string; msg: ControlMessage }> = []
  const broadcasts: LiveServerMessage[] = []
  const events: Array<{ kind: string; issueId: string | null }> = []
  const svc = new ApprovalService({
    store: new ApprovalsRepository(db),
    now: () => '2026-07-13T00:00:00.000Z',
    toMachine: (machineId, msg) => sent.push({ machineId, msg }),
    clients: () => [{ send: (m: LiveServerMessage) => broadcasts.push(m) }],
    sessionIssueId: () => 'iss_1',
    issueInfo: () => ({ seq: 410, title: 'Approval broker' }),
    machineName: () => 'ludovico',
    logEvent: (kind, issueId) => events.push({ kind, issueId }),
  })
  return { svc, sent, broadcasts, events }
}

const req = (svc: ApprovalService, op: unknown = { kind: 'update' }) =>
  svc.request({ op, sessionId: 's1', machineId: 'm1' })

describe('ApprovalService', () => {
  it('request files a pending row, logs, broadcasts, and names the poll command', () => {
    const { svc, broadcasts, events } = harness()
    const r = req(svc)
    expect(r.status).toBe('pending')
    expect(r.message).toContain('approval status')
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

  it('deny is terminal and double-decisions throw', () => {
    const { svc, sent } = harness()
    const { id } = req(svc)
    expect(svc.deny(id).status).toBe('denied')
    expect(() => svc.approve(id)).toThrow(/not pending/)
    expect(sent).toHaveLength(0)
  })

  it('failed execution records the output', () => {
    const { svc } = harness()
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
  })
})
