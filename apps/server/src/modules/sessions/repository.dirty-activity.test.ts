import { asMachineId, asSessionId, firstAdminMemberId } from '@podium/model'
import type { SessionRow } from '../../store'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SessionRepository } from './repository'
import { Session } from './session'
import { disposeOracles, makeOracle } from './oracle-support'

const makeSession = (index: number) => new Session({
  ownerUserId: firstAdminMemberId(),
  sessionId: asSessionId(`dirty-${index}`),
  durableLabel: `dirty-${index}`,
  agentKind: 'claude-code',
  cwd: '/work',
  title: `session ${index}`,
  origin: { kind: 'spawn' },
  createdAt: '2026-10-08T00:00:00.000Z',
  geometry: { cols: 80, rows: 24 },
  machineId: asMachineId('dirty-machine'),
  toDaemon: vi.fn(),
})

function fixture(count: number) {
  const rows = Array.from({ length: count }, (_, i) => makeSession(i))
  const sessions = new Map(rows.map((s) => [s.sessionId, s]))
  const written: SessionRow[] = []
  const projected: unknown[] = []
  const store = {
    transferFenceActive: false,
    sessions: { upsertSession: vi.fn(async (row: SessionRow) => { written.push(row) }) },
  }
  const repo = new SessionRepository({
    sessions,
    store,
    ledger: {
      commit: async ({ write, changes }: {
        write: () => Promise<void>
        changes: () => Promise<unknown[]>
      }) => {
        await write()
        projected.push(...await changes())
        return { changes: [] }
      },
    },
    view: {
      buildProjectionPass: async () => ({}),
      wire: (s: Session, _pass: unknown, draft: Parameters<Session['toRow']>[0]) => s.toRow(draft),
    },
    now: () => Date.now(),
  } as never)
  return { repo, rows, sessions, store, written, projected }
}

// The pre-queue algorithm, retained as the same-fixture behavioral oracle.
async function oldFlush(f: ReturnType<typeof fixture>): Promise<void> {
  for (const session of f.sessions.values()) {
    if (session.terminal.activityDirty && await f.repo.persistActivityIfWritable(session)) {
      session.terminal.clearActivityDirty()
    }
  }
}

const flushCandidate = (repo: SessionRepository) => repo.flushActivity()

const mutations: [string, (s: Session) => void][] = [
  ['resume', (s) => s.terminal.recordResumeActivity()],
  ['input', (s) => s.terminal.recordInputActivity()],
  ['observation', (s) => s.terminal.recordObservationActivity()],
  ['output', (s) => s.terminal.acceptOutput(Buffer.from('hello'), 2)],
  ['geometry', (s) => { s.terminal.applyDaemonGeometry({ cols: 90, rows: 30 }) }],
]

afterEach(async () => {
  vi.restoreAllMocks()
  await disposeOracles()
})

