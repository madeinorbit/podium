/**
 * APPROVALS AS EFFECT RECORDS (POD-6674), through the REAL composed server.
 *
 *  - An agent's request is an `approval` effect record: pending, awaiting its
 *    person, no deadline, on the feed. An identical waiting request is answered,
 *    not stacked; an op outside the closed catalog is refused.
 *  - The person decides with `records.effect.edit` on `sync.submit`: the first
 *    decision wins, a stale revision and a second decision are conflicts,
 *    another person and a cleared decision are refused, a replay decides
 *    nothing again.
 *  - Approve: the effect trigger claims it once and runs it: a server-catalog op
 *    on the server, every other op on its daemon, whose result settles it. Deny:
 *    `cancelled`, and the agent is mailed.
 *  - Exactly once: a replayed decision, a second trigger and a restarted runner
 *    never send the daemon a second request or run a server op twice.
 *  - The stall deadline (POD-2223): a connected daemon that never answers makes
 *    the record `unknown` after it; a parked one waits; a late result corrects it.
 *  - Every step lands in the issue's activity log, as before.
 */

import { randomUUID } from 'node:crypto'
import { fixtureCommitWriter, fixtureWriteScope } from '@podium/sync/testing'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { EffectsRunner } from '../effects/runner'
import { disposeOracles, makeOracle, type Oracle } from '../sessions/oracle-support'
import { changeRows, envelope, submit } from '../sync-write/outbox-test-support'
import { APPROVAL_EXEC_DEADLINE_MS } from './service'
import {
  activity,
  approvalDeps,
  askFor,
  awaiting,
  decide,
  execRequests,
  inputOf,
  record,
  relay,
  settled,
} from './test-support'

afterEach(() => disposeOracles())

const result = (o: Oracle, id: string, ok: boolean, output: string) =>
  o.reg.modules.approvals.onExecResult({
    type: 'approvalExecResult',
    requestId: id,
    ok,
    exitCode: ok ? 0 : 1,
    output,
  })

/** The test's revisions are made up: stand in for the workflow's own write check. */
const grantWorkflowWrite = (o: Oracle) =>
  vi.spyOn(approvalDeps(o).opPermission, 'workflowWrite').mockResolvedValue(true)

async function clocked() {
  const clock = { ms: Date.parse('2026-11-08T10:00:00.000Z') }
  const o = await makeOracle({ now: () => clock.ms })
  return { o, clock }
}

describe('an agent asks', () => {
  it('files a pending record awaiting its person, with no deadline, on the feed', async () => {
    const o = await makeOracle()
    const { id, sessionId } = await askFor(o, { kind: 'update' })
    const row = await record(o, id)
    expect(row).toMatchObject({
      kind: 'approval',
      status: 'pending',
      decision: 'awaiting',
      stage: 'awaiting-approval',
      deadlineAt: undefined,
      target: { kind: 'issue' },
    })
    expect(inputOf(row)).toMatchObject({ op: { kind: 'update' }, sessionId })
    // On the feed: the person's devices receive it like any effect record.
    const feed = (await changeRows(o)).filter((c) => c.entity === 'effect' && c.entityId === id)
    expect(feed.length).toBeGreaterThan(0)
    expect(await activity(o, id)).toEqual(['issue.approval_requested'])
    // It is never dispatched while it waits, however often the sweep runs.
    await o.reg.modules.effects?.runner.sweep()
    await settled(o)
    expect((await record(o, id)).status).toBe('pending')
    expect(execRequests(o, id)).toEqual([])
  })

  it('an identical waiting op on the same machine is answered, not stacked', async () => {
    const o = await makeOracle()
    const first = await askFor(o, { kind: 'update' })
    const again = await relay(o, first.sessionId, 'r-again', 'approvals', 'request', {
      op: { kind: 'update' },
    })
    expect(again.result).toMatchObject({
      id: first.id,
      message: expect.stringContaining('already'),
    })
    expect((await awaiting(o)).map((row) => row.id)).toEqual([first.id])
  })

  it('refuses an op outside the closed catalog', async () => {
    const o = await makeOracle()
    const { sessionId } = await askFor(o, { kind: 'update' })
    for (const op of [{ kind: 'rm-rf' }, { kind: 'set-server' }]) {
      const answer = await relay(o, sessionId, `r-${randomUUID()}`, 'approvals', 'request', { op })
      expect(answer.ok).toBe(false)
    }
    expect(await awaiting(o)).toHaveLength(1)
  })

  it('nobody creates one through effects.create', async () => {
    const o = await makeOracle()
    const { id, sessionId } = await askFor(o, { kind: 'update' })
    const reply = await submit(
      o,
      envelope(
        'effects.create',
        {
          id: `eff_${randomUUID()}`,
          kind: 'approval',
          target: { kind: 'session', id: sessionId },
          input: inputOf(await record(o, id)),
        },
        'm-forged-approval',
      ),
    )
    expect(reply).toMatchObject({ outcome: 'rejected' })
    expect(await awaiting(o)).toHaveLength(1)
  })

  it('the agent reads its request with approvals.get, in the CLI words', async () => {
    const o = await makeOracle()
    const { id, sessionId } = await askFor(o, { kind: 'update' })
    const read = await relay(o, sessionId, 'r-get', 'approvals', 'get', { id })
    expect(read.result).toMatchObject({ id, status: 'pending', op: { kind: 'update' } })
  })
})

