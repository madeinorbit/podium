import type { ControlMessage } from '@podium/protocol'
import { describe, expect, test } from 'vitest'
import type { Send } from '../sessions/session'
import { type MachinesDeps, MachinesService } from './service'

/** Only the socket bookkeeping is exercised here — none of these paths touch the store. */
function makeService(): MachinesService {
  const deps = {
    store: {} as MachinesDeps['store'],
    retargetPlaceholderSessions: () => {},
    broadcastSessions: () => {},
    clients: () => [],
  } satisfies MachinesDeps
  return new MachinesService(deps)
}

const MACHINE = 'vmi'
/** A keystroke — the message class that silently queued into the void during the outage. */
const keystroke: ControlMessage = { type: 'input', sessionId: 's1', data: 'ls\r' }

function recorder(): { send: Send<ControlMessage>; got: ControlMessage[] } {
  const got: ControlMessage[] = []
  return { send: (m) => got.push(m), got }
}

describe('MachinesService daemon socket identity', () => {
  test('a superseded socket’s late close does not evict the reconnected daemon', () => {
    // Reproduces the 2026-07-09 vmi outage: the daemon reconnects while its previous
    // socket is wedged; the keepalive sweep terminates the old socket a beat later and
    // its `close` fires. Keyed only by machineId, that close deleted the FRESH send —
    // leaving the machine unroutable while its daemon sat happily connected.
    const svc = makeService()
    const old = recorder()
    const fresh = recorder()

    svc.attach(MACHINE, old.send)
    svc.attach(MACHINE, fresh.send) // daemon reconnects, replacing the registration

    const detached = svc.detach(MACHINE, old.send) // the dead socket's late close

    expect(detached).toBe(false)
    expect(svc.hasDaemon(MACHINE)).toBe(true)

    // and control messages still reach the live socket rather than queueing forever
    svc.toMachine(MACHINE, keystroke)
    expect(fresh.got).toEqual([keystroke])
    expect(old.got).toEqual([])
  })

  test('the current socket’s close detaches the machine', () => {
    const svc = makeService()
    const only = recorder()

    svc.attach(MACHINE, only.send)
    const detached = svc.detach(MACHINE, only.send)

    expect(detached).toBe(true)
    expect(svc.hasDaemon(MACHINE)).toBe(false)
  })

  test('an unidentified detach still drops the socket (legacy callers)', () => {
    const svc = makeService()
    svc.attach(MACHINE, recorder().send)

    expect(svc.detach(MACHINE)).toBe(true)
    expect(svc.hasDaemon(MACHINE)).toBe(false)
  })
})
