/**
 * WHICH SESSIONS ARE IN MEMORY (POD-6160 D2f, `residency.ts`).
 *
 * A parked session stays resident only while an operation leases it or a
 * client views it. These tests check:
 *
 * - over the benchmark corpus, boot holds exactly the running sessions and
 *   reads no draft, and a lease brings each ended one back equal to its record
 *   (wire projection and facts, the live plane included), then lets it go;
 * - the rules: a lease, a viewer, unsettled writes or unfinished draft work
 *   keep a parked session; concurrent leases share one read; a deleted
 *   session has none;
 * - the resident object is the writer of its durable fields: after a rolled
 *   back span and after a commit, its fields equal its row.
 */
import { asSessionId, firstAdminMemberId, type SessionId } from '@podium/model'
import type { ControlMessage } from '@podium/protocol/daemon'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SessionRegistry } from '../../relay'
import type { SessionStore } from '../../store'
import { attachHostDaemon } from '../../test-support/host-daemon'
import { openTestStore } from '../../test-support/open-test-store'
import { seedCorpusSessions } from '../../test-support/session-corpus'
import { durableView, isRunningStatus, type SessionSubject, subjectFacts, subjectMeta } from './records'
import { SessionResidency, type SessionResidencyPorts } from './residency'
import type { Session } from './session'

const registries: SessionRegistry[] = []
afterEach(async () => {
  for (const reg of registries.splice(0)) await reg.dispose()
})

async function boot(store: SessionStore): Promise<SessionRegistry> {
  const reg = await SessionRegistry.create(store, undefined, {
    instanceId: 'default',
    sessionResidency: { sweepIntervalMs: 0 },
  })
  registries.push(reg)
  return reg
}

/** Everything a projection reads off a session, the live plane included. */
function fullView(subject: SessionSubject): unknown {
  return { meta: subjectMeta(subject), facts: subjectFacts(subject) }
}

async function parkedSession(reg: SessionRegistry, store: SessionStore): Promise<SessionId> {
  const { sessionId } = await reg.modules.sessions.createSession({ agentKind: 'shell', cwd: '/x' })
  await reg.gateway.routeDaemonFrame(store.hostMachineId, { type: 'agentExit', sessionId, code: 0 })
  await reg.modules.sessions.flushActivity()
  return sessionId
}