describe('changed session activity saving', () => {
  it('matches the old flush answers on the same activity, clean, fenced and retry fixtures', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-10-08T12:00:00.000Z'))
    const old = fixture(6)
    const candidate = fixture(6)
    for (const f of [old, candidate]) {
      mutations.forEach(([, mutate], i) => mutate(f.rows[i]!))
      // Repeated activity is coalesced into the newest row.
      f.rows[0]!.terminal.recordResumeActivity()
      f.store.transferFenceActive = true
    }
    const compare = async () => {
      await oldFlush(old)
      await flushCandidate(candidate.repo)
      expect(candidate.written).toEqual(old.written)
      expect(candidate.projected).toEqual(old.projected)
      expect(candidate.rows.map((s) => s.terminal.activityDirty))
        .toEqual(old.rows.map((s) => s.terminal.activityDirty))
    }
    await compare()
    expect(candidate.written).toHaveLength(0)
    old.store.transferFenceActive = candidate.store.transferFenceActive = false
    await compare()
    expect(candidate.written).toHaveLength(5)
    await compare()
    expect(candidate.written).toHaveLength(5)

    for (const f of [old, candidate]) {
      f.rows[0]!.terminal.recordInputActivity()
      f.store.sessions.upsertSession.mockRejectedValueOnce(new Error('retry'))
    }
    await expect(oldFlush(old)).rejects.toThrow('retry')
    await expect(flushCandidate(candidate.repo)).rejects.toThrow('retry')
    await compare()
    expect(candidate.written).toHaveLength(6)
  })

  it.each([16, 64])('visits only one dirty ID among %i retained sessions', async (count) => {
    const f = fixture(count)
    const gets = vi.spyOn(f.sessions, 'get')
    const values = vi.spyOn(f.sessions, 'values').mockImplementation(() => {
      throw new Error('timer visited clean sessions')
    })
    for (const row of f.rows.slice(1)) {
      vi.spyOn(row.terminal, 'activityDirty', 'get').mockImplementation(() => {
        throw new Error('timer inspected a clean session')
      })
    }
    f.rows[0]!.terminal.recordResumeActivity()
    f.rows[0]!.terminal.recordInputActivity()
    await flushCandidate(f.repo)
    expect(f.written.map((row) => row.id)).toEqual(['dirty-0'])
    expect(gets.mock.calls.map(([id]) => id)).toEqual(['dirty-0'])
    gets.mockClear()
    await flushCandidate(f.repo)
    expect(gets).not.toHaveBeenCalled()
    expect(values).not.toHaveBeenCalled()
  })

  it.each(mutations)('keeps newer %s activity queued through an in-flight write', async (_name, mutate) => {
    const f = fixture(1)
    const session = f.rows[0]!
    session.terminal.recordResumeActivity()
    let release!: () => void
    let entered!: () => void
    const started = new Promise<void>((resolve) => { entered = resolve })
    const blocked = new Promise<void>((resolve) => { release = resolve })
    f.store.sessions.upsertSession.mockImplementationOnce(async (row) => {
      f.written.push(row)
      entered()
      await blocked
    })
    const inFlight = flushCandidate(f.repo)
    await started
    mutate(session)
    const newest = session.toRow()
    await flushCandidate(f.repo) // Existing single-flight skips overlapping calls.
    expect(f.written).toHaveLength(1)
    release()
    await inFlight
    expect(session.terminal.activityDirty).toBe(true)
    await flushCandidate(f.repo)
    expect(f.written).toHaveLength(2)
    expect(f.written[1]).toEqual(newest)
    expect(session.terminal.activityDirty).toBe(false)
    await flushCandidate(f.repo)
    expect(f.written).toHaveLength(2)
  })

  it('defers a newly dirty ID arriving during a write to the next flush', async () => {
    const f = fixture(2)
    f.rows[0]!.terminal.recordResumeActivity()
    f.store.sessions.upsertSession.mockImplementationOnce(async (row) => {
      f.written.push(row)
      f.rows[1]!.terminal.recordInputActivity()
    })
    await flushCandidate(f.repo)
    expect(f.written.map((row) => row.id)).toEqual(['dirty-0'])
    await flushCandidate(f.repo)
    expect(f.written.map((row) => row.id)).toEqual(['dirty-0', 'dirty-1'])
  })

  it('enrolls activity from newly registered and already-dirty sessions', async () => {
    const f = fixture(0)
    const clean = makeSession(1)
    const dirty = makeSession(2)
    dirty.terminal.recordResumeActivity()
    f.repo.registerSession(clean)
    f.repo.registerSession(dirty)
    clean.terminal.recordInputActivity()
    await flushCandidate(f.repo)
    expect(f.written.map((row) => row.id)).toEqual(['dirty-2', 'dirty-1'])
  })

  it('persists counter-only activity without publishing duplicate session wire bytes', async () => {
    const o = await makeOracle()
    const { sessionId } = await o.reg.modules.sessions.createSession({
      agentKind: 'claude-code',
      cwd: '/work',
    })
    await o.reg.modules.sessions.flushBroadcasts()
    const session = o.reg.modules.sessions.sessions.get(sessionId)!
    const writes = vi.spyOn(o.store.sessions, 'upsertSession')
    const projection = vi.fn()
    const off = o.reg.modules.sessions.onSessionProjection(projection)
    try {
      session.terminal.recordInputActivity()
      session.terminal.acceptOutput(Buffer.from('hello'), 2)
      await o.reg.modules.sessions.flushActivity()
      expect(writes).toHaveBeenCalledTimes(1)
      const row = (await o.store.sessions.loadSessions()).find((r) => r.id === sessionId)!
      expect(row.inputCount).toBe(1)
      expect(row.outputCount).toBe(2)
      expect(projection).not.toHaveBeenCalled()
      await o.reg.modules.sessions.flushActivity()
      expect(writes).toHaveBeenCalledTimes(1)
    } finally {
      off()
    }
  })

  it('retains the failed ID and the unvisited backlog for a later retry', async () => {
    const f = fixture(2)
    f.rows.forEach((s) => s.terminal.recordResumeActivity())
    await flushCandidate(f.repo) // Establish the durable baselines first.
    f.written.length = 0
    f.rows.forEach((s) => s.terminal.recordInputActivity())
    f.store.sessions.upsertSession.mockRejectedValueOnce(new Error('retry'))
    await expect(flushCandidate(f.repo)).rejects.toThrow('retry')
    expect(f.rows.every((s) => s.terminal.activityDirty)).toBe(true)
    await flushCandidate(f.repo)
    expect(f.written.map((row) => row.id)).toEqual(['dirty-0', 'dirty-1'])
    expect(f.rows.every((s) => !s.terminal.activityDirty)).toBe(true)
  })

  it('drops removed and explicitly cleaned sessions without writing them', async () => {
    const f = fixture(2)
    f.rows.forEach((s) => s.terminal.recordResumeActivity())
    f.sessions.delete(f.rows[0]!.sessionId)
    f.rows[1]!.terminal.clearActivityDirty()
    await flushCandidate(f.repo)
    const gets = vi.spyOn(f.sessions, 'get')
    await flushCandidate(f.repo)
    expect(f.written).toHaveLength(0)
    expect(gets).not.toHaveBeenCalled()
  })
})
