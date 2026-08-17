import { asMachineId, asSessionId } from '@podium/model'
import type { EntityChangeSpec } from '@podium/sync'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SessionRepository } from './repository'
import { Session } from './session'

const MACHINE = asMachineId('slice-machine')

function makeSession(index: number): Session {
  return new Session({
    sessionId: asSessionId(`slice-${index}`),
    durableLabel: `podium-slice-${index}`,
    agentKind: 'claude-code',
    cwd: `/work/${index}`,
    title: `title-${index}`,
    origin: { kind: 'spawn' },
    createdAt: '2026-08-18T00:00:00.000Z',
    geometry: { cols: 80, rows: 24 },
    machineId: MACHINE,
    toDaemon: vi.fn(),
  })
}

function fixture(count: number) {
  const rows = Array.from({ length: count }, (_, index) => makeSession(index))
  const sessions = new Map(rows.map((session) => [session.sessionId, session]))
  let seq = 0
  const capture = vi.fn((specs: EntityChangeSpec[]) =>
    specs.map((spec) => ({
      seq: ++seq,
      entity: spec.entity,
      entityId: spec.id,
      op: spec.op,
      ...('value' in spec ? { value: spec.value } : {}),
    })),
  )
  const wire = vi.fn((session: Session) => ({
    sessionId: session.sessionId,
    title: session.title,
  }))
  const runScheduledBroadcast = vi.fn()
  const repo = new SessionRepository({
    sessions,
    ledger: { capture },
    view: { wire },
    now: () => Date.now(),
    runScheduledBroadcast,
    broadcastSessions: vi.fn(),
    flushBroadcasts: vi.fn(),
    listSessions: vi.fn(() => []),
  } as never)
  return { repo, rows, sessions, capture, wire, runScheduledBroadcast }
}

afterEach(() => {
  vi.useRealTimers()
})

describe('SessionRepository volatile capture slices [POD-2322]', () => {
  it('drains at most 32 candidates and reports deterministic progress', () => {
    vi.useFakeTimers()
    const { repo, rows, wire } = fixture(40)
    for (const row of rows) repo.markVolatileSessionDirty(row.sessionId)

    const first = repo.drainVolatileCaptureSlice()
    expect(first.changes).toHaveLength(32)
    expect(first.remaining).toBe(8)
    expect(wire).toHaveBeenCalledTimes(32)

    const second = repo.drainVolatileCaptureSlice()
    expect(second.changes).toHaveLength(8)
    expect(second.remaining).toBe(0)
    expect(wire).toHaveBeenCalledTimes(40)
  })

  it('stops on the CPU budget only between complete candidates', () => {
    vi.useFakeTimers()
    const { repo, rows, wire } = fixture(5)
    for (const row of rows) repo.markVolatileSessionDirty(row.sessionId)
    const ticks = [0, 5, 10]

    const result = repo.drainVolatileCaptureSlice({
      maxItems: 32,
      maxCpuMs: 8,
      now: () => ticks.shift() ?? 10,
    })

    expect(wire).toHaveBeenCalledTimes(2)
    expect(result.remaining).toBe(3)
  })

  it('keeps a same-slice mutation pending and captures its newest value next', () => {
    vi.useFakeTimers()
    const { repo, rows, wire } = fixture(1)
    const row = rows[0]!
    let mutateDuringWire = true
    wire.mockImplementation((session: Session) => {
      const projected = { sessionId: session.sessionId, title: session.title }
      if (mutateDuringWire) {
        mutateDuringWire = false
        session.title = 'newest'
        repo.markVolatileSessionDirty(session.sessionId)
      }
      return projected
    })
    repo.markVolatileSessionDirty(row.sessionId)

    expect(repo.drainVolatileCaptureSlice().remaining).toBe(1)
    expect(repo.drainVolatileCaptureSlice().remaining).toBe(0)
    expect(wire.mock.results.map((result) => result.value.title)).toEqual(['title-0', 'newest'])
  })

  it('keeps a failed slice pending and schedules the existing retry', () => {
    vi.useFakeTimers()
    const { repo, rows, capture, runScheduledBroadcast } = fixture(2)
    for (const row of rows) repo.markVolatileSessionDirty(row.sessionId)
    // Enter the state the production timer has just before it drains: the
    // initial zero-delay handle is cleared, so a failure can arm the retry.
    vi.advanceTimersByTime(0)
    runScheduledBroadcast.mockClear()
    capture.mockImplementationOnce(() => {
      throw new Error('ledger unavailable')
    })

    expect(() => repo.drainVolatileCaptureSlice()).toThrow('ledger unavailable')
    expect(repo.hasPendingVolatile()).toBe(true)
    vi.advanceTimersByTime(999)
    expect(runScheduledBroadcast).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(runScheduledBroadcast).toHaveBeenCalledTimes(1)
  })

  it('the synchronous barrier drains the complete backlog', () => {
    vi.useFakeTimers()
    const { repo, rows, wire } = fixture(100)
    for (const row of rows) repo.markVolatileSessionDirty(row.sessionId)

    const changes = repo.flushVolatileSessionCaptures()

    expect(changes).toHaveLength(100)
    expect(wire).toHaveBeenCalledTimes(100)
    expect(repo.hasPendingVolatile()).toBe(false)
  })
})