describe('session residency (POD-6160 D2f)', () => {
  it('over the benchmark corpus: boot holds the running sessions only, and a lease brings any other back and lets it go', async () => {
    const store = await openTestStore(':memory:')
    await seedCorpusSessions(store)
    const rows = await store.sessions.loadSessions()
    // Running sessions, and headless ones (resident while their row exists).
    const running = rows.filter((row) => isRunningStatus(row.status) || row.headless).map((row) => row.id)
    const ended = rows.filter((row) => !running.includes(row.id)).map((row) => row.id)
    const draftReads = [vi.spyOn(store.sessions, 'loadDrafts'), vi.spyOn(store.sessions, 'loadDraftDocs')]
    const reg = await boot(store)
    const sessions = reg.modules.sessions
    // SESSIONS IN MEMORY = RUNNING SESSIONS, over thousands of ended ones.
    expect([...sessions.sessions.keys()].sort()).toEqual([...running].sort())
    // Boot read no draft document (they load when used).
    for (const read of draftReads) expect(read).not.toHaveBeenCalled()

    // Each ended session comes back for a lease, equal to its record, and leaves.
    const records = await sessions.records.read(ended)
    for (const id of ended) {
      const view = await sessions.residency.withSession(id, 'test', (session) => {
        expect(sessions.sessions.get(id)).toBe(session)
        return fullView(session!)
      })
      expect({ id, view }).toEqual({ id, view: fullView(records.get(id)!) })
      expect(sessions.sessions.has(id)).toBe(false)
    }
    console.log('session residency over the corpus', JSON.stringify({ sessions: rows.length, running: running.length }))
    expect(ended.length).toBeGreaterThan(1000)
    expect(sessions.sessions.size).toBe(running.length)
  }, 120_000)

  it('keeps a leased parked session through a sweep and shares one read between concurrent leases', async () => {
    const store = await openTestStore(':memory:')
    const reg = await boot(store)
    await attachHostDaemon(reg)
    const sessions = reg.modules.sessions
    const id = await parkedSession(reg, store)
    // The exit frame held it while it was handled; its release let it go.
    expect(sessions.sessions.has(id)).toBe(false)

    const reads = vi.spyOn(sessions.repository, 'materializeStoredSession')
    const [a, b] = await Promise.all([sessions.residency.acquire(id, 'a'), sessions.residency.acquire(id, 'b')])
    expect(a).toBeDefined()
    expect(b).toBe(a)
    expect(reads).toHaveBeenCalledTimes(1)
    expect(sessions.residency.sweep()).toBe(0)
    sessions.residency.release(id)
    expect(sessions.sessions.get(id)).toBe(a)
    sessions.residency.release(id)
    expect(sessions.sessions.has(id)).toBe(false)
  })

  it('has no session for a deleted or unknown id, and holds nothing for it', async () => {
    const store = await openTestStore(':memory:')
    const reg = await boot(store)
    await attachHostDaemon(reg)
    const sessions = reg.modules.sessions
    const id = await parkedSession(reg, store)
    sessions.residency.sweep()
    await store.sessions.softDeleteSessions([id], '2026-10-01T00:00:00.000Z', 'standalone')
    expect(await sessions.residency.acquire(id, 'test')).toBeUndefined()
    expect(await sessions.residency.acquire(asSessionId('nope'), 'test')).toBeUndefined()
    expect(sessions.residency.leased(id)).toBe(false)
    expect(sessions.sessions.has(id)).toBe(false)
  })

  it('keeps a headless session resident while its row exists, even one whose establish failed', async () => {
    const store = await openTestStore(':memory:')
    const owner = await firstAdminMemberId(store)
    const sessionId = asSessionId('headless-establish-failed')
    // What a failed establish leaves: a headless row marked exited, never bound.
    await store.sessions.upsertSession({
      id: sessionId,
      ownerUserId: owner,
      agentKind: 'claude-code',
      cwd: '/r',
      title: 'thread',
      name: null,
      originKind: 'spawn',
      conversationId: null,
      resumeKind: null,
      resumeValue: null,
      status: 'exited',
      exitCode: -1,
      durableLabel: `podium-${sessionId}`,
      createdAt: '2026-10-16T00:00:00.000Z',
      lastActiveAt: '2026-10-16T00:00:00.000Z',
      lastOutputAt: null,
      lastInputAt: null,
      lastResumedAt: null,
      archived: false,
      workState: null,
      machineId: store.hostMachineId,
      headless: true,
      issueId: null,
      stoppedAt: '2026-10-16T00:00:00.000Z',
    } as never)
    // Restored at boot with the running ones, and never evicted.
    const reg = await boot(store)
    expect(reg.modules.sessions.sessions.get(sessionId)?.status).toBe('exited')
    reg.modules.sessions.residency.sweep()
    expect(reg.modules.sessions.residency.residentBecause(sessionId)).toBe('running')
    // A machine attach re-sends its establish frame, as before the map shrank.
    const daemon: ControlMessage[] = []
    await attachHostDaemon(reg, (m) => daemon.push(m))
    await vi.waitFor(() => expect(daemon.some((m) => m.type === 'spawn' && m.sessionId === sessionId)).toBe(true))
  })

  it('the resident session equals its row after a rolled-back span and after a commit', async () => {
    const store = await openTestStore(':memory:')
    const reg = await boot(store)
    await attachHostDaemon(reg)
    const sessions = reg.modules.sessions
    const id = await parkedSession(reg, store)
    sessions.residency.sweep()
    const equalsRow = async (session: Session) => {
      await sessions.flushActivity()
      const record = (await sessions.records.read([id])).get(id)!
      expect(durableView(session)).toEqual(durableView(record))
    }
    await sessions.residency.withSession(id, 'test', async (session) => {
      await equalsRow(session!)
      await expect(
        store.transact(async () => {
          await sessions.renameSession({ sessionId: id, name: 'rolled back' })
          throw new Error('enclosing span failed')
        }),
      ).rejects.toThrow('enclosing span failed')
      await equalsRow(session!)
      await sessions.renameSession({ sessionId: id, name: 'kept' })
      expect(session!.name).toBe('kept')
      await equalsRow(session!)
    })
  })
})

describe('session residency rules', () => {
  function fixture(overrides: Partial<SessionResidencyPorts> = {}) {
    const sessions = new Map<SessionId, Session>()
    const id = asSessionId('s1')
    const session = { sessionId: id, status: 'exited' } as Session
    sessions.set(id, session)
    const evicted: SessionId[] = []
    const residency = new SessionResidency({
      sessions,
      store: {} as SessionStore,
      materialize: async () => undefined,
      settled: () => true,
      viewed: () => false,
      holdsWork: () => false,
      evict: (s) => {
        sessions.delete(s.sessionId)
        evicted.push(s.sessionId)
      },
      evictParked: true,
      sweepIntervalMs: 0,
      ...overrides,
    })
    return { sessions, id, session, residency, evicted }
  }

  it('evicts a parked session nothing uses', () => {
    const f = fixture()
    expect(f.residency.sweep()).toBe(1)
    expect(f.evicted).toEqual([f.id])
  })

  it('keeps a running session', () => {
    const f = fixture()
    ;(f.session as { status: string }).status = 'live'
    expect(f.residency.sweep()).toBe(0)
  })

  it('keeps a session a client views, with writes in flight, or with unfinished draft work', () => {
    expect(fixture({ viewed: () => true }).residency.sweep()).toBe(0)
    expect(fixture({ settled: () => false }).residency.sweep()).toBe(0)
    expect(fixture({ holdsWork: () => true }).residency.sweep()).toBe(0)
  })

  it('evicts nothing while eviction is off', () => {
    const f = fixture({ evictParked: false })
    expect(f.residency.sweep()).toBe(0)
    expect(f.residency.tryEvict(f.id)).toBe(false)
  })
})