describe('the person decides with records.effect.edit', () => {
  it('approve: a receipt, one exec request after the commit, and a replay sends nothing', async () => {
    const o = await makeOracle()
    const { id } = await askFor(o, { kind: 'update' })
    const env = envelope(
      'records.effect.edit',
      { id, patch: { decision: 'approve' }, expectedRevision: (await record(o, id)).revision },
      'm-approve-1',
    )
    expect(await submit(o, env)).toMatchObject({ outcome: 'applied', replayed: false })
    expect(await o.store.sync.getAppliedMutation(env.mutationId)).toBeDefined()
    await vi.waitFor(() => expect(execRequests(o, id)).toHaveLength(1))
    expect(execRequests(o, id)[0]).toMatchObject({ op: { kind: 'update' } })
    expect(await record(o, id)).toMatchObject({
      status: 'running',
      decision: 'approve',
      stage: 'executing',
      attempts: 1,
    })

    expect(await submit(o, env)).toMatchObject({ outcome: 'applied', replayed: true })
    await o.reg.modules.effects?.runner.sweep()
    await settled(o)
    expect(execRequests(o, id)).toHaveLength(1)

    await result(o, id, true, 'updated')
    expect(await record(o, id)).toMatchObject({
      status: 'succeeded',
      result: { resultText: 'updated' },
    })
    expect(await activity(o, id)).toEqual([
      'issue.approval_requested',
      'issue.approval_approved',
      'issue.approval_succeeded',
    ])
  })

  it('the first decision wins: a second one, and one on a stale revision, are conflicts', async () => {
    const o = await makeOracle()
    const { id } = await askFor(o, { kind: 'update' })
    const shown = (await record(o, id)).revision
    expect(await decide(o, id, 'deny', { revision: shown })).toMatchObject({ outcome: 'applied' })
    expect(await decide(o, id, 'approve', { revision: shown })).toMatchObject({
      outcome: 'rejected',
      refusal: { kind: 'conflict' },
    })
    expect(await decide(o, id, 'approve')).toMatchObject({ outcome: 'rejected' })
    await settled(o)
    expect(execRequests(o, id)).toEqual([])
    expect(await record(o, id)).toMatchObject({ status: 'cancelled', decision: 'deny' })
  })

  it('deny: cancelled, logged, and the requesting agent is mailed', async () => {
    const o = await makeOracle()
    const mails: string[] = []
    vi.spyOn(approvalDeps(o), 'notifyIssue').mockImplementation(async (_issue, body) => {
      mails.push(body)
    })
    const { id } = await askFor(o, { kind: 'update' })
    expect(await decide(o, id, 'deny')).toMatchObject({ outcome: 'applied' })
    await vi.waitFor(() =>
      expect(mails).toEqual([expect.stringContaining('denied by the operator')]),
    )
    expect(await activity(o, id)).toEqual(['issue.approval_requested', 'issue.approval_denied'])
    const read = await o.reg.modules.approvals.get({ id })
    expect(read).toMatchObject({ status: 'denied', resultText: 'denied by the operator' })
  })

  it('no mail when the requesting CLI is still blocked on the decision (it reports itself)', async () => {
    const o = await makeOracle()
    const notify = vi.spyOn(approvalDeps(o), 'notifyIssue').mockResolvedValue()
    const { id, sessionId } = await askFor(o, { kind: 'update' })
    await relay(o, sessionId, 'r-poll', 'approvals', 'get', { id })
    await decide(o, id, 'deny')
    await settled(o)
    expect(notify).not.toHaveBeenCalled()
  })

  it('an unknown record is not found, and a decision is never cleared', async () => {
    const o = await makeOracle()
    const { id } = await askFor(o, { kind: 'update' })
    expect(await decide(o, `apr_${randomUUID()}`, 'approve')).toMatchObject({
      outcome: 'rejected',
    })
    const unset = await submit(
      o,
      envelope(
        'records.effect.edit',
        { id, patch: {}, unset: ['decision'], expectedRevision: (await record(o, id)).revision },
        'm-unset',
      ),
    )
    expect(unset).toMatchObject({ outcome: 'rejected' })
    expect((await record(o, id)).decision).toBe('awaiting')
  })
})

