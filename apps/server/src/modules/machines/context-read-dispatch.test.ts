import { asMachineId, asSessionId } from '@podium/model'
import {
  CAP_CONTEXT_OBSERVATION_V1,
  CAP_CONTEXT_READ_V1,
  type ControlMessage,
} from '@podium/protocol/daemon'
import { describe, expect, it } from 'vitest'
import { type MachinesDeps, MachinesService } from './service'

/** Socket bookkeeping only; no real database or native process. */
const service = () =>
  new MachinesService({
    instanceId: 'default',
    hostMachineId: asMachineId('invented-host'),
    store: {
      machines: {
        getMachine: async () => ({ revokedAt: null }),
        addMachineComponent: () => false,
        setAvailability: async () => {},
        setPresenceSource: () => {},
        committed: { subscribe: () => () => {} },
      },
    } as unknown as MachinesDeps['store'],
  })
const machine = asMachineId('invented-machine')
const request: ControlMessage = {
  type: 'runtimeContextReadRequest',
  requestId: 'context-read-1',
  sessionId: asSessionId('invented-session'),
  read: { intent: 'summary', timeoutMs: 1000 },
}
const cancel: ControlMessage = {
  type: 'runtimeContextReadCancel',
  requestId: 'context-read-1',
  sessionId: asSessionId('invented-session'),
}

describe('context read final-send capability fence', () => {
  it.each([
    request,
    cancel,
  ])('never queues $type for a disconnected or downgraded peer', async (message) => {
    const svc = service()
    const got: ControlMessage[] = []
    const send = (frame: ControlMessage) => {
      got.push(frame)
    }
    try {
      expect(() => svc.toMachine(machine, message)).toThrow(/context read transport/i)
      await svc.attach(machine, send, [CAP_CONTEXT_OBSERVATION_V1])
      expect(() => svc.toMachine(machine, message)).toThrow(/context read transport/i)
      expect(got).toEqual([])
      svc.detach(machine)
      await svc.attach(machine, send, [CAP_CONTEXT_OBSERVATION_V1, CAP_CONTEXT_READ_V1])
      expect(got).toEqual([]) // Nothing replayed from either refusal.
      svc.toMachine(machine, message)
      expect(got).toEqual([message])
      svc.detach(machine)
      expect(() => svc.toMachine(machine, message)).toThrow(/context read transport/i)
      await svc.attach(machine, send, [CAP_CONTEXT_READ_V1])
      expect(got).toEqual([message])
    } finally {
      svc.dispose()
    }
  })
})
