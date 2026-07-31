import { asSessionId } from '@podium/model'
import type { DaemonMessage } from '@podium/protocol'
import { describe, expect, it } from 'vitest'
import type { DaemonContext } from './context'
import { MISSING_SESSION_BINDING_MESSAGE, sessionHandlers } from './session'

function refusalContext(sent: DaemonMessage[]): DaemonContext {
  // Deliberately supplies NO binding service, launch function, durable host, or
  // observer. If either handler proceeds past the authority gate, this context
  // cannot accidentally make the path succeed.
  return {
    send: (message: DaemonMessage) => sent.push(message),
  } as unknown as DaemonContext
}

describe('SessionBinding control authority', () => {
  it('refuses SPAWN when the server-authored binding instruction is absent', async () => {
    const sent: DaemonMessage[] = []
    const sessionId = asSessionId('missing-spawn-binding')

    sessionHandlers.spawn(refusalContext(sent), {
      type: 'spawn',
      sessionId,
      agentKind: 'codex',
      cwd: '/repo',
      geometry: { cols: 80, rows: 24 },
    })
    await Promise.resolve()

    expect(sent).toEqual([
      {
        type: 'spawnError',
        sessionId,
        message: MISSING_SESSION_BINDING_MESSAGE,
      },
    ])
  })

  it('refuses REATTACH when the server-authored binding instruction is absent', async () => {
    const sent: DaemonMessage[] = []
    const sessionId = asSessionId('missing-reattach-binding')

    sessionHandlers.reattach(refusalContext(sent), {
      type: 'reattach',
      sessionId,
      durableLabel: 'podium-missing-reattach-binding',
      agentKind: 'codex',
      cwd: '/repo',
      geometry: { cols: 80, rows: 24 },
    })
    await Promise.resolve()

    expect(sent).toEqual([
      {
        type: 'reattachFailed',
        sessionId,
        reason: MISSING_SESSION_BINDING_MESSAGE,
      },
    ])
  })
})
