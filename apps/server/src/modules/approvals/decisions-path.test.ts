/**
 * THE APPROVAL DECISIONS ON THE ONE WRITE PATH (POD-6415, design B).
 *
 * Driven through the REAL composed server (`makeOracle`):
 *
 *  - `approvals.approve` and `approvals.deny` arrive through `sync.submit`, and
 *    their old routes are adapters onto it; a replay decides nothing again.
 *  - a daemon op reaches the owning daemon once, after the commit, and never
 *    on a rollback;
 *  - a server-catalog op runs from an `approval.execute` record created in the
 *    decision's unit; nobody else may create that kind;
 *  - an unknown request is not found, a decided one a conflict.
 */

import { randomUUID } from 'node:crypto'
import type { ApprovalOp } from '@podium/protocol'
import type { ControlMessage } from '@podium/protocol/daemon'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { disposeOracles, makeOracle, type Oracle } from '../sessions/oracle-support'
import { envelope, submit } from '../sync-write/outbox-test-support'
import { APPROVAL_EXECUTE_KIND } from './execute-effect'

afterEach(() => disposeOracles())

const settle = () => new Promise((resolve) => setTimeout(resolve, 50))

const execRequests = (daemon: ControlMessage[], id: string) =>
  daemon.filter((m) => m.type === 'approvalExecRequest' && m.requestId === id)

async function filed(o: Oracle, op: ApprovalOp): Promise<string> {
  const { sessionId } = await o.reg.modules.sessions.createSession({
    agentKind: 'claude-code',
    cwd: '/p',
  })
  const { id } = await o.reg.modules.approvals.request({
    op,
    sessionId,
    machineId: o.reg.sessionStore.hostMachineId,
  })
  return id
}

/** The service's server catalog, for the test to stand in for. */
const serverCatalog = (o: Oracle) =>
  (
    o.reg.modules.approvals as unknown as {
      deps: { executeServerOp: (op: ApprovalOp, sessionId: string) => Promise<string | null> }
    }
  ).deps

