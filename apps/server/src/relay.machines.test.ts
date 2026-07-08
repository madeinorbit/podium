import type { ControlMessage } from '@podium/protocol'
import { describe, expect, it } from 'vitest'
import { SessionRegistry } from './relay'
import { SessionStore } from './store'

function regWithTwoDaemons() {
  const store = new SessionStore(':memory:')
  store.machines.upsertMachine({ id: 'm1', name: 'one', hostname: 'one', tokenHash: 'x' })
  store.machines.upsertMachine({ id: 'm2', name: 'two', hostname: 'two', tokenHash: 'y' })
  const reg = new SessionRegistry(store)
  const m1: ControlMessage[] = []
  const m2: ControlMessage[] = []
  reg.modules.sessions.attachDaemon('m1', (msg) => m1.push(msg))
  reg.modules.sessions.attachDaemon('m2', (msg) => m2.push(msg))
  return { reg, m1, m2 }
}

describe('multi-daemon routing', () => {
  it('routes a spawn to the chosen machine only', () => {
    const { reg, m1, m2 } = regWithTwoDaemons()
    reg.modules.sessions.createSession({ agentKind: 'shell', cwd: '/x', machineId: 'm2' })
    expect(m1.filter((m) => m.type === 'spawn')).toHaveLength(0)
    expect(m2.filter((m) => m.type === 'spawn')).toHaveLength(1)
  })

  it('a session carries its machineId in meta', () => {
    const { reg } = regWithTwoDaemons()
    const { sessionId } = reg.modules.sessions.createSession({ agentKind: 'shell', cwd: '/x', machineId: 'm2' })
    const meta = reg.modules.sessions.listSessions().find((s) => s.sessionId === sessionId)
    expect(meta).toBeDefined()
    expect(meta?.machineId).toBe('m2')
    expect(meta?.machineName).toBe('two')
  })

  it('detaching m1 only marks m1 sessions reconnecting', () => {
    const { reg } = regWithTwoDaemons()
    const a = reg.modules.sessions.createSession({ agentKind: 'shell', cwd: '/a', machineId: 'm1' }).sessionId
    const b = reg.modules.sessions.createSession({ agentKind: 'shell', cwd: '/b', machineId: 'm2' }).sessionId
    // mark both live as a bind would
    reg.modules.sessions.onDaemonMessageFrom('m1', {
      type: 'bind',
      sessionId: a,
      cmd: 'x',
      cwd: '/a',
      agentKind: 'shell',
      geometry: { cols: 80, rows: 24 },
    })
    reg.modules.sessions.onDaemonMessageFrom('m2', {
      type: 'bind',
      sessionId: b,
      cmd: 'x',
      cwd: '/b',
      agentKind: 'shell',
      geometry: { cols: 80, rows: 24 },
    })
    reg.modules.sessions.detachDaemon('m1')
    const meta = (id: string) => reg.modules.sessions.listSessions().find((s) => s.sessionId === id)
    expect(meta(a)?.status).toBe('reconnecting')
    expect(meta(b)?.status).toBe('live')
  })

  it('lists machines with their online status from the registry', () => {
    const { reg } = regWithTwoDaemons()
    const machines = reg.modules.machines.listMachines()
    expect(machines.find((m) => m.id === 'm1')?.online).toBe(true)
    expect(machines.find((m) => m.id === 'm2')?.online).toBe(true)
    reg.modules.sessions.detachDaemon('m1')
    const after = reg.modules.machines.listMachines()
    expect(after.find((m) => m.id === 'm1')?.online).toBe(false)
    expect(after.find((m) => m.id === 'm2')?.online).toBe(true)
  })

  it('routes an unresolved spawn (no machineId, unregistered cwd) to an online machine, not __local__', () => {
    const { reg, m1, m2 } = regWithTwoDaemons()
    // No machineId provided, cwd matches no registered repo — must NOT dead-queue under __local__.
    reg.modules.sessions.createSession({ agentKind: 'shell', cwd: '/no/repo/here' })
    const spawns = [...m1, ...m2].filter((m) => m.type === 'spawn')
    // The spawn must have reached one of the online daemons, not vanished into __local__.
    expect(spawns).toHaveLength(1)
    // Confirm the session's machineId is one of the two online machines.
    const sessions = reg.modules.sessions.listSessions()
    expect(sessions).toHaveLength(1)
    expect(['m1', 'm2']).toContain(sessions[0]?.machineId)
  })

  it('host metrics are scoped per machine', () => {
    const { reg } = regWithTwoDaemons()
    const sent: import('@podium/protocol').ServerMessage[] = []
    reg.modules.sessions.attachClient((m) => sent.push(m))
    reg.modules.sessions.onDaemonMessageFrom('m1', {
      type: 'hostMetrics',
      hostname: 'one',
      sampledAt: '2026-06-11T00:00:00.000Z',
      memory: { totalBytes: 32, availableBytes: 16, swapTotalBytes: 0, swapFreeBytes: 0 },
    })
    reg.modules.sessions.onDaemonMessageFrom('m2', {
      type: 'hostMetrics',
      hostname: 'two',
      sampledAt: '2026-06-11T00:00:00.000Z',
      memory: { totalBytes: 32, availableBytes: 8, swapTotalBytes: 0, swapFreeBytes: 0 },
    })
    const last = sent
      .filter(
        (
          m,
        ): m is Extract<import('@podium/protocol').ServerMessage, { type: 'hostMetricsChanged' }> =>
          m.type === 'hostMetricsChanged',
      )
      .at(-1)
    const ids = last?.hosts.map((h) => h.machineId).sort()
    expect(ids).toEqual(['m1', 'm2'])
    // detaching m1 drops only its sample
    reg.modules.sessions.detachDaemon('m1')
    const afterDetach = sent
      .filter(
        (
          m,
        ): m is Extract<import('@podium/protocol').ServerMessage, { type: 'hostMetricsChanged' }> =>
          m.type === 'hostMetricsChanged',
      )
      .at(-1)
    expect(afterDetach?.hosts.map((h) => h.machineId)).toEqual(['m2'])
  })
})
