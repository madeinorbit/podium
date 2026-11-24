import { asMachineId, asSessionId, asUserId } from '@podium/model'
import { asCapabilityRef, asDeviceId, type MachinePrincipal } from '@podium/protocol'
import type { ControlMessage } from '@podium/protocol/daemon'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  type MachineReconcilerPorts,
  REATTACH_PROBE_WINDOW,
  SessionMachineReconciler,
} from './machine-reconciler'
import { Session } from './session'

const machine = asMachineId('reconnect-machine')
const principal: MachinePrincipal = {
  kind: 'machine',
  machine,
  device: asDeviceId('reconnect-device'),
  capability: asCapabilityRef('reconnect-capability'),
}

afterEach(() => vi.restoreAllMocks())

function fixture(count: number) {
  const sessions = Array.from(
    { length: count },
    (_, index) =>
      new Session({
        sessionId: asSessionId(`reconnect-${index}`),
        ownerUserId: asUserId('reconnect-owner'),
        machineId: machine,
        durableLabel: `podium-reconnect-${index}`,
        agentKind: 'claude-code',
        cwd: '/project',
        title: 'Reconnect fixture',
        origin: { kind: 'spawn' },
        createdAt: '2026-11-23T00:00:00.000Z',
        lastActiveAt: `2026-11-23T00:00:0${index}.000Z`,
        geometry: { cols: 80, rows: 24 },
        status: 'exited',
        toDaemon() {},
      }),
  )
  const order: string[] = []
  let now = 0
  vi.spyOn(performance, 'now').mockImplementation(() => now)
  const ports: MachineReconcilerPorts = {
    sessions: () => sessions,
    queuedMessageCounts: async () => new Map(),
    drainInbox: async () => {},
    triggerLakeSweep: async () => {},
    resetPriorities() {},
    pushPriorities() {},
    parkArchivedSession: async () => {},
    retireArchivedSurvivor: async () => {},
    reattachMessage: async (s) => ({ type: 'reattach', sessionId: s.sessionId }) as ControlMessage,
    accessRefresh: async (s) => {
      now += 6
      order.push(`audit:${s.sessionId}`)
      return { type: 'sessionAccessRefresh', sessionId: s.sessionId } as ControlMessage
    },
    toMachine: (_machine, message) => {
      if ('sessionId' in message) order.push(`${message.type}:${message.sessionId}`)
    },
    viewTiers: () => new Map(),
    rebindHeadless() {},
    reestablishHeadless() {},
    markVolatileSessionDirty() {},
    write: async () => {},
    broadcastSessions() {},
  }
  return { sessions, order, ports, reconciler: new SessionMachineReconciler(ports) }
}

describe('time-sliced reattach probes', () => {
  it('lets timers run between complete probes, preserving view priority then recency', async () => {
    const f = fixture(5)
    f.ports.viewTiers = () =>
      new Map([
        [f.sessions[0]!.sessionId, 0],
        [f.sessions[1]!.sessionId, 1],
        [f.sessions[2]!.sessionId, 0],
      ])
    const timer = setTimeout(() => f.order.push('timer'), 0)
    try {
      await f.reconciler.onAttached(principal)
    } finally {
      clearTimeout(timer)
    }
    const probes = [2, 0, 1, 4, 3]
    const expected = probes.flatMap((index) => {
      const id = f.sessions[index]!.sessionId
      return [`audit:${id}`, `sessionAccessRefresh:${id}`, `reattach:${id}`]
    })
    expected.splice(6, 0, 'timer')
    expect(f.order).toEqual(expected)
  })

  it('rechecks session eligibility after a timer archives a pending survivor', async () => {
    const f = fixture(4)
    const last = f.sessions[0]!
    const timer = setTimeout(() => {
      last.archived = true
    }, 0)
    try {
      await f.reconciler.onAttached(principal)
    } finally {
      clearTimeout(timer)
    }
    expect(last.archived).toBe(true)
    expect(f.order).not.toContain(`sessionAccessRefresh:${last.sessionId}`)
    expect(f.order).not.toContain(`reattach:${last.sessionId}`)
    expect(f.order.filter((entry) => entry.startsWith('reattach:'))).toHaveLength(3)
  })

  it('releases every parked hold if a probe fails after yielding', async () => {
    const f = fixture(4)
    const held = new Map(f.sessions.map((s) => [s.sessionId, s]))
    f.ports.sessions = () => []
    f.ports.parkedOn = async () => f.sessions
    f.ports.acquireMany = vi.fn(async () => held)
    f.ports.withSession = async (id, _reason, fn) => await fn(held.get(id))
    f.ports.release = vi.fn()
    const error = new Error('delivery audit failed')
    const refresh = f.ports.accessRefresh!
    f.ports.accessRefresh = async (s, id) => {
      if (s === f.sessions[1]) throw error
      return await refresh(s, id)
    }
    const timer = setTimeout(() => f.order.push('timer'), 0)
    try {
      await expect(f.reconciler.onAttached(principal)).rejects.toBe(error)
    } finally {
      clearTimeout(timer)
    }
    expect(f.order).toContain('timer')
    expect(f.order.filter((entry) => entry.startsWith('reattach:'))).toHaveLength(2)
    expect(f.ports.acquireMany).toHaveBeenCalledWith(
      f.sessions.map((s) => s.sessionId).reverse(),
      'reattachProbe',
    )
    expect(f.ports.release).toHaveBeenCalledTimes(4)
    for (const id of held.keys()) expect(f.ports.release).toHaveBeenCalledWith(id)
  })

  it('restores parked survivors a window at a time, never all of them at once', async () => {
    const count = REATTACH_PROBE_WINDOW * 2 + 44
    const f = fixture(count)
    const parked = new Map(f.sessions.map((s) => [s.sessionId, s]))
    const held = new Set<string>()
    let mostHeld = 0
    const windows: number[] = []
    f.ports.sessions = () => []
    f.ports.parkedOn = async () => f.sessions
    f.ports.acquireMany = vi.fn(async (ids: readonly Session['sessionId'][]) => {
      windows.push(ids.length)
      for (const id of ids) held.add(id)
      mostHeld = Math.max(mostHeld, held.size)
      return new Map<Session['sessionId'], Session>(ids.map((id) => [id, parked.get(id)!]))
    })
    f.ports.withSession = async (id, _reason, fn) =>
      await fn(held.has(id) ? parked.get(id) : undefined)
    f.ports.release = vi.fn((id: Session['sessionId']) => {
      held.delete(id)
    })
    await f.reconciler.onAttached(principal)
    expect(windows).toEqual([REATTACH_PROBE_WINDOW, REATTACH_PROBE_WINDOW, 44])
    expect(mostHeld).toBe(REATTACH_PROBE_WINDOW)
    expect(held.size).toBe(0)
    expect(f.order.filter((entry) => entry.startsWith('reattach:'))).toHaveLength(count)
  })
})