describe('a server-catalog op', () => {
  it('runs once on the server after the approve commits, never on a daemon', async () => {
    const o = await makeOracle()
    const execute = vi
      .spyOn(approvalDeps(o), 'executeServerOp')
      .mockResolvedValue('published workflow revision rev_1')
    grantWorkflowWrite(o)
    const { id } = await askFor(o, { kind: 'workflow-publish', revisionId: 'rev_1' })
    await decide(o, id, 'approve')
    await vi.waitFor(async () => expect((await record(o, id)).status).toBe('succeeded'))
    expect((await record(o, id)).result).toEqual({
      resultText: 'published workflow revision rev_1',
    })
    expect(execute).toHaveBeenCalledTimes(1)
    expect(execRequests(o, id)).toEqual([])
    expect((await activity(o, id)).at(-1)).toBe('issue.approval_succeeded')
  })

  it('a failing one settles failed, in its words', async () => {
    const o = await makeOracle()
    vi.spyOn(approvalDeps(o), 'executeServerOp').mockRejectedValue(new Error('no such revision'))
    grantWorkflowWrite(o)
    const { id } = await askFor(o, { kind: 'workflow-publish', revisionId: 'rev_gone' })
    await decide(o, id, 'approve')
    await vi.waitFor(async () => expect((await record(o, id)).status).toBe('failed'))
    expect((await record(o, id)).error?.message).toMatch(/no such revision/)
    expect((await o.reg.modules.approvals.get({ id })).status).toBe('failed')
  })

  it('a server that stopped mid-run never runs it again: the record is unknown', async () => {
    const o = await makeOracle()
    const execute = vi.spyOn(approvalDeps(o), 'executeServerOp').mockResolvedValue('ran')
    const effects = o.reg.modules.effects
    if (effects === undefined) throw new Error('no effects module')
    // The process stops between the claim and the op: claimed, no live run.
    await effects.runner.stop()
    grantWorkflowWrite(o)
    const { id } = await askFor(o, { kind: 'workflow-publish', revisionId: 'rev_1' })
    await decide(o, id, 'approve')
    expect(await o.store.effects.claim(fixtureWriteScope(), id, Date.now())).toBeDefined()
    const successor = new EffectsRunner({
      writer: fixtureCommitWriter(),
      repo: o.store.effects,
      registry: effects.executors,
      now: () => Date.now(),
      every: () => () => undefined,
    })
    successor.start()
    await successor.sweep()
    await successor.idle()
    await successor.stop()
    expect(execute).not.toHaveBeenCalled()
    expect(await record(o, id)).toMatchObject({ status: 'unknown', error: { code: 'lost-track' } })
    expect((await activity(o, id)).at(-1)).toBe('issue.approval_failed')
  })
})

