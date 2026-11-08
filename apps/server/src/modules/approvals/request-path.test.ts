/**
 * AN AGENT'S APPROVAL REQUEST ON THE ONE WRITE PATH (POD-6603).
 *
 * `podium approval request` from a relayed agent, through the REAL composed
 * server: it arrives through `sync.submit` on the relay; its activity event
 * carries the command's provenance and the reply a receipt; a replay answers
 * the recorded request and files nothing; the target check holds it to the
 * calling session; the old relay arm is an adapter onto `submit`, and the relay
 * census has no direct write left.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { resolvePrincipalAsync } from '../../command-principal'
import { disposeOracles, makeOracle, type Oracle } from '../sessions/oracle-support'
import { FAMILY_COMMAND_NAMES } from '../sync-write/family-commands'
import { envelope, head, rowsOf } from '../sync-write/outbox-test-support'
import { RELAY_ARMS } from '../write-routes/relay'
import { agentOnIssue, awaiting, inputOf, relay } from './test-support'

afterEach(() => disposeOracles())

const pending = async (o: Oracle) =>
  (await awaiting(o)).map((row) => ({ id: row.id, ...inputOf(row) }))

/** How many `issue.approval_requested` events name this request. */
const requested = async (o: Oracle, approvalId: string) =>
  (await o.store.events.listEventsSince(0, { kinds: ['issue.approval_requested'] })).filter(
    (event) => (event.payload as { approvalId?: string } | undefined)?.approvalId === approvalId,
  ).length

describe('approvals.request on the entry point', () => {
  it('is a registered sync write, and the relay census lists it as an adapter', async () => {
    const o = await makeOracle()
    expect(o.reg.modules.syncWrite.registry.names()).toContain('approvals.request')
    expect(FAMILY_COMMAND_NAMES).toContain('approvals.request')
    expect(RELAY_ARMS['approvals.request']).toEqual({ kind: 'adapter', via: 'sync' })
    expect(Object.values(RELAY_ARMS).filter((arm) => arm.kind === 'direct')).toEqual([])
  })

  it('through sync.submit: provenance on its event, a receipt, and a replay files nothing', async () => {
    const o = await makeOracle()
    const sessionId = await agentOnIssue(o, 'asks first')
    const env = envelope('approvals.request', { op: { kind: 'update' } }, 'mut_apr_1')

    const first = await relay(o, sessionId, 'r-apr-1', 'sync', 'submit', env)
    expect(first.ok).toBe(true)
    const reply = first.result as {
      outcome: string
      replayed?: boolean
      result: { id: string; status: string }
      receipt: { seq: number }
    }
    expect(reply).toMatchObject({ outcome: 'applied', result: { status: 'pending' } })
    const filed = await pending(o)
    expect(filed.map((row) => row.id)).toEqual([reply.result.id])
    expect(filed[0]).toMatchObject({ sessionId, machineId: o.store.hostMachineId })

    // Provenance: the request is recorded under the envelope's mutationId, and
    // its activity event once. The approval record is on the change log (an
    // `effect` row, POD-6674) with the command's causation, and the receipt is
    // at the head.
    expect(await o.store.sync.getAppliedMutation(env.mutationId)).toBeDefined()
    expect(await requested(o, reply.result.id)).toBe(1)
    const rows = await rowsOf(o, env.mutationId)
    expect(rows.some((row) => row.entity === 'effect' && row.entityId === reply.result.id)).toBe(
      true,
    )
    for (const row of rows) expect(row.causationId).toBe(env.mutationId)
    expect(reply.receipt.seq).toBeGreaterThanOrEqual(Math.max(0, ...rows.map((row) => row.seq)))
    expect(reply.receipt.seq).toBeLessThanOrEqual(await head(o))

    const replay = await relay(o, sessionId, 'r-apr-2', 'sync', 'submit', env)
    expect(replay.result).toMatchObject({
      outcome: 'applied',
      replayed: true,
      result: reply.result,
    })
    expect((await pending(o)).length).toBe(1)
    expect(await requested(o, reply.result.id)).toBe(1)
    expect((await rowsOf(o, env.mutationId)).length).toBe(rows.length)
  })

  it('the old relay arm is an adapter onto submit', async () => {
    const o = await makeOracle()
    const sessionId = await agentOnIssue(o, 'old arm')
    const entry = vi.spyOn(o.reg.modules.syncWrite, 'submitDetailed')
    const answer = await relay(o, sessionId, 'r-apr-old', 'approvals', 'request', {
      op: { kind: 'update' },
    })
    expect(answer).toMatchObject({ ok: true, result: { status: 'pending' } })
    expect(entry.mock.calls.map(([env]) => env.command)).toEqual(['approvals.request'])
    // An identical pending request is answered, not filed twice.
    const again = await relay(o, sessionId, 'r-apr-again', 'approvals', 'request', {
      op: { kind: 'update' },
    })
    expect(again.result).toMatchObject({ message: expect.stringContaining('already requested') })
    expect((await pending(o)).length).toBe(1)
  })

  it("the target check holds it to the calling session: another session's id is refused", async () => {
    const o = await makeOracle()
    const asker = await agentOnIssue(o, 'asker')
    const other = (await o.reg.modules.sessions.createSession({ cwd: '/w', agentKind: 'shell' }))
      .sessionId
    const capability = await o.reg.modules.sessions.capabilityForSession(asker)
    const principal = await resolvePrincipalAsync(capability, {
      parentSessionOf: async () => undefined,
    })
    const forged = envelope(
      'approvals.request',
      { op: { kind: 'update' }, sessionId: other, machineId: o.store.hostMachineId },
      'mut_apr_forged',
    )

    const reply = await o.reg.modules.syncWrite.submit(forged, principal, 'relay')

    expect(reply).toMatchObject({ outcome: 'rejected', refusal: { kind: 'unauthorized' } })
    expect(await pending(o)).toEqual([])
  })

  it('nobody without a session behind them files one, and a person has no tRPC door', async () => {
    const o = await makeOracle()
    const env = envelope('approvals.request', { op: { kind: 'update' } }, 'mut_apr_person')
    expect(await o.call.sync.submit(env)).toMatchObject({ outcome: 'rejected' })
    expect(await pending(o)).toEqual([])
  })
})
