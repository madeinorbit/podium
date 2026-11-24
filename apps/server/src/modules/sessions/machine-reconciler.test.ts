import { asCredentialId, asMachineId, asSessionId, asUserId } from '@podium/model'
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
const CREDENTIAL = asCredentialId('cred_00000000-0000-4000-8000-000000007591')
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
    // A daemon binds a driver for every profiled agent; the row keeps it.
    else session.boundDriverId = 'generic-pty'
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
  const sent = (order: string[]) => order.filter((entry) => !entry.startsWith('reattach:'))

  it('probes without a refresh, then sends the audited refresh when the daemon binds', async () => {
    const f = fixture(3, 'exited')
    await f.reconciler.onAttached(principal)
    expect(f.order).toEqual([2, 1, 0].map((index) => `reattach:${f.sessions[index]!.sessionId}`))
    const bound = f.sessions[1]!
    await f.reconciler.onBound(bound, machine, 'exited')
    expect(f.order.slice(3)).toEqual([
      `audit:${bound.sessionId}`,
      `sessionAccessRefresh:${bound.sessionId}`,
    ])
    // Owed once: a second bind of the same session sends nothing more.
    await f.reconciler.onBound(bound, machine, 'exited')
    expect(f.order).toHaveLength(5)
  })

  // Review F1: reattachFailed names no attempt, so it must not cancel the debt.
  it('keeps the debt across a reattachFailed, and still sends it at the bind', async () => {
    const f = fixture(1, 'exited')
    const session = f.sessions[0]!
    await f.reconciler.onAttached(principal)
    // There is no reattachFailed hook any more: whatever the daemon answered to
    // another reattach first, the probe's own bind still finds the debt.
    await f.reconciler.onBound(session, machine, 'exited')
    expect(sent(f.order)).toEqual([
      `audit:${session.sessionId}`,
      `sessionAccessRefresh:${session.sessionId}`,
    ])
  })

  it('keeps the debt when the refresh throws, and the bind call itself does not throw', async () => {
    const f = fixture(1, 'exited')
    const session = f.sessions[0]!
    await f.reconciler.onAttached(principal)
    const refresh = f.ports.accessRefresh!
    f.ports.accessRefresh = async () => {
      throw new Error('vault unavailable')
    }
    await expect(f.reconciler.onBound(session, machine, 'exited')).resolves.toBeUndefined()
    expect(sent(f.order)).toEqual([])
    // A failed send keeps the debt too.
    f.ports.accessRefresh = refresh
    const toMachine = f.ports.toMachine
    f.ports.toMachine = (id, message) => {
      if (message.type === 'sessionAccessRefresh') throw new Error('link down')
      return toMachine(id, message)
    }
    await expect(f.reconciler.onBound(session, machine, 'exited')).resolves.toBeUndefined()
    f.ports.toMachine = toMachine
    await f.reconciler.onBound(session, machine, 'exited')
    expect(sent(f.order)).toEqual([
      `audit:${session.sessionId}`,
      `audit:${session.sessionId}`,
      `sessionAccessRefresh:${session.sessionId}`,
    ])
  })

  it('owes nothing to a launch bind, a bind from another machine, after a detach or the next attach', async () => {
    const f = fixture(3, 'exited')
    await f.reconciler.onAttached(principal)
    const [launched, foreign, detached] = f.sessions as [Session, Session, Session]
    // A spawn, resume or census revive took the row out of exited and sent its
    // own credential: its bind drops the debt (review F6).
    await f.reconciler.onBound(launched, machine, 'starting')
    await f.reconciler.onBound(launched, machine, 'exited')
    await f.reconciler.onBound(foreign, other, 'exited')
    expect(sent(f.order)).toEqual([])
    // The debt on this machine still stands after the foreign bind.
    await f.reconciler.onBound(foreign, machine, 'exited')
    expect(sent(f.order)).toEqual([
      `audit:${foreign.sessionId}`,
      `sessionAccessRefresh:${foreign.sessionId}`,
    ])
    f.reconciler.onDetached(principal)
    await f.reconciler.onBound(detached, machine, 'exited')
    expect(sent(f.order)).toHaveLength(2)

    const again = fixture(1, 'exited')
    await again.reconciler.onAttached(principal)
    await again.reconciler.onAttached(principal)
    expect(again.order).toEqual([
      `reattach:${again.sessions[0]!.sessionId}`,
      `reattach:${again.sessions[0]!.sessionId}`,
    ])
    again.order.length = 0
    await again.reconciler.onBound(again.sessions[0]!, machine, 'exited')
    expect(again.order).toEqual([
      `audit:${again.sessions[0]!.sessionId}`,
      `sessionAccessRefresh:${again.sessions[0]!.sessionId}`,
    ])
  })

  it('resolves the credential at the bind, so a grant that ended meanwhile is refused', async () => {
    const f = fixture(1, 'exited')
    const session = f.sessions[0]!
    await f.reconciler.onAttached(principal)
    const refusedFor: string[] = []
    f.ports.accessRefused = async (s, refused) => {
      refusedFor.push(`${s.sessionId}:${refused.refused}`)
    }
    f.ports.accessRefresh = async (s) => {
      f.order.push(`refused:${s.sessionId}`)
      return { refused: 'not-yours', credentialId: null }
    }
    await f.reconciler.onBound(session, machine, 'exited')
    expect(f.order).toEqual([`reattach:${session.sessionId}`, `refused:${session.sessionId}`])
    // POD-7591: the bound process is handed on to be stopped.
    expect(refusedFor).toEqual([`${session.sessionId}:not-yours`])
    // Review N2: one refusal ends the debt; a later bind resolves nothing again.
    await f.reconciler.onBound(session, machine, 'exited')
    expect(f.order).toHaveLength(2)
    expect(refusedFor).toHaveLength(1)
  })

  // Review N1: two binds of a still-exited row can arrive together.
  it('sends an owed refresh once when two binds arrive together', async () => {
    const f = fixture(1, 'exited')
    const session = f.sessions[0]!
    await f.reconciler.onAttached(principal)
    const refresh = f.ports.accessRefresh!
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    f.ports.accessRefresh = async (s, id) => {
      await gate
      return await refresh(s, id)
    }
    const first = f.reconciler.onBound(session, machine, 'exited')
    const second = f.reconciler.onBound(session, machine, 'exited')
    release()
    await Promise.all([first, second])
    expect(sent(f.order)).toEqual([
      `audit:${session.sessionId}`,
      `sessionAccessRefresh:${session.sessionId}`,
    ])
    // A failed attempt still frees the marker: the debt can be paid by the next bind.
    const again = fixture(1, 'exited')
    await again.reconciler.onAttached(principal)
    const ok = again.ports.accessRefresh!
    again.ports.accessRefresh = async () => {
      throw new Error('vault unavailable')
    }
    await again.reconciler.onBound(again.sessions[0]!, machine, 'exited')
    again.ports.accessRefresh = ok
    await again.reconciler.onBound(again.sessions[0]!, machine, 'exited')
    expect(sent(again.order)).toEqual([
      `audit:${again.sessions[0]!.sessionId}`,
      `sessionAccessRefresh:${again.sessions[0]!.sessionId}`,
    ])
  })

  // Review F3: the owed refresh is judged after the row went live.
  it('holds input while the owed refresh is judged, and releases it after', async () => {
    const f = fixture(1, 'exited')
    const session = f.sessions[0]!
    session.credentialId = CREDENTIAL
    await f.reconciler.onAttached(principal)
    f.ports.holdWhileJudged = (s) => f.order.push(`hold:${s.sessionId}`)
    f.ports.releaseRefusalHold = (sessionId, credentialId) =>
      f.order.push(`release:${sessionId}:${credentialId}`)
    await f.reconciler.onBound(session, machine, 'exited')
    expect(sent(f.order)).toEqual([
      `hold:${session.sessionId}`,
      `audit:${session.sessionId}`,
      `sessionAccessRefresh:${session.sessionId}`,
      `release:${session.sessionId}:${CREDENTIAL}`,
    ])
  })

  it('a refusal hand-off that throws does not break the bind', async () => {
    const f = fixture(1, 'exited')
    await f.reconciler.onAttached(principal)
    f.ports.accessRefresh = async () => ({ refused: 'revoked', credentialId: null })
    f.ports.accessRefused = async () => {
      throw new Error('interaction store down')
    }
    await expect(f.reconciler.onBound(f.sessions[0]!, machine, 'exited')).resolves.toBeUndefined()
  })

  // Review F2: only a proven PTY defers; everything else keeps its refresh first.
  it('keeps the refresh before the reattach for an exited row not proven a PTY', async () => {
    const f = fixture(6, 'exited')
    const [server, codexKind, embedded, unknown, shell, pty] = f.sessions as [
      Session,
      Session,
      Session,
      Session,
      Session,
      Session,
    ]
    // A spawning adopt waits for the credential: it must arrive first.
    server.boundDriverId = 'codex-app-server'
    codexKind.boundDriverId = undefined
    codexKind.resume = { kind: 'codex-thread', value: 'thread-1' }
    // An embedded engine bound before the driver column: no driver, a resume
    // kind whose harness declares no server driver.
    embedded.boundDriverId = undefined
    embedded.resume = { kind: 'claude-session', value: 'conversation-1' }
    // A daemon that named no driver, and nothing else to go on.
    unknown.boundDriverId = undefined
    // A shell runs no harness engine.
    const shellSession = new Session({
      sessionId: shell.sessionId,
      ownerUserId: asUserId('reconnect-owner'),
      machineId: machine,
      durableLabel: shell.durableLabel,
      agentKind: 'shell',
      cwd: '/project',
      title: 'Reconnect fixture',
      origin: { kind: 'spawn' },
      createdAt: '2026-11-23T00:00:00.000Z',
      lastActiveAt: shell.lastActiveAt,
      geometry: { cols: 80, rows: 24 },
      status: 'exited',
      toDaemon() {},
    })
    f.sessions[4] = shellSession
    // A bound terminal driver proves the PTY even with a server-family resume kind.
    pty.resume = { kind: 'codex-thread', value: 'thread-2' }
    await f.reconciler.onAttached(principal)
    const refreshedFirst = (s: Session) => [
      `audit:${s.sessionId}`,
      `sessionAccessRefresh:${s.sessionId}`,
      `reattach:${s.sessionId}`,
    ]
    expect(f.order).toEqual([
      `reattach:${pty.sessionId}`,
      `reattach:${shellSession.sessionId}`,
      ...refreshedFirst(unknown),
      ...refreshedFirst(embedded),
      ...refreshedFirst(codexKind),
      ...refreshedFirst(server),
    ])
    // Their refresh is already delivered: a bind owes nothing more.
    await f.reconciler.onBound(server, machine, 'exited')
    await f.reconciler.onBound(embedded, machine, 'exited')
    expect(f.order).toHaveLength(14)
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

  // Review F5: one bad row fails alone; the machine's other probes go out.
  it('skips a session the chunk built no message for, and sends the rest', async () => {
    const f = chunked(3, 'exited')
    const failed = f.sessions[1]!
    const built = f.ports.reattachMessages!
    f.ports.reattachMessages = async (sessions, machineId) => {
      const messages = new Map(await built(sessions, machineId))
      messages.delete(failed.sessionId)
      return messages
    }
    await f.reconciler.onAttached(principal)
    expect(f.order.filter((entry) => entry.startsWith('reattach:'))).toEqual([
      `reattach:${f.sessions[2]!.sessionId}`,
      `reattach:${f.sessions[0]!.sessionId}`,
    ])
    expect(f.ports.reattachMessage).not.toHaveBeenCalled()
  })

  it('builds a chunk one message at a time when building it together throws', async () => {
    const f = chunked(3, 'exited')
    f.ports.reattachMessages = async () => {
      throw new Error('fence transaction failed')
    }
    await f.reconciler.onAttached(principal)
    expect(f.order.filter((entry) => entry.startsWith('reattach:'))).toHaveLength(3)
    expect(f.ports.reattachMessage).toHaveBeenCalledTimes(3)
  })
})

