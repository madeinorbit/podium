/**
 * WHICH SESSIONS ARE IN MEMORY (POD-6160 D2f, `residency.ts`).
 *
 * A parked session stays resident only while an operation leases it or a
 * client views it. These tests run the registry with eviction ON (it is off in
 * production until D2g shrinks the map) and check:
 *
 * - over the benchmark corpus, a sweep leaves exactly the running sessions in
 *   memory, and a lease brings each parked one back as the session it was
 *   (wire projection and facts, the live plane included), then lets it go;
 * - the rules: a lease, a viewer, unsettled writes or unfinished draft work
 *   keep a parked session; concurrent leases share one read; a deleted
 *   session has none;
 * - the resident object is the writer of its durable fields: after a rolled
 *   back span and after a commit, its fields equal its row.
 */
import { asSessionId, type SessionId } from '@podium/model'
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
    sessionResidency: { evictParked: true, sweepIntervalMs: 0 },
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
  it('over the benchmark corpus: parked sessions leave memory and a lease brings each back as it was', async () => {
    const store = await openTestStore(':memory:')
    await seedCorpusSessions(store)
    const reg = await boot(store)
    const sessions = reg.modules.sessions
    await sessions.flushActivity()
    const before = new Map([...sessions.sessions].map(([id, s]) => [id, fullView(s)]))
    const running = [...sessions.sessions.values()].filter((s) => isRunningStatus(s.status)).map((s) => s.sessionId)
    const parked = [...before.keys()].filter((id) => !running.includes(id))

    expect(sessions.residency.sweep()).toBe(parked.length)
    expect([...sessions.sessions.keys()].sort()).toEqual([...running].sort())
    // Evicted sessions are their records.
    const records = await sessions.records.read(parked)
    for (const id of parked) expect({ id, view: fullView(records.get(id)!) }).toEqual({ id, view: before.get(id) })

    for (const id of parked) {
      const view = await sessions.residency.withSession(id, 'test', (session) => {
        expect(sessions.sessions.get(id)).toBe(session)
        return fullView(session!)
      })
      expect({ id, view }).toEqual({ id, view: before.get(id) })
      // Released, it leaves again.
      expect(sessions.sessions.has(id)).toBe(false)
    }
    console.log('session residency over the corpus', JSON.stringify({ sessions: before.size, running: running.length }))
    expect(parked.length).toBeGreaterThan(100)
  }, 60_000)

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
