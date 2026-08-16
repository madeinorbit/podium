import { asSessionId } from '@podium/model'
import type { DaemonMessage } from '@podium/protocol'
import { describe, expect, it } from 'vitest'
import type { DaemonContext } from '../control/context'
import { daemonRuntimeHost } from './host'

describe('daemonRuntimeHost', () => {
  it('carries an abandoned terminal queue across the daemon wire', () => {
    const sent: DaemonMessage[] = []
    const host = daemonRuntimeHost({} as DaemonContext, (message) => sent.push(message))
    const sessionId = asSessionId('session-1')

    host.onDrainAbandoned?.({
      sessionId,
      turns: [
        { id: 'msg-1', text: 'first', origin: 'mail' },
        { id: 'msg-2', text: 'second', origin: 'mail' },
      ],
      reason: 'never-live',
    })

    expect(sent).toEqual([
      {
        type: 'runtimeQueueDrainAbandoned',
        sessionId,
        turnIds: ['msg-1', 'msg-2'],
        reason: 'never-live',
      },
    ])
  })
})