// POD-7591: a survivor whose refresh is refused still has its reattach sent, so
// the daemon binds what survives; the refusal is handed on at that bind.
describe('a refused refresh for a process that may still run', () => {
  function refusing(count: number) {
    const f = fixture(count)
    const handed: string[] = []
    const held: string[] = []
    f.ports.accessRefresh = async (s) => {
      f.order.push(`refused:${s.sessionId}`)
      return { refused: 'machine-not-allowed', credentialId: CREDENTIAL }
    }
    f.ports.accessRefused = async (s, refused) => {
      handed.push(`${s.sessionId}:${refused.refused}`)
    }
    // Review F3: held from the probe, before any reattach goes out.
    f.ports.holdOnRefusal = (s) => {
      held.push(`hold:${s.sessionId}`)
      f.order.push(`hold:${s.sessionId}`)
    }
    f.ports.releaseRefusalHold = (sessionId) => {
      held.push(`release:${sessionId}`)
    }
    return { ...f, handed, held }
  }

  it('sends the reattach without a credential and hands the refusal on at the bind', async () => {
    const f = refusing(1)
    const survivor = f.sessions[0]!
    await f.reconciler.onAttached(principal)
    expect(f.order).toEqual([
      `refused:${survivor.sessionId}`,
      `hold:${survivor.sessionId}`,
      `reattach:${survivor.sessionId}`,
    ])
    expect(f.handed).toEqual([])
    await f.reconciler.onBound(survivor, machine, 'live')
    expect(f.handed).toEqual([`${survivor.sessionId}:machine-not-allowed`])
    // Once: the next bind hands nothing on and resolves nothing.
    await f.reconciler.onBound(survivor, machine, 'live')
    expect(f.handed).toHaveLength(1)
    expect(f.order).toHaveLength(3)
  })

  it('drops the refusal for a launch bind, another machine, and after a detach', async () => {
    const f = refusing(3)
    await f.reconciler.onAttached(principal)
    const [launched, foreign, detached] = f.sessions as [Session, Session, Session]
    // The row was taken out of its probed status by a launch, which judged its own credential.
    await f.reconciler.onBound(launched, machine, 'starting')
    await f.reconciler.onBound(launched, machine, 'live')
    await f.reconciler.onBound(foreign, asMachineId('reconnect-other-machine'), 'live')
    f.reconciler.onDetached(principal)
    await f.reconciler.onBound(detached, machine, 'live')
    expect(f.handed).toEqual([])
    // Every hold the probe set is released again: the launch bind, and the detach
    // for the other two (the foreign bind leaves its entry to the detach).
    expect(f.held.filter((entry) => entry.startsWith('release:')).sort()).toEqual(
      [launched, foreign, detached].map((s) => `release:${s.sessionId}`).sort(),
    )
  })

  it('hands on a refusal from the census revive at the revived process bind', async () => {
    const f = refusing(1)
    const parked = f.sessions[0]!
    parked.status = 'exited'
    parked.awaitingRebind = false
    parked.boundDriverId = 'generic-pty'
    f.ports.write = async (s, mutate) => {
      mutate(s as never)
    }
    await f.reconciler.reviveParkedButAlive(parked, machine, 'census', { measuredPtyHost: true })
    expect(f.order).toEqual([
      `refused:${parked.sessionId}`,
      `hold:${parked.sessionId}`,
      `reattach:${parked.sessionId}`,
    ])
    await f.reconciler.onBound(parked, machine, 'live')
    expect(f.handed).toEqual([`${parked.sessionId}:machine-not-allowed`])
  })
})
