/**
 * A TURN-SCOPED INTERRUPT, JUDGED BY THE DAEMON (POD-6397).
 *
 * The daemon owns the turn marker (it folds the session's runtime state), so it
 * alone says whether the turn a stop names is over. Over: nothing is stopped
 * and it answers `turn_ended`. Hermetic: a stub handle, no process.
 */

import type { AgentRuntimeState, SessionId } from '@podium/model'
import type { DaemonMessage } from '@podium/protocol/daemon'
import { describe, expect, it, vi } from 'vitest'
import type { DaemonContext } from '../control/context'
import { runtimeHandlers } from './handlers'

const SESSION = 'session-interrupt-turn' as SessionId
const T0 = '2026-11-05T10:00:00.000Z'
const T1 = '2026-11-05T10:01:00.000Z'

type LifecycleResult = Extract<DaemonMessage, { type: 'runtimeLifecycleResult' }>

function makeContext(turnState: AgentRuntimeState | undefined) {
  const sent: DaemonMessage[] = []
  const interrupt = vi.fn(async () => undefined)
  const handle = { binding: { sessionId: SESSION }, interrupt }
  const ctx = {
    send: (msg: DaemonMessage) => {
      sent.push(msg)
    },
    agentRuntime: { handleFor: () => handle },
    sessions: new Map([[SESSION, { turnState }]]),
  } as unknown as DaemonContext
  return { ctx, sent, interrupt }
}

async function stop(ctx: DaemonContext, sent: DaemonMessage[], turn?: string) {
  runtimeHandlers.runtimeInterruptRequest(ctx, {
    type: 'runtimeInterruptRequest',
    requestId: 'req-1',
    sessionId: SESSION,
    ...(turn !== undefined ? { turn } : {}),
  } as never)
  await vi.waitFor(() =>
    expect(sent.some((msg) => msg.type === 'runtimeLifecycleResult')).toBe(true),
  )
  return (sent.find((msg) => msg.type === 'runtimeLifecycleResult') as LifecycleResult).result
}

const working = (turnStartedAt: string): AgentRuntimeState => ({
  phase: 'working',
  since: turnStartedAt,
  nativeSubagentCount: 0,
  turnStartedAt,
})

describe('runtimeInterruptRequest with a named turn', () => {
  it('stops the turn it names while that turn runs', async () => {
    const { ctx, sent, interrupt } = makeContext(working(T0))
    expect(await stop(ctx, sent, T0)).toEqual({ ok: true })
    expect(interrupt).toHaveBeenCalledTimes(1)
  })

  it('a later turn runs: answers turn_ended and never touches it', async () => {
    const { ctx, sent, interrupt } = makeContext(working(T1))
    expect(await stop(ctx, sent, T0)).toEqual({ reason: 'turn_ended' })
    expect(interrupt).not.toHaveBeenCalled()
  })

  it('no turn runs: answers turn_ended', async () => {
    const { ctx, sent, interrupt } = makeContext({
      phase: 'idle',
      since: T1,
      nativeSubagentCount: 0,
      turnStartedAt: T0,
    })
    expect(await stop(ctx, sent, T0)).toEqual({ reason: 'turn_ended' })
    expect(interrupt).not.toHaveBeenCalled()
  })

  it('a stop that names no turn, or a session whose state was never seen, is sent as before', async () => {
    const idle: AgentRuntimeState = { phase: 'idle', since: T1, nativeSubagentCount: 0 }
    const bare = makeContext(idle)
    expect(await stop(bare.ctx, bare.sent)).toEqual({ ok: true })
    expect(bare.interrupt).toHaveBeenCalledTimes(1)
    const unseen = makeContext(undefined)
    expect(await stop(unseen.ctx, unseen.sent, T0)).toEqual({ ok: true })
    expect(unseen.interrupt).toHaveBeenCalledTimes(1)
  })
})
