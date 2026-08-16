import { asSessionId } from '@podium/model'
import type { DaemonMessage } from '@podium/protocol'
import { describe, expect, it } from 'vitest'
import type { DaemonContext } from '../control/context'
import { daemonRuntimeHost } from './host'

describe('daemonRuntimeHost', () => {
  it.each([
    'never-live',
    'teardown',
  ] as const)('carries a %s terminal queue abandonment across the daemon wire', (reason) => {
    const sent: DaemonMessage[] = []
    const host = daemonRuntimeHost({} as DaemonContext, (message) => sent.push(message))
    const sessionId = asSessionId('session-1')

    host.onDrainAbandoned?.({
      sessionId,
      turns: [
        { id: 'msg-1', text: 'first', origin: 'mail' },
        { id: 'msg-2', text: 'second', origin: 'mail' },
      ],
      reason,
    })

    expect(sent).toEqual([
      {
        type: 'runtimeQueueDrainAbandoned',
        sessionId,
        turnIds: ['msg-1', 'msg-2'],
        reason,
      },
    ])
  })
})
