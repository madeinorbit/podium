import { asMachineId, asSessionId, asUserId } from '@podium/model'
import { asCapabilityRef, asDeviceId, type MachinePrincipal } from '@podium/protocol'
import type { ControlMessage } from '@podium/protocol/daemon'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  type MachineReconcilerPorts,
  REATTACH_MESSAGE_CHUNK,
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

/**
 * `count` sessions on one machine. Survivors (the default) still run and await
 * their rebind, so each probe carries an audited refresh first; exited ones
 * probe without it (POD-7574).
 */
function fixture(count: number, status: 'survivor' | 'exited' = 'survivor') {
  const sessions = Array.from({ length: count }, (_, index) => {
    const session = new Session({
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
      status: status === 'exited' ? 'exited' : 'live',
      toDaemon() {},
    })
    if (status === 'survivor') session.markAwaitingRebind()
    return session
  })
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
    const f = fixture(count, 'exited')
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

// POD-7574: an exited row's probe is a passive PTY reattach that almost always
// answers reattachFailed, so its credential waits for the bind that proves it.
describe("an exited session's credential on reattach", () => {
  const other = asMachineId('reconnect-other-machine')

  it('probes without a refresh, then sends the audited refresh when the daemon binds', async () => {
    const f = fixture(3, 'exited')
    await f.reconciler.onAttached(principal)
    expect(f.order).toEqual([2, 1, 0].map((index) => `reattach:${f.sessions[index]!.sessionId}`))
    const bound = f.sessions[1]!
    await f.reconciler.onBound(bound, machine)
    expect(f.order.slice(3)).toEqual([
      `audit:${bound.sessionId}`,
      `sessionAccessRefresh:${bound.sessionId}`,
    ])
    // Owed once: a second bind of the same session sends nothing more.
    await f.reconciler.onBound(bound, machine)
    expect(f.order).toHaveLength(5)
  })

  it('owes nothing after reattachFailed, a detach, the next attach, or a bind from another machine', async () => {
    const f = fixture(4, 'exited')
    await f.reconciler.onAttached(principal)
    const [failed, foreign, detached, unrelated] = f.sessions as [
      Session,
      Session,
      Session,
      Session,
    ]
    f.reconciler.onReattachFailed(failed.sessionId, machine)
    await f.reconciler.onBound(failed, machine)
    await f.reconciler.onBound(foreign, other)
    // A reattachFailed from another machine leaves this machine's debt standing.
    f.reconciler.onReattachFailed(unrelated.sessionId, other)
    expect(f.order.filter((entry) => !entry.startsWith('reattach:'))).toEqual([])
    await f.reconciler.onBound(unrelated, machine)
    expect(f.order.filter((entry) => !entry.startsWith('reattach:'))).toEqual([
      `audit:${unrelated.sessionId}`,
      `sessionAccessRefresh:${unrelated.sessionId}`,
    ])
    f.reconciler.onDetached(principal)
    await f.reconciler.onBound(detached, machine)
    expect(f.order.filter((entry) => entry.startsWith('audit:'))).toHaveLength(1)

    const again = fixture(1, 'exited')
    await again.reconciler.onAttached(principal)
    await again.reconciler.onAttached(principal)
    expect(again.order).toEqual([
      `reattach:${again.sessions[0]!.sessionId}`,
      `reattach:${again.sessions[0]!.sessionId}`,
    ])
    again.order.length = 0
    await again.reconciler.onBound(again.sessions[0]!, machine)
    expect(again.order).toEqual([
      `audit:${again.sessions[0]!.sessionId}`,
      `sessionAccessRefresh:${again.sessions[0]!.sessionId}`,
    ])
  })

  it('resolves the credential at the bind, so a grant that ended meanwhile is refused', async () => {
    const f = fixture(1, 'exited')
    await f.reconciler.onAttached(principal)
    f.ports.accessRefresh = async (s) => {
      f.order.push(`refused:${s.sessionId}`)
      return undefined
    }
    await f.reconciler.onBound(f.sessions[0]!, machine)
    expect(f.order).toEqual([
      `reattach:${f.sessions[0]!.sessionId}`,
      `refused:${f.sessions[0]!.sessionId}`,
    ])
  })

  it('keeps the refresh before the reattach for an exited row that may be server-driven', async () => {
    const f = fixture(3, 'exited')
    const [server, codexKind, pty] = f.sessions as [Session, Session, Session]
    // A spawning adopt waits for the credential: it must arrive first.
    server.boundDriverId = 'codex-app-server'
    codexKind.resume = { kind: 'codex-thread', value: 'thread-1' }
    // A bound terminal driver proves the PTY even with a server-family resume kind.
    pty.boundDriverId = 'generic-pty'
    pty.resume = { kind: 'codex-thread', value: 'thread-2' }
    await f.reconciler.onAttached(principal)
    expect(f.order).toEqual([
      `reattach:${pty.sessionId}`,
      `audit:${codexKind.sessionId}`,
      `sessionAccessRefresh:${codexKind.sessionId}`,
      `reattach:${codexKind.sessionId}`,
      `audit:${server.sessionId}`,
      `sessionAccessRefresh:${server.sessionId}`,
      `reattach:${server.sessionId}`,
    ])
    // Their refresh is already delivered: a bind owes nothing more.
    await f.reconciler.onBound(server, machine)
    expect(f.order).toHaveLength(7)
  })
})

// POD-7574: a chunk's reattach messages are built together (one fence
// transaction, one ownership read), and each probe still goes out on its own.
describe('reattach messages built a chunk at a time', () => {
  function chunked(count: number, status: 'survivor' | 'exited') {
    const f = fixture(count, status)
    const chunks: string[][] = []
    f.ports.reattachMessages = async (sessions) => {
      chunks.push(sessions.map((s) => s.sessionId))
      f.order.push(`built:${sessions.length}`)
      return new Map(
        sessions.map((s) => [
          s.sessionId,
          { type: 'reattach', sessionId: s.sessionId } as ControlMessage,
        ]),
      )
    }
    f.ports.reattachMessage = vi.fn(f.ports.reattachMessage)
    return { ...f, chunks }
  }

  it('builds each chunk once, in probe order, and sends every probe from it', async () => {
    const count = REATTACH_MESSAGE_CHUNK * 2 + 3
    const f = chunked(count, 'exited')
    await f.reconciler.onAttached(principal)
    expect(f.chunks.map((chunk) => chunk.length)).toEqual([
      REATTACH_MESSAGE_CHUNK,
      REATTACH_MESSAGE_CHUNK,
      3,
    ])
    const probeOrder = f.order.filter((entry) => entry.startsWith('reattach:'))
    expect(probeOrder).toEqual(f.chunks.flat().map((id) => `reattach:${id}`))
    expect(f.order[0]).toBe(`built:${REATTACH_MESSAGE_CHUNK}`)
    expect(f.ports.reattachMessage).not.toHaveBeenCalled()
  })

  it('keeps each survivor audited refresh before its own reattach', async () => {
    const f = chunked(3, 'survivor')
    await f.reconciler.onAttached(principal)
    expect(f.order).toEqual([
      'built:3',
      ...[2, 1, 0].flatMap((index) => {
        const id = f.sessions[index]!.sessionId
        return [`audit:${id}`, `sessionAccessRefresh:${id}`, `reattach:${id}`]
      }),
    ])
  })

  it('builds nothing for a session that no longer qualifies, and still checks at the send', async () => {
    const f = chunked(3, 'exited')
    f.sessions[1]!.archived = true
    const late = f.sessions[0]!
    const built = f.ports.reattachMessages!
    f.ports.reattachMessages = async (sessions, machineId) => {
      const messages = await built(sessions, machineId)
      // Archived after its message was built: the probe is not sent.
      late.archived = true
      return messages
    }
    await f.reconciler.onAttached(principal)
    expect(f.chunks).toEqual([[f.sessions[2]!.sessionId, late.sessionId]])
    expect(f.order.filter((entry) => entry.startsWith('reattach:'))).toEqual([
      `reattach:${f.sessions[2]!.sessionId}`,
    ])
  })
})
