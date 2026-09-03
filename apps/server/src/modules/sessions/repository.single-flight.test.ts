import { asMachineId, asSessionId } from '@podium/model'
import { describe, expect, it, vi } from 'vitest'
import { SessionRepository } from './repository'
import { Session } from './session'

/**
 * THE DIRTY FLAG IS ONLY A FENCE WHILE THE PAIR IS ONE TURN (POD-3258).
 * `flushActivity` persists a session and clears `activityDirty` AFTER the
 * persist returns. Today that pair is uninterruptible, so nothing can observe
 * the window between them. Once `persist` awaits its store write, an overlapping
 * flush walks the same map, finds the same session still marked dirty, and
 * writes the row a second time — two ledger commits and two projections for one
 * counter advance.
 *
 * The probe re-enters from inside `persist`, which IS that window. One persist
 * means the overlapping flush was refused.
 *
 * The ports object follows the idiom of `repository.volatile-slice.test.ts` next
 * door: only the ports this path touches are real.
 */
describe('SessionRepository.flushActivity single-flight (POD-3258)', () => {
  const MACHINE = asMachineId('flush-machine')

  const makeSession = (index: number): Session =>
    new Session({
      sessionId: asSessionId(`flush-${index}`),
      durableLabel: `podium-flush-${index}`,
      agentKind: 'claude-code',
      cwd: `/work/${index}`,
      title: `title-${index}`,
      origin: { kind: 'spawn' },
      createdAt: '2026-08-18T00:00:00.000Z',
      geometry: { cols: 80, rows: 24 },
      machineId: MACHINE,
      toDaemon: vi.fn(),
    })

  function fixture(count: number) {
    const rows = Array.from({ length: count }, (_, index) => makeSession(index))
    const sessions = new Map(rows.map((session) => [session.sessionId, session]))
    const upserted: string[] = []
    const repo = new SessionRepository({
      sessions,
      store: { sessions: { upsertSession: (row: { id: string }) => upserted.push(row.id) } },
      ledger: {
        commit: ({ write }: { write: () => void }) => {
          write()
          return { changes: [] }
        },
        capture: () => [],
      },
      view: { wire: (session: Session) => ({ sessionId: session.sessionId }) },
      now: () => Date.now(),
      broadcastSessions: vi.fn(),
      flushBroadcasts: vi.fn(),
      runScheduledBroadcast: vi.fn(),
      listSessions: vi.fn(() => []),
    } as never)
    return { repo, rows, upserted }
  }

  it('skips a flush that lands on a flush already running', () => {
    const { repo, rows, upserted } = fixture(1)
    rows[0]!.terminal.recordResumeActivity()
    expect(rows[0]!.terminal.activityDirty).toBe(true)

    let reentered = false
    const original = repo.persist.bind(repo)
    const spy = vi.spyOn(repo, 'persist').mockImplementation((session, extra) => {
      if (!reentered) {
        reentered = true
        // Re-enter in the window between the write and `clearActivityDirty`.
        repo.flushActivity()
      }
      return original(session, extra)
    })

    repo.flushActivity()

    expect(reentered).toBe(true)
    expect(spy).toHaveBeenCalledTimes(1)
    expect(upserted).toEqual(['flush-0'])
    spy.mockRestore()
  })

  it('a later flush persists a session that went dirty again', () => {
    const { repo, rows, upserted } = fixture(1)
    rows[0]!.terminal.recordResumeActivity()
    repo.flushActivity()
    expect(upserted).toEqual(['flush-0'])

    // Clean now — a flush must not write it again.
    repo.flushActivity()
    expect(upserted).toEqual(['flush-0'])

    rows[0]!.terminal.recordResumeActivity()
    repo.flushActivity()
    expect(upserted).toEqual(['flush-0', 'flush-0'])
  })

  it('releases the fence when a persist throws', () => {
    const { repo, rows } = fixture(1)
    rows[0]!.terminal.recordResumeActivity()

    let calls = 0
    const spy = vi.spyOn(repo, 'persist').mockImplementation(() => {
      calls += 1
      throw new Error('ledger is gone')
    })

    expect(() => repo.flushActivity()).toThrow('ledger is gone')
    expect(() => repo.flushActivity()).toThrow('ledger is gone')
    expect(calls).toBe(2)
    spy.mockRestore()
  })
})
