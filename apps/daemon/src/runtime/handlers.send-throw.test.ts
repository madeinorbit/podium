/**
 * A THROWN send is `unverified` for a DURABLE row, never `refused` (POD-4622).
 *
 * The server releases a durable row's reservation when the daemon answers
 * `refused / not_running`, reading it as proof nothing was typed — true for
 * "no handle", the readiness window. A throw out of `handle.send` proves no
 * such thing: it may follow the row's admission. So the durable arm says
 * `unverified` and the server keeps custody (confirm-or-fail). The plain
 * send arm keeps its `not_running` answer: no durable row rides on it.
 */

import type { AgentSessionHandle } from '@podium/harness/driver/host'
import { asSessionId } from '@podium/model'
import type { DaemonMessage } from '@podium/protocol/daemon'
import { describe, expect, it, vi } from 'vitest'
import type { DaemonContext } from '../control/context'
import { runtimeHandlers } from './handlers'

const SESSION = asSessionId('s-send-throw')

function daemonWithThrowingSend() {
  const sent: DaemonMessage[] = []
  const handle = {
    binding: { sessionId: SESSION, driver: 'stub', harness: 'codex' },
    send: vi.fn(async () => {
      throw new Error('engine socket closed after admission')
    }),
  } as unknown as AgentSessionHandle
  const ctx = {
    agentRuntime: { handleFor: () => handle },
    send: (msg: DaemonMessage) => void sent.push(msg),
  } as unknown as DaemonContext
  const results = () => sent.filter((msg) => msg.type === 'runtimeSendResult')
  return { handle, ctx, results }
}

describe('a send that throws is answered with what is true', () => {
  it('a DURABLE row is unverified: the throw may follow its admission', async () => {
    const d = daemonWithThrowingSend()
    runtimeHandlers.runtimeSendRequest(d.ctx, {
      type: 'runtimeSendRequest',
      requestId: 'req-row',
      turnId: 'row-1',
      rowId: 'row-1',
      deliveryRecovery: false,
      sessionId: SESSION,
      text: 'the queued prompt',
      origin: 'controller',
      delivery: 'when-ready',
    } as never)

    await vi.waitFor(() => expect(d.results()).toHaveLength(1))
    expect(d.handle.send).toHaveBeenCalledTimes(1)
    expect(d.results()[0]).toMatchObject({
      requestId: 'req-row',
      receipt: { outcome: 'unverified', deliveredAs: 'when-ready' },
    })
  })

  it('…and a plain send, with no durable row, keeps not_running (the control arm)', async () => {
    const d = daemonWithThrowingSend()
    runtimeHandlers.runtimeSendRequest(d.ctx, {
      type: 'runtimeSendRequest',
      requestId: 'req-plain',
      turnId: 'plain-1',
      sessionId: SESSION,
      text: 'a plain send',
      origin: 'controller',
      delivery: 'when-ready',
    } as never)

    await vi.waitFor(() => expect(d.results()).toHaveLength(1))
    expect(d.handle.send).toHaveBeenCalledTimes(1)
    expect(d.results()[0]).toMatchObject({
      requestId: 'req-plain',
      receipt: { outcome: 'refused', refusal: { reason: 'not_running' } },
    })
  })
})