describe('approvals.approve is on the sync write entry point', () => {
  it('a daemon op: applied with a receipt, sent to the daemon once after the commit; a replay sends nothing', async () => {
    const o = await makeOracle()
    const id = await filed(o, { kind: 'update' })
    const env = envelope('approvals.approve', { id }, 'm-approve-1')

    const reply = await submit(o, env)
    expect(reply).toMatchObject({
      outcome: 'applied',
      replayed: false,
      result: { id, status: 'executing' },
    })
    expect(await o.store.sync.getAppliedMutation(env.mutationId)).toBeDefined()
    await vi.waitFor(() => expect(execRequests(o.daemon, id)).toHaveLength(1))

    expect(await submit(o, env)).toMatchObject({ outcome: 'applied', replayed: true })
    await settle()
    expect(execRequests(o.daemon, id)).toHaveLength(1)
  })

  it('a rollback sends the daemon nothing and leaves the request pending', async () => {
    const o = await makeOracle()
    const id = await filed(o, { kind: 'update' })
    // The decision's last step, inside the unit, fails: the unit rolls back.
    vi.spyOn(
      o.reg.modules.approvals as unknown as { toWire: () => never },
      'toWire',
    ).mockRejectedValueOnce(new Error('forced rollback'))

    await expect(
      submit(o, envelope('approvals.approve', { id }, 'm-approve-rollback')),
    ).rejects.toThrow()
    await settle()
    expect(execRequests(o.daemon, id)).toEqual([])
    expect((await o.store.approvals.get(id))?.status).toBe('pending')
  })

  it('the old tRPC route is an adapter onto the entry point', async () => {
    const o = await makeOracle()
    const id = await filed(o, { kind: 'update' })
    const submitted = vi.spyOn(o.reg.modules.syncWrite, 'submitDetailed')

    expect(await o.call.approvals.approve({ id })).toMatchObject({ id, status: 'executing' })
    expect(submitted).toHaveBeenCalledWith(
      expect.objectContaining({ command: 'approvals.approve', input: { id } }),
      expect.anything(),
      'trpc',
    )
  })

  it('a server-catalog op runs once from an approval.execute record, never on a daemon', async () => {
    const o = await makeOracle()
    const id = await filed(o, { kind: 'workflow-publish', revisionId: 'rev_1' })
    const execute = vi
      .spyOn(serverCatalog(o), 'executeServerOp')
      .mockResolvedValue('published workflow revision rev_1')
    const insert = vi.spyOn(o.store.effects, 'insert')

    const reply = await submit(o, envelope('approvals.approve', { id }, 'm-approve-server'))
    expect(reply).toMatchObject({ outcome: 'applied' })
    const [created] = insert.mock.calls
      .map(([, row]) => row)
      .filter((row) => row.kind === APPROVAL_EXECUTE_KIND)
    expect(created).toMatchObject({ input: { approvalId: id }, target: { kind: 'session' } })

    await vi.waitFor(async () =>
      expect((await o.store.approvals.get(id))?.status).toBe('succeeded'),
    )
    expect((await o.store.approvals.get(id))?.resultText).toBe('published workflow revision rev_1')
    await vi.waitFor(async () =>
      expect((await o.store.effects.get(created!.id))?.status).toBe('succeeded'),
    )
    expect(execute).toHaveBeenCalledTimes(1)
    expect(execRequests(o.daemon, id)).toEqual([])
  })

  it('a failing server-catalog op settles the request failed, in its words', async () => {
    const o = await makeOracle()
    const id = await filed(o, { kind: 'workflow-publish', revisionId: 'rev_gone' })
    vi.spyOn(serverCatalog(o), 'executeServerOp').mockRejectedValue(new Error('no such revision'))

    await submit(o, envelope('approvals.approve', { id }, 'm-approve-server-fails'))
    await vi.waitFor(async () => expect((await o.store.approvals.get(id))?.status).toBe('failed'))
    expect((await o.store.approvals.get(id))?.resultText).toMatch(/no such revision/)
  })

  it('nobody creates an approval.execute record through effects.create', async () => {
    const o = await makeOracle()
    const id = await filed(o, { kind: 'workflow-publish', revisionId: 'rev_1' })
    const execute = vi.spyOn(serverCatalog(o), 'executeServerOp')
    const { sessionId } = (await o.store.approvals.get(id))!
    const reply = await submit(
      o,
      envelope(
        'effects.create',
        {
          id: `eff_${randomUUID()}`,
          kind: APPROVAL_EXECUTE_KIND,
          target: { kind: 'session', id: sessionId },
          input: { approvalId: id },
        },
        'm-forged-execute',
      ),
    )
    expect(reply).toMatchObject({ outcome: 'rejected', refusal: { kind: 'unauthorized' } })
    await settle()
    expect(execute).not.toHaveBeenCalled()
    expect((await o.store.approvals.get(id))?.status).toBe('pending')
  })
})

describe('approvals.deny is on the sync write entry point', () => {
  it('denies once; a second decision is a conflict and an unknown request is not found', async () => {
    const o = await makeOracle()
    const id = await filed(o, { kind: 'update' })

    expect(await submit(o, envelope('approvals.deny', { id }, 'm-deny-1'))).toMatchObject({
      outcome: 'applied',
      result: { id, status: 'denied' },
    })
    expect(
      await submit(o, envelope('approvals.approve', { id }, 'm-approve-after-deny')),
    ).toMatchObject({
      outcome: 'rejected',
      refusal: { kind: 'conflict', message: expect.stringMatching(/not pending/) },
    })
    expect(
      await submit(o, envelope('approvals.deny', { id: 'apr_nope' }, 'm-deny-unknown')),
    ).toMatchObject({ outcome: 'rejected', refusal: { kind: 'target-not-found' } })
    await settle()
    expect(execRequests(o.daemon, id)).toEqual([])
  })
})
