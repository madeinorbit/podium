import type { MetadataChange, ServerMessage, SessionMeta } from '@podium/protocol'
import { Ledger } from '@podium/sync'
import { afterEach, describe, expect, it } from 'vitest'
import { SessionRegistry } from './relay'
import { SessionStore } from './store'

/**
 * Session writes on the write-seam Ledger ([spec:SP-3fe2] #256): persist()
 * commits the row write and the declared SessionMeta change atomically;
 * kill commits the remove with the row delete; boot reconciles; and every
 * appended batch reaches delta clients through the funnel's ONE ordered
 * metadataDelta pipe. Registry-level tests pin the production wiring.
 */
describe('session writes on the write-seam Ledger ([spec:SP-3fe2] #256)', () => {
  const registries: SessionRegistry[] = []
  afterEach(() => {
    for (const r of registries.splice(0)) r.dispose()
  })

  function makeRegistry(store?: SessionStore): SessionRegistry {
    const registry = new SessionRegistry(store)
    registries.push(registry)
    return registry
  }

  function deltaClient(registry: SessionRegistry): { inbox: ServerMessage[] } {
    const inbox: ServerMessage[] = []
    const id = registry.modules.sessions.attachClient((msg) => inbox.push(msg))
    registry.modules.sessions.onClientMessage(id, {
      type: 'hello',
      clientId: '',
      viewport: { cols: 80, rows: 24, dpr: 1 },
      caps: ['metadataDelta'],
    })
    return { inbox }
  }

  const batches = (inbox: ServerMessage[]) =>
    inbox.flatMap((m) => (m.type === 'metadataDelta' ? [m] : []))

  const sessionChanges = (inbox: ServerMessage[]): MetadataChange[] =>
    batches(inbox)
      .flatMap((b) => b.changes)
      .filter((c) => c.entity === 'session')

  const cursorOf = (registry: SessionRegistry): number => {
    const boot = registry.modules.sessions.syncChangesSince(null)
    return boot.cursor
  }

  it('(a) a throw between the row write and the change append rolls BOTH back', () => {
    const store = new SessionStore(':memory:')
    const ledger = new Ledger({
      repo: store.sync,
      now: () => 1_000,
      transact: (fn) => store.transact(fn),
    })
    const cursorBefore = ledger.cursor()
    expect(() =>
      ledger.commit({
        write: () =>
          store.sessions.upsertSession({
            id: 's-atomic',
            agentKind: 'shell',
            cwd: '/w',
            title: 't',
            name: null,
            archived: false,
            workState: null,
            originKind: 'spawn',
            conversationId: null,
            resumeKind: null,
            resumeValue: null,
            status: 'live',
            exitCode: null,
            durableLabel: 'podium-s-atomic',
            createdAt: '2026-07-01T00:00:00.000Z',
            lastActiveAt: '2026-07-01T00:00:00.000Z',
            lastOutputAt: null,
            lastInputAt: null,
            lastResumedAt: null,
            spawnedBy: null,
            machineId: 'm1',
            headless: false,
            issueId: null,
            readAt: null,
          }),
        changes: () => {
          throw new Error('declaration failed')
        },
      }),
    ).toThrow('declaration failed')
    // The session row write inside the same transact span rolled back too.
    expect(store.sessions.loadSessions().find((r) => r.id === 's-atomic')).toBeUndefined()
    expect(ledger.cursor()).toBe(cursorBefore)
  })

  it('(b) an agentState persist yields a durable ledger change (the staleness-gap fix)', () => {
    const registry = makeRegistry()
    const { sessionId } = registry.modules.sessions.createSession({ agentKind: 'shell', cwd: '/w' })
    const cursor = cursorOf(registry)
    registry.modules.sessions.onDaemonMessageFrom('m1', {
      type: 'agentState',
      sessionId,
      state: { phase: 'working', since: '2026-07-09T00:00:00.000Z', openTaskCount: 0 },
    })
    const healed = registry.modules.sessions.syncChangesSince(cursor)
    expect(healed.kind).toBe('delta')
    if (healed.kind !== 'delta') return
    const change = healed.changes.find(
      (c) => c.entity === 'session' && c.id === sessionId && c.op === 'upsert',
    ) as { value?: SessionMeta } | undefined
    expect(change?.value?.agentState?.phase).toBe('working')
  })

  it('(b2) a title persist yields a durable ledger change', () => {
    const registry = makeRegistry()
    const { sessionId } = registry.modules.sessions.createSession({ agentKind: 'shell', cwd: '/w' })
    const cursor = cursorOf(registry)
    registry.modules.sessions.onDaemonMessageFrom('m1', {
      type: 'title',
      sessionId,
      title: 'a real durable title',
    })
    const healed = registry.modules.sessions.syncChangesSince(cursor)
    expect(healed.kind).toBe('delta')
    if (healed.kind !== 'delta') return
    const change = healed.changes.find(
      (c) => c.entity === 'session' && c.id === sessionId && c.op === 'upsert',
    ) as { value?: SessionMeta } | undefined
    expect(change?.value?.title).toBe('a real durable title')
  })

  it('(c) session and issue commits interleave onto delta clients in seq order with no gaps', () => {
    const registry = makeRegistry()
    const delta = deltaClient(registry)
    const before = delta.inbox.length
    const { sessionId } = registry.modules.sessions.createSession({ agentKind: 'shell', cwd: '/w' })
    registry.issues.create({ repoPath: '/r', title: 'interleaved', startNow: false })
    registry.modules.sessions.renameSession({ sessionId, name: 'renamed-mid-stream' })
    registry.modules.sessions.flushBroadcasts() // drain the coalesced pipeline
    const received = batches(delta.inbox.slice(before)).flatMap((b) => b.changes)
    expect(received.length).toBeGreaterThanOrEqual(3)
    expect(received.some((c) => c.entity === 'session')).toBe(true)
    expect(received.some((c) => c.entity === 'issue')).toBe(true)
    // Strict seq order, and gap-free: the stream carries EVERY seq in its range.
    const seqs = received.map((c) => c.seq)
    for (let i = 1; i < seqs.length; i++) expect(seqs[i]).toBe((seqs[i - 1] as number) + 1)
    // Batch stamps match their last change.
    for (const b of batches(delta.inbox.slice(before))) {
      expect(b.changes.at(-1)?.seq).toBe(b.seq)
    }
  })

  it('(d) one appended batch reaches a delta client exactly once (no double emission via publishComputed)', () => {
    const registry = makeRegistry()
    const delta = deltaClient(registry)
    const before = delta.inbox.length
    const { sessionId } = registry.modules.sessions.createSession({ agentKind: 'shell', cwd: '/w' })
    registry.modules.sessions.flushBroadcasts()
    const seen = sessionChanges(delta.inbox.slice(before)).filter((c) => c.id === sessionId)
    // The spawn persists exactly once → exactly one upsert, delivered once,
    // even though broadcastSessions ALSO ran its (snapshot-only) fan-out.
    expect(seen).toHaveLength(1)
    const seqCounts = new Map<number, number>()
    for (const c of batches(delta.inbox.slice(before)).flatMap((b) => b.changes)) {
      seqCounts.set(c.seq, (seqCounts.get(c.seq) ?? 0) + 1)
    }
    for (const [, n] of seqCounts) expect(n).toBe(1)
    // ...and delta clients never get the full-list snapshot rebroadcast.
    expect(delta.inbox.slice(before).some((m) => m.type === 'sessionsChanged')).toBe(false)
  })

  it('(e) kill commits a remove in the same transaction as the row delete', () => {
    const registry = makeRegistry()
    const { sessionId } = registry.modules.sessions.createSession({ agentKind: 'shell', cwd: '/w' })
    const cursor = cursorOf(registry)
    const delta = deltaClient(registry)
    const before = delta.inbox.length
    registry.modules.sessions.killSession({ sessionId })
    registry.modules.sessions.flushBroadcasts()
    // Durable: the remove is in the log…
    const healed = registry.modules.sessions.syncChangesSince(cursor)
    expect(healed.kind).toBe('delta')
    if (healed.kind !== 'delta') return
    expect(
      healed.changes.some((c) => c.entity === 'session' && c.id === sessionId && c.op === 'remove'),
    ).toBe(true)
    // …and live: it reached the delta client, and the row is gone.
    expect(
      sessionChanges(delta.inbox.slice(before)).some(
        (c) => c.id === sessionId && c.op === 'remove',
      ),
    ).toBe(true)
    expect(registry.sessionStore.sessions.loadSessions()).toHaveLength(0)
  })

  it('(f) boot reconcile records offline row changes durably, with no fan-out', () => {
    const store = new SessionStore(':memory:')
    const first = new SessionRegistry(store)
    const { sessionId } = first.modules.sessions.createSession({ agentKind: 'shell', cwd: '/w' })
    first.dispose()
    const cursor = first.modules.sessions.syncChangesSince(null).cursor
    // Offline mutation: rename the row behind the server's back.
    const row = store.sessions.loadSessions().find((r) => r.id === sessionId)
    if (!row) throw new Error('row missing')
    store.sessions.upsertSession({ ...row, name: 'changed offline' })
    // Restart over the same store: loadFromStore reconciles against the ledger.
    const second = makeRegistry(store)
    const healed = second.modules.sessions.syncChangesSince(cursor)
    expect(healed.kind).toBe('delta')
    if (healed.kind !== 'delta') return
    const change = healed.changes.find(
      (c) => c.entity === 'session' && c.id === sessionId && c.op === 'upsert',
    ) as { value?: SessionMeta } | undefined
    expect(change?.value?.name).toBe('changed offline')
  })

  it('replaying the whole durable log folds to the live session list', () => {
    const registry = makeRegistry()
    const a = registry.modules.sessions.createSession({ agentKind: 'shell', cwd: '/w1' })
    const b = registry.modules.sessions.createSession({ agentKind: 'shell', cwd: '/w2' })
    registry.modules.sessions.renameSession({ sessionId: a.sessionId, name: 'kept' })
    registry.modules.sessions.killSession({ sessionId: b.sessionId })
    const healed = registry.modules.sessions.syncChangesSince(0)
    expect(healed.kind).toBe('delta')
    if (healed.kind !== 'delta') return
    const folded = new Map<string, unknown>()
    for (const c of healed.changes) {
      if (c.entity !== 'session') continue
      if (c.op === 'upsert') folded.set(c.id, c.value)
      else folded.delete(c.id)
    }
    const live = registry.modules.sessions.listSessions()
    expect([...folded.keys()].sort()).toEqual(live.map((s) => s.sessionId).sort())
    expect(folded.get(a.sessionId)).toEqual(live.find((s) => s.sessionId === a.sessionId))
  })
})
