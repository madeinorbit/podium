import { asMachineId, asSessionId } from '@podium/model'
import type { ControlMessage } from '@podium/protocol/daemon'
import { describe, expect, it } from 'vitest'
import { type MachinesDeps, MachinesService } from './service'

const MACHINE = asMachineId('queued-machine')
const SESSION = asSessionId('queued-session')

/** Socket bookkeeping only: no durable repository or authorization is replaced. */
function service(): MachinesService {
  return new MachinesService({
    instanceId: 'default',
    store: {
      machines: {
        getMachine: async () => ({ id: MACHINE, revokedAt: null }),
        addMachineComponent: () => false,
        setAvailability: async () => {},
        setPresenceSource: () => {},
        committed: { subscribe: () => () => {} },
      },
    } as unknown as MachinesDeps['store'],
    hostMachine: { id: MACHINE },
  })
}

const input = (sessionId = SESSION): ControlMessage => ({
  type: 'runtimeDurableSendRequest',
  requestId: `send-${sessionId}`,
  sessionId,
  rowId: 'queued-row',
  turnId: 'queued-row',
  text: 'withdrawn while disconnected',
  origin: 'controller',
  delivery: 'steer',
  deliveryRecovery: false,
  initialPrompt: false,
})
const cancel = (sessionId = SESSION): ControlMessage => ({
  type: 'runtimeInterruptRequest',
  requestId: `cancel-${sessionId}`,
  sessionId,
  cancelRowId: 'queued-row',
})

describe('queued machine transport retractions', () => {
  it('sends a row cancellation before its buffered input and preserves other control order', async () => {
    const svc = service()
    try {
      const before: ControlMessage = { type: 'input', sessionId: SESSION, data: 'before' }
      const after: ControlMessage = { type: 'input', sessionId: SESSION, data: 'after' }
      const send = input()
      const retract = cancel()
      for (const message of [before, send, after, retract]) svc.toMachine(MACHINE, message)
      const delivered: ControlMessage[] = []
      await svc.attach(MACHINE, (message) => {
        delivered.push(message)
      })
      await svc.flushQueued(MACHINE)
      expect(delivered).toEqual([before, retract, send, after])
      await svc.flushQueued(MACHINE)
      expect(delivered).toHaveLength(4)
    } finally {
      svc.dispose()
    }
  })

  it('keeps a cancellation for the same row id in another session independent', async () => {
    const svc = service()
    try {
      const send = input()
      const retract = cancel(asSessionId('other-session'))
      svc.toMachine(MACHINE, send)
      svc.toMachine(MACHINE, retract)
      const delivered: ControlMessage[] = []
      await svc.attach(MACHINE, (message) => {
        delivered.push(message)
      })
      await svc.flushQueued(MACHINE)
      expect(delivered).toEqual([send, retract])
    } finally {
      svc.dispose()
    }
  })
})