describe('a daemon op runs exactly once', () => {
  it('a restarted runner recovers it without sending the daemon a second request', async () => {
    const o = await makeOracle()
    const { id } = await askFor(o, { kind: 'update' })
    await decide(o, id, 'approve')
    await vi.waitFor(() => expect(execRequests(o, id)).toHaveLength(1))
    const effects = o.reg.modules.effects
    if (effects === undefined) throw new Error('no effects module')
    await effects.runner.stop()
    const successor = new EffectsRunner({
      writer: fixtureCommitWriter(),
      repo: o.store.effects,
      registry: effects.executors,
      now: () => Date.now(),
      every: () => () => undefined,
    })
    successor.start()
    await successor.sweep()
    await successor.idle()
    expect(execRequests(o, id)).toHaveLength(1)
    expect((await record(o, id)).status).toBe('running')
    await result(o, id, true, 'updated')
    expect((await record(o, id)).status).toBe('succeeded')
    await successor.stop()
  })

  it('failed execution records the output and mails the outcome', async () => {
    const o = await makeOracle()
    const mails: string[] = []
    vi.spyOn(approvalDeps(o), 'notifyIssue').mockImplementation(async (_issue, body) => {
      mails.push(body)
    })
    const { id } = await askFor(o, { kind: 'update' })
    await decide(o, id, 'approve')
    await vi.waitFor(() => expect(execRequests(o, id)).toHaveLength(1))
    await result(o, id, false, 'signature verification failed')
    const read = await o.reg.modules.approvals.get({ id })
    expect(read.status).toBe('failed')
    expect(read.resultText).toContain('signature')
    expect(mails.at(-1)).toContain('FAILED')
  })

  it('a stray duplicate result does not move a settled record', async () => {
    const o = await makeOracle()
    const { id } = await askFor(o, { kind: 'update' })
    await decide(o, id, 'approve')
    await vi.waitFor(() => expect(execRequests(o, id)).toHaveLength(1))
    await result(o, id, false, 'no such channel')
    await result(o, id, true, 'surprise')
    expect((await o.reg.modules.approvals.get({ id })).resultText).toBe('no such channel')
  })

  it('a stop settles once its request reaches a connected daemon', async () => {
    const o = await makeOracle()
    vi.spyOn(approvalDeps(o), 'hasDaemon').mockReturnValue(true)
    const { id } = await askFor(o, { kind: 'stop' })
    await decide(o, id, 'approve')
    await vi.waitFor(async () => expect((await record(o, id)).status).toBe('succeeded'))
    expect(execRequests(o, id)).toHaveLength(1)
  })
})

/**
 * POD-2223 — the stall deadline. A daemon older than an op-catalog widening drops
 * the frame and answers nothing; on the day the widening ships, every daemon in
 * the fleet is one of those. The deadline is what covers that fleet.
 */
describe('stalled executions (POD-2223)', () => {
  async function handedOff() {
    const { o, clock } = await clocked()
    const daemon = { attached: true }
    vi.spyOn(approvalDeps(o), 'hasDaemon').mockImplementation(() => daemon.attached)
    const mails: string[] = []
    vi.spyOn(approvalDeps(o), 'notifyIssue').mockImplementation(async (_issue, body) => {
      mails.push(body)
    })
    const { id } = await askFor(o, { kind: 'channel', target: 'dev' })
    await decide(o, id, 'approve')
    await vi.waitFor(() => expect(execRequests(o, id)).toHaveLength(1))
    const sweep = async () => {
      await o.reg.modules.effects?.runner.sweep()
      await settled(o)
    }
    return { o, clock, daemon, mails, id, sweep }
  }

  it('makes the record unknown after the deadline, saying what to do about it', async () => {
    const { o, clock, mails, id, sweep } = await handedOff()
    await sweep() // first sight starts the clock
    clock.ms += APPROVAL_EXEC_DEADLINE_MS - 1
    await sweep()
    expect((await record(o, id)).status).toBe('running')
    clock.ms += 1
    await sweep()
    const row = await record(o, id)
    expect(row.status).toBe('unknown')
    expect(row.error?.message).toMatch(/predates this operation/i)
    expect(row.error?.message).toMatch(/may or may not have run/i)
    expect((await o.reg.modules.approvals.get({ id })).status).toBe('failed')
    expect(mails.at(-1)).toContain('FAILED')
    expect((await activity(o, id)).at(-1)).toBe('issue.approval_failed')
  })

  it('does not stall a record parked for an absent daemon, and restarts its clock on attach', async () => {
    const { o, clock, daemon, id, sweep } = await handedOff()
    await sweep()
    daemon.attached = false
    clock.ms += 24 * 60 * 60_000
    await sweep()
    expect((await record(o, id)).status).toBe('running')
    daemon.attached = true
    await sweep()
    clock.ms += APPROVAL_EXEC_DEADLINE_MS - 1
    await sweep()
    expect((await record(o, id)).status).toBe('running')
    clock.ms += 1
    await sweep()
    expect((await record(o, id)).status).toBe('unknown')
  })

  it('lets a late result correct a record the deadline gave up on', async () => {
    const { o, clock, mails, id, sweep } = await handedOff()
    await sweep()
    clock.ms += APPROVAL_EXEC_DEADLINE_MS
    await sweep()
    expect((await record(o, id)).status).toBe('unknown')
    await result(o, id, true, 'channel set to dev')
    expect(await record(o, id)).toMatchObject({
      status: 'succeeded',
      result: { resultText: 'channel set to dev' },
    })
    expect(mails.at(-1)).toMatch(/LATE/)
  })
})
