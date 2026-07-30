import type { ControlMessage, Inventory } from '@podium/protocol'
import { describe, expect, test } from 'vitest'
import { SessionStore } from '../../store'
import type { Send } from '../sessions/session'
import { type MachinesDeps, MachinesService } from './service'

/** Only the socket bookkeeping is exercised here — none of these paths touch the store. */
function makeService(): MachinesService {
  const deps = {
    store: {} as MachinesDeps['store'],
    retargetPlaceholderSessions: () => {},
    sessionsChangedForMachine: () => {},
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

describe('MachinesService inventory persistence (#222)', () => {
  const INV: Inventory = {
    os: 'linux',
    arch: 'arm64',
    podiumVersion: '9.9.9',
    agents: [
      {
        kind: 'claude-code',
        installed: true,
        version: '2.1.0',
        login: { state: 'in', account: 'a@b.c' },
      },
      { kind: 'opencode', installed: false, login: { state: 'unknown' } },
    ],
    tools: [{ name: 'gh', installed: true, version: 'gh version 2.40.0' }],
  }

  function makeStoreService(): { svc: MachinesService; store: SessionStore } {
    const store = new SessionStore(':memory:')
    const svc = new MachinesService({
      store,
      retargetPlaceholderSessions: () => {},
      sessionsChangedForMachine: () => {},
      clients: () => [],
    } satisfies MachinesDeps)
    return { svc, store }
  }

  test('recordInventory persists the report and it survives a hello reconnect', () => {
    const { svc, store } = makeStoreService()
    store.machines.upsertMachine({ id: MACHINE, name: 'vmi', hostname: 'vmi', tokenHash: 'x' })

    svc.recordInventory(MACHINE, INV)
    expect(store.machines.getMachine(MACHINE)?.inventory).toEqual(INV)

    // A hello only restamps last_seen_at/hostname — the inventory must remain.
    store.machines.touchMachine(MACHINE, 'vmi-renamed')
    expect(store.machines.getMachine(MACHINE)?.inventory).toEqual(INV)
    expect(store.machines.getMachine(MACHINE)?.hostname).toBe('vmi-renamed')
  })

  test('explicit session placement is rejected when the harness is missing or logged out', () => {
    const { svc, store } = makeStoreService()
    store.machines.upsertMachine({ id: MACHINE, name: 'Builder', hostname: 'vmi', tokenHash: 'x' })
    svc.attach(MACHINE, recorder().send)

    svc.recordInventory(MACHINE, INV)
    expect(() => svc.resolveMachineForAgent(MACHINE, '/repo', 'codex')).toThrow(
      "codex is not installed on machine 'Builder'",
    )

    svc.recordInventory(MACHINE, {
      ...INV,
      agents: [{ kind: 'codex', installed: true, login: { state: 'out' } }],
    })
    expect(() => svc.resolveMachineForAgent(MACHINE, '/repo', 'codex')).toThrow(
      "codex is not logged in on machine 'Builder'",
    )
  })

  test('implicit placement moves to a capable machine that owns the cwd', () => {
    const { svc, store } = makeStoreService()
    const other = 'capable'
    store.machines.upsertMachine({ id: MACHINE, name: 'Missing', hostname: 'a', tokenHash: 'x' })
    store.machines.upsertMachine({ id: other, name: 'Capable', hostname: 'b', tokenHash: 'y' })
    store.repos.addRepo('/repo', MACHINE)
    store.repos.addRepo('/repo', other)
    svc.attach(MACHINE, recorder().send)
    svc.attach(other, recorder().send)
    svc.recordInventory(MACHINE, INV)
    svc.recordInventory(other, {
      ...INV,
      agents: [{ kind: 'codex', installed: true, login: { state: 'in' } }],
    })

    expect(svc.resolveMachineForAgent(undefined, '/repo/subdir', 'codex')).toBe(other)
  })
})
