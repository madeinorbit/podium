import { asMachineId, asSessionId, firstAdminMemberId } from '@podium/model'
import { Ledger } from '@podium/sync'
import { testLedgerWriter } from '@podium/sync/testing'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { openTestStore } from '../../test-support/open-test-store'
import { logStoreRecords } from '../../test-support/record-writer'
import { SessionRepository } from './repository'
import { Session } from './session'

const MACHINE = asMachineId('slice-machine')

function makeSession(index: number): Session {
  return new Session({
    ownerUserId: firstAdminMemberId(),
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

const stores: Awaited<ReturnType<typeof openTestStore>>[] = []

async function fixture(count: number) {
  const store = await openTestStore(':memory:')
  stores.push(store)
  const rows = Array.from({ length: count }, (_, index) => makeSession(index))
  const sessions = new Map(rows.map((session) => [session.sessionId, session]))
  const writer = testLedgerWriter(
    new Ledger({
      repo: store.sync,
      records: await logStoreRecords(store),
      now: () => Date.now(),
      transact: (fn) => store.transact(fn),
    }),
  )
  const commit = vi.fn(writer.commit)
  const realUpsert = store.sessions.upsertSession.bind(store.sessions)
  const upsert = vi.spyOn(store.sessions, 'upsertSession')
  const upserts = vi.spyOn(store.sessions, 'upsertSessions')
  const runScheduledBroadcast = vi.fn()
  const repo = new SessionRepository({
    sessions,
    store,
    writers: ((ledger) => ({ live: ledger, boot: ledger }))({ commit }),
    view: {},
    now: () => Date.now(),
    runScheduledBroadcast,
    broadcastSessions: vi.fn(),
    flushBroadcasts: vi.fn(),
    listSessions: vi.fn(async () => []),
  } as never)
  return { repo, rows, sessions, store, commit, upsert, realUpsert, upserts, runScheduledBroadcast }
}

afterEach(() => {
  vi.useRealTimers()
  for (const store of stores.splice(0)) store.close()
  vi.restoreAllMocks()
})

describe('SessionRepository volatile capture slices [POD-2322]', () => {
  it('drains at most 32 candidates and reports deterministic progress', async () => {
    vi.useFakeTimers()
    const { repo, rows, upserts } = await fixture(40)
    for (const row of rows) repo.markVolatileSessionDirty(row.sessionId)

    const first = await repo.drainVolatileCaptureSlice()
    expect(first.changes).toHaveLength(32)
    expect(first.remaining).toBe(8)
    expect(upserts.mock.calls[0]?.[1]).toHaveLength(32)

    const second = await repo.drainVolatileCaptureSlice()
    expect(second.changes).toHaveLength(8)
    expect(second.remaining).toBe(0)
    expect(upserts.mock.calls[1]?.[1]).toHaveLength(8)
  })

  it('stops on the CPU budget only between complete candidates', async () => {
    vi.useFakeTimers()
    const { repo, rows, upserts } = await fixture(5)
    for (const row of rows) repo.markVolatileSessionDirty(row.sessionId)
    const ticks = [0, 5, 10]

    const result = await repo.drainVolatileCaptureSlice({
      maxItems: 32,
      maxCpuMs: 8,
      now: () => ticks.shift() ?? 10,
    })

    expect(upserts.mock.calls[0]?.[1]).toHaveLength(2)
    expect(result.remaining).toBe(3)
  })

  it('keeps a same-slice mutation pending and persists its newest value next', async () => {
    const { repo, rows, store, upsert, realUpsert } = await fixture(1)
    vi.useFakeTimers()
    const row = rows[0]!
    const first = asMachineId('first-target')
    const latest = asMachineId('latest-target')
    row.handoffTargetMachineId = first
    upsert.mockImplementationOnce(async (scope, value) => {
      await realUpsert(scope, value)
      row.handoffTargetMachineId = latest
      repo.markVolatileSessionDirty(row.sessionId)
    })
    repo.markVolatileSessionDirty(row.sessionId)

    expect((await repo.drainVolatileCaptureSlice()).remaining).toBe(1)
    expect((await store.sessions.getSession(row.sessionId))?.handoffTargetMachineId).toBe(first)
    expect(row.handoffTargetMachineId).toBe(latest)
    expect((await repo.drainVolatileCaptureSlice()).remaining).toBe(0)
    expect((await store.sessions.getSession(row.sessionId))?.handoffTargetMachineId).toBe(latest)
  })

  it('keeps a failed slice pending and schedules the existing retry', async () => {
    vi.useFakeTimers()
    const { repo, rows, commit, runScheduledBroadcast } = await fixture(2)
    for (const row of rows) repo.markVolatileSessionDirty(row.sessionId)
    // Enter the state the production timer has just before it drains: the
    // initial zero-delay handle is cleared, so a failure can arm the retry.
    vi.advanceTimersByTime(0)
    runScheduledBroadcast.mockClear()
    commit.mockImplementationOnce(() => {
      throw new Error('ledger unavailable')
    })

    await expect(repo.drainVolatileCaptureSlice()).rejects.toThrow('ledger unavailable')
    expect(repo.hasPendingVolatile()).toBe(true)
    vi.advanceTimersByTime(999)
    expect(runScheduledBroadcast).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(runScheduledBroadcast).toHaveBeenCalledTimes(1)
  })

  it('the synchronous barrier drains the complete backlog', async () => {
    vi.useFakeTimers()
    const { repo, rows, upserts } = await fixture(100)
    for (const row of rows) repo.markVolatileSessionDirty(row.sessionId)

    const changes = await repo.flushVolatileSessionCaptures()

    expect(changes).toHaveLength(100)
    expect(upserts.mock.calls[0]?.[1]).toHaveLength(100)
    expect(repo.hasPendingVolatile()).toBe(false)
  })
})
