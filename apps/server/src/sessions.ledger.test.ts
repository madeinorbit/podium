import type { MetadataChange, ServerMessage, SessionMeta } from '@podium/protocol'
import { Ledger } from '@podium/sync'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { LOCAL_MACHINE_ID } from './local-machine'
import { SessionRegistry } from './relay'
import { SessionStore } from './store'

type ProjectionEvent = {
  generation: number
  changes: MetadataChange[]
  ledgerCursor: number
}

/**
 * Session writes on the write-seam Ledger ([spec:SP-3fe2] #256): persist()
 * commits the row write and the declared SessionMeta change atomically;
 * kill commits the remove with the row tombstone; boot reconciles; and every
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
      state: { phase: 'working', since: '2026-07-09T00:00:00.000Z', nativeSubagentCount: 0 },
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

  it('(e) kill commits a remove in the same transaction as the row tombstone', () => {
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
    // …and live: it reached the delta client, while the durable row is tombstoned.
    expect(
      sessionChanges(delta.inbox.slice(before)).some(
        (c) => c.id === sessionId && c.op === 'remove',
      ),
    ).toBe(true)
    expect(registry.sessionStore.sessions.loadSessions()).toHaveLength(0)
    expect(registry.sessionStore.sessions.loadDeletedSessions()).toEqual([
      expect.objectContaining({
        id: sessionId,
        deletionSource: 'standalone',
        deletedByIssueId: null,
      }),
    ])
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

  it('(g) a reentrant ledger commit during oplog.appended cannot reorder the delta stream (#247)', () => {
    const registry = makeRegistry()
    const a = registry.modules.sessions.createSession({ agentKind: 'shell', cwd: '/w1' })
    const b = registry.modules.sessions.createSession({ agentKind: 'shell', cwd: '/w2' })
    registry.modules.sessions.flushBroadcasts()
    const delta = deltaClient(registry)
    const before = delta.inbox.length
    // A bus consumer that commits AGAIN while handling 'oplog.appended' — its
    // batch carries a LATER seq than the one being announced. Bus-before-pipe
    // delivered [N+1, N] and the client's cursor jumped past N without healing.
    let reentered = false
    registry.bus.on('oplog.appended', () => {
      if (reentered) return
      reentered = true
      registry.modules.sessions.renameSession({ sessionId: b.sessionId, name: 'inner-commit' })
    })
    registry.modules.sessions.renameSession({ sessionId: a.sessionId, name: 'outer-commit' })
    registry.modules.sessions.flushBroadcasts()
    const seqs = batches(delta.inbox.slice(before))
      .flatMap((m) => m.changes)
      .map((c) => c.seq)
    expect(seqs.length).toBeGreaterThanOrEqual(2)
    // Strict append (= seq) order, gap-free — the client gap rule's invariant.
    for (let i = 1; i < seqs.length; i++) expect(seqs[i]).toBe((seqs[i - 1] as number) + 1)
  })

  it('(h) upstream mirror sets and staleness flips are explicitly captured (#247)', () => {
    const upstreamMeta: SessionMeta = {
      sessionId: 'hub-s1',
      agentKind: 'shell',
      title: 'hub session',
      cwd: '/hub/w',
      status: 'live',
      controllerId: null,
      geometry: { cols: 80, rows: 24 },
      epoch: 0,
      clientCount: 0,
      createdAt: '2026-07-01T00:00:00.000Z',
      lastActiveAt: '2026-07-01T00:00:00.000Z',
      origin: { kind: 'spawn' },
      archived: false,
      readAt: null,
      unread: true,
      machineId: 'hub-m1',
      machineName: 'hub',
    }
    const registry = makeRegistry()
    const cursor = cursorOf(registry)
    // Mirror set: hub-fed rows have no local session row, so their owning seam captures them.
    registry.modules.sessions.setUpstreamSessions([upstreamMeta])
    registry.modules.sessions.flushBroadcasts()
    const afterSet = registry.modules.sessions.syncChangesSince(cursor)
    expect(afterSet.kind).toBe('delta')
    if (afterSet.kind !== 'delta') return
    const setChange = afterSet.changes.find(
      (c) => c.entity === 'session' && c.id === 'hub-s1' && c.op === 'upsert',
    ) as { value?: SessionMeta } | undefined
    expect(setChange?.value?.viaHub).toBe(true)
    // Staleness flip: applied at read time, captured at broadcast time.
    registry.modules.sessions.setUpstreamStale(true)
    registry.modules.sessions.flushBroadcasts()
    const afterStale = registry.modules.sessions.syncChangesSince(afterSet.cursor)
    expect(afterStale.kind).toBe('delta')
    if (afterStale.kind !== 'delta') return
    const staleChange = afterStale.changes.find(
      (c) => c.entity === 'session' && c.id === 'hub-s1' && c.op === 'upsert',
    ) as { value?: SessionMeta } | undefined
    expect(staleChange?.value?.upstreamStale).toBe(true)
    // Mirror cleared: the owning seam declares an explicit remove.
    registry.modules.sessions.setUpstreamSessions([])
    registry.modules.sessions.flushBroadcasts()
    const afterClear = registry.modules.sessions.syncChangesSince(afterStale.cursor)
    expect(afterClear.kind).toBe('delta')
    if (afterClear.kind !== 'delta') return
    expect(
      afterClear.changes.some(
        (c) => c.entity === 'session' && c.id === 'hub-s1' && c.op === 'remove',
      ),
    ).toBe(true)
  })

  it('keeps the local side of an id collision visible and reveals the upstream row on removal', () => {
    const registry = makeRegistry()
    const upstream: SessionMeta = {
      sessionId: 'union-collision',
      agentKind: 'shell',
      title: 'hub',
      cwd: '/hub',
      status: 'live',
      controllerId: null,
      geometry: { cols: 80, rows: 24 },
      epoch: 0,
      clientCount: 0,
      createdAt: '2026-07-01T00:00:00.000Z',
      lastActiveAt: '2026-07-01T00:00:00.000Z',
      origin: { kind: 'spawn' },
      archived: false,
      readAt: null,
      unread: true,
    }
    registry.modules.sessions.setUpstreamSessions([upstream])
    registry.modules.sessions.createSession({
      sessionId: upstream.sessionId,
      agentKind: 'shell',
      cwd: '/local',
    })
    const local = registry.modules.sessions
      .listSessions()
      .find((session) => session.sessionId === upstream.sessionId)
    expect(local?.cwd).toBe('/local')
    expect(local?.viaHub).toBeUndefined()

    registry.modules.sessions.setUpstreamSessions([{ ...upstream, title: 'hub latest' }])
    const cursor = cursorOf(registry)
    registry.modules.sessions.setUpstreamStale(true)
    const afterStale = registry.modules.sessions.syncChangesSince(cursor)
    expect(afterStale.kind).toBe('delta')
    if (afterStale.kind !== 'delta') return
    expect(
      afterStale.changes.filter(
        (change) => change.entity === 'session' && change.id === upstream.sessionId,
      ),
    ).toEqual([])

    const projectionEvents: ProjectionEvent[] = []
    const off = registry.modules.sessions.onSessionProjection((event) =>
      projectionEvents.push(event),
    )
    registry.modules.sessions.killSession({ sessionId: upstream.sessionId })
    off()
    const revealed = registry.modules.sessions.syncChangesSince(afterStale.cursor)
    expect(revealed.kind).toBe('delta')
    if (revealed.kind !== 'delta') return
    const last = revealed.changes
      .filter((change) => change.entity === 'session' && change.id === upstream.sessionId)
      .at(-1) as { op: string; value?: SessionMeta } | undefined
    expect(last).toMatchObject({ op: 'upsert', value: { viaHub: true, upstreamStale: true } })
    expect(projectionEvents).toHaveLength(1)
    expect(projectionEvents[0]?.changes.map((change) => change.op)).toEqual(['remove', 'upsert'])
    expect(projectionEvents[0]?.changes.at(-1)).toMatchObject({
      seq: projectionEvents[0]?.ledgerCursor,
      value: { viaHub: true, upstreamStale: true },
    })
    expect(
      registry.modules.sessions
        .listSessions()
        .find((session) => session.sessionId === upstream.sessionId)?.viaHub,
    ).toBe(true)
  })

  it('(i) startup adoption and a machine rename re-capture machineId/machineName (#247)', () => {
    const registry = makeRegistry()
    const { sessionId } = registry.modules.sessions.createSession({ agentKind: 'shell', cwd: '/w' })
    registry.modules.sessions.flushBroadcasts()
    const cursor = cursorOf(registry)
    // ensureLocalMachine → adoptPlaceholderRows rewrites machineId in memory and
    // in the store WITHOUT a persist(); the machine seam captures the derived flip.
    registry.modules.machines.ensureLocalMachine('adopting-host')
    registry.modules.sessions.flushBroadcasts()
    const afterAdopt = registry.modules.sessions.syncChangesSince(cursor)
    expect(afterAdopt.kind).toBe('delta')
    if (afterAdopt.kind !== 'delta') return
    const adopted = afterAdopt.changes.find(
      (c) => c.entity === 'session' && c.id === sessionId && c.op === 'upsert',
    ) as { value?: SessionMeta } | undefined
    expect(adopted?.value?.machineId).toBe(LOCAL_MACHINE_ID)
    expect(adopted?.value?.machineName).toBe('adopting-host')
    // Rename: machineName is stamped at wire time, no session row changes.
    registry.modules.machines.renameMachine(LOCAL_MACHINE_ID, 'renamed-host')
    registry.modules.sessions.flushBroadcasts()
    const afterRename = registry.modules.sessions.syncChangesSince(afterAdopt.cursor)
    expect(afterRename.kind).toBe('delta')
    if (afterRename.kind !== 'delta') return
    const renamed = afterRename.changes.find(
      (c) => c.entity === 'session' && c.id === sessionId && c.op === 'upsert',
    ) as { value?: SessionMeta } | undefined
    expect(renamed?.value?.machineName).toBe('renamed-host')
    // Revoke: deleting the machine row changes the derived name to its id fallback.
    registry.modules.machines.revokeMachine(LOCAL_MACHINE_ID)
    registry.modules.sessions.flushBroadcasts()
    const afterRevoke = registry.modules.sessions.syncChangesSince(afterRename.cursor)
    expect(afterRevoke.kind).toBe('delta')
    if (afterRevoke.kind !== 'delta') return
    const revoked = afterRevoke.changes.find(
      (c) => c.entity === 'session' && c.id === sessionId && c.op === 'upsert',
    ) as { value?: SessionMeta } | undefined
    expect(revoked?.value?.machineName).toBe(LOCAL_MACHINE_ID)
  })

  it('(j) the daemon-disconnect reconnecting flip reaches the durable log (#247)', () => {
    const registry = makeRegistry()
    const { sessionId } = registry.modules.sessions.createSession({ agentKind: 'shell', cwd: '/w' })
    // Attaching the local daemon adopts the placeholder session onto LOCAL_MACHINE_ID.
    registry.modules.sessions.attachDaemon(LOCAL_MACHINE_ID, () => {})
    registry.modules.sessions.flushBroadcasts()
    const cursor = cursorOf(registry)
    // The disconnect sweep flips live/starting → 'reconnecting' with NO persist;
    // the disconnect seam captures the touched sessions as one explicit batch.
    registry.modules.sessions.detachDaemon(LOCAL_MACHINE_ID)
    registry.modules.sessions.flushBroadcasts()
    const healed = registry.modules.sessions.syncChangesSince(cursor)
    expect(healed.kind).toBe('delta')
    if (healed.kind !== 'delta') return
    const flipped = healed.changes.find(
      (c) => c.entity === 'session' && c.id === sessionId && c.op === 'upsert',
    ) as { value?: SessionMeta } | undefined
    expect(flipped?.value?.status).toBe('reconnecting')
  })

  it('retires full-world session reconcile after boot while keeping every owning seam durable', () => {
    const reconcile = vi.spyOn(Ledger.prototype, 'reconcile')
    const registry = makeRegistry()
    reconcile.mockClear()

    const { sessionId } = registry.modules.sessions.createSession({ agentKind: 'shell', cwd: '/w' })
    const clientId = registry.modules.sessions.attachClient(() => {})
    registry.modules.sessions.onClientMessage(clientId, { type: 'attach', sessionId })
    registry.modules.sessions.onClientMessage(clientId, {
      type: 'viewState',
      visible: [sessionId],
      focused: sessionId,
    })
    registry.modules.sessions.onClientMessage(clientId, {
      type: 'resize',
      sessionId,
      cols: 100,
      rows: 40,
    })
    registry.modules.sessions.onClientMessage(clientId, { type: 'detach', sessionId })
    registry.modules.sessions.setUpstreamSessions([
      {
        sessionId: 'hub-explicit',
        agentKind: 'shell',
        title: 'hub',
        cwd: '/hub',
        status: 'live',
        controllerId: null,
        geometry: { cols: 80, rows: 24 },
        epoch: 0,
        clientCount: 0,
        createdAt: '2026-07-01T00:00:00.000Z',
        lastActiveAt: '2026-07-01T00:00:00.000Z',
        origin: { kind: 'spawn' },
        archived: false,
        readAt: null,
        unread: true,
      },
    ])
    registry.modules.sessions.setUpstreamStale(true)
    registry.modules.sessions.setUpstreamSessions([])
    registry.modules.sessions.flushBroadcasts()

    expect(reconcile.mock.calls.filter(([entity]) => entity === 'session')).toEqual([])
    const changes = registry.modules.sessions.syncChangesSince(0)
    expect(changes.kind).toBe('delta')
    if (changes.kind !== 'delta') return
    const geometryChange = changes.changes.find(
      (change) =>
        change.entity === 'session' &&
        change.id === sessionId &&
        change.op === 'upsert' &&
        (change.value as SessionMeta | undefined)?.geometry.cols === 100,
    )
    expect(geometryChange).toBeDefined()
    expect(
      changes.changes.some(
        (change) =>
          change.entity === 'session' && change.id === 'hub-explicit' && change.op === 'remove',
      ),
    ).toBe(true)
  })

  it('emits ordered self-contained projection events for persist and every live-view seam', () => {
    const registry = makeRegistry()
    const events: ProjectionEvent[] = []
    const off = registry.modules.sessions.onSessionProjection((event) => events.push(event))
    const { sessionId } = registry.modules.sessions.createSession({ agentKind: 'shell', cwd: '/w' })
    const afterCreate = registry.modules.sessions.sessionsGeneration()

    registry.modules.sessions.onDaemonMessageFrom('m1', {
      type: 'agentState',
      sessionId,
      state: { phase: 'working', since: '2026-07-10T00:00:00.000Z', nativeSubagentCount: 0 },
    })
    const afterPersist = registry.modules.sessions.sessionsGeneration()

    const clientId = registry.modules.sessions.attachClient(() => {})
    registry.modules.sessions.onClientMessage(clientId, { type: 'attach', sessionId })
    registry.modules.sessions.flushBroadcasts()
    const afterAttach = registry.modules.sessions.sessionsGeneration()
    registry.modules.sessions.onClientMessage(clientId, {
      type: 'viewState',
      visible: [sessionId],
      focused: sessionId,
    })
    registry.modules.sessions.onClientMessage(clientId, {
      type: 'resize',
      sessionId,
      cols: 110,
      rows: 42,
    })
    registry.modules.sessions.flushBroadcasts()
    const afterResize = registry.modules.sessions.sessionsGeneration()
    const secondClientId = registry.modules.sessions.attachClient(() => {})
    registry.modules.sessions.onClientMessage(secondClientId, { type: 'attach', sessionId })
    registry.modules.sessions.flushBroadcasts()
    const afterSecondAttach = registry.modules.sessions.sessionsGeneration()
    registry.modules.sessions.onClientMessage(secondClientId, { type: 'requestControl', sessionId })
    registry.modules.sessions.flushBroadcasts()
    const afterControl = registry.modules.sessions.sessionsGeneration()
    // A no-op repeat must not fabricate work.
    const eventCountBeforeNoop = events.length
    registry.modules.sessions.onClientMessage(secondClientId, { type: 'requestControl', sessionId })
    registry.modules.sessions.flushBroadcasts()
    expect(events).toHaveLength(eventCountBeforeNoop)
    registry.modules.sessions.onClientMessage(secondClientId, { type: 'detach', sessionId })
    registry.modules.sessions.flushBroadcasts()
    const afterDetach = registry.modules.sessions.sessionsGeneration()
    off()

    expect(afterCreate).toBeGreaterThan(0)
    expect(afterPersist).toBeGreaterThan(afterCreate)
    expect(afterAttach).toBeGreaterThan(afterPersist)
    expect(afterResize).toBeGreaterThan(afterAttach)
    expect(afterSecondAttach).toBeGreaterThan(afterResize)
    expect(afterControl).toBeGreaterThan(afterSecondAttach)
    expect(afterDetach).toBeGreaterThan(afterControl)
    expect(events.map((event) => event.generation)).toEqual(
      events.map((event) => event.generation).sort((a, b) => a - b),
    )
    expect(new Set(events.map((event) => event.generation)).size).toBe(events.length)
    for (const event of events) {
      expect(event.changes.length).toBeGreaterThan(0)
      expect(event.changes.every((change) => change.entity === 'session')).toBe(true)
      expect(event.ledgerCursor).toBe(event.changes.at(-1)?.seq)
    }
    expect(registry.modules.sessions.listSessions()[0]).not.toHaveProperty('generation')
    expect(registry.modules.sessions.listSessions()[0]).not.toHaveProperty('revision')
  })

  it('resets the internal generation across restart without disturbing durable ledger order', () => {
    const store = new SessionStore(':memory:')
    const first = new SessionRegistry(store)
    const { sessionId } = first.modules.sessions.createSession({ agentKind: 'shell', cwd: '/w' })
    const clientId = first.modules.sessions.attachClient(() => {})
    first.modules.sessions.onClientMessage(clientId, { type: 'attach', sessionId })
    first.modules.sessions.onClientMessage(clientId, {
      type: 'viewState',
      visible: [sessionId],
      focused: sessionId,
    })
    first.modules.sessions.onClientMessage(clientId, {
      type: 'resize',
      sessionId,
      cols: 101,
      rows: 37,
    })
    first.modules.sessions.onClientMessage(clientId, { type: 'detach', sessionId })
    first.modules.sessions.flushBroadcasts()
    const generationBeforeRestart = first.modules.sessions.sessionsGeneration()
    const cursorBeforeRestart = first.modules.sessions.syncChangesSince(null).cursor
    first.dispose()

    const second = makeRegistry(store)
    const generationAfterRestart = second.modules.sessions.sessionsGeneration()
    expect(generationAfterRestart).toBeGreaterThan(0)
    expect(generationAfterRestart).toBeLessThan(generationBeforeRestart)
    const cursorAfterRecovery = second.modules.sessions.syncChangesSince(null).cursor
    expect(cursorAfterRecovery).toBeGreaterThan(cursorBeforeRestart)
    const recovered = second.modules.sessions.syncChangesSince(cursorBeforeRestart)
    expect(recovered.kind).toBe('delta')
    if (recovered.kind !== 'delta') return
    expect(
      recovered.changes.some(
        (change) =>
          change.entity === 'session' && change.id === sessionId && change.op === 'upsert',
      ),
    ).toBe(true)
    second.modules.sessions.broadcastSessions()
    second.modules.sessions.flushBroadcasts()
    expect(second.modules.sessions.syncChangesSince(cursorAfterRecovery)).toEqual({
      kind: 'delta',
      cursor: cursorAfterRecovery,
      changes: [],
    })
    expect(second.modules.sessions.listSessions()[0]).not.toHaveProperty('generation')
    expect(second.modules.sessions.listSessions()[0]).not.toHaveProperty('revision')
  })

  it('invalidates a coalesced legacy snapshot when state reverts to identical bytes', () => {
    const registry = makeRegistry()
    const legacy: ServerMessage[] = []
    registry.modules.sessions.attachClient((message) => legacy.push(message))
    const { sessionId } = registry.modules.sessions.createSession({ agentKind: 'shell', cwd: '/w' })
    registry.modules.sessions.flushBroadcasts()
    const originalSession = registry.modules.sessions
      .listSessions()
      .find((s) => s.sessionId === sessionId)
    expect(originalSession).toBeDefined()
    const original = originalSession?.name
    const before = legacy.filter((message) => message.type === 'sessionsChanged').length

    registry.modules.sessions.renameSession({ sessionId, name: 'temporary' })
    registry.modules.sessions.renameSession({ sessionId, name: original ?? '' })
    registry.modules.sessions.flushBroadcasts()

    expect(legacy.filter((message) => message.type === 'sessionsChanged')).toHaveLength(before + 2)
  })

  it('coalesces a resize burst into one async capture and one projection event', () => {
    const registry = makeRegistry()
    const { sessionId } = registry.modules.sessions.createSession({ agentKind: 'shell', cwd: '/w' })
    const clientId = registry.modules.sessions.attachClient(() => {})
    registry.modules.sessions.onClientMessage(clientId, { type: 'attach', sessionId })
    registry.modules.sessions.onClientMessage(clientId, {
      type: 'viewState',
      visible: [sessionId],
      focused: sessionId,
    })
    registry.modules.sessions.flushBroadcasts()

    const events: ProjectionEvent[] = []
    const off = registry.modules.sessions.onSessionProjection((event) => events.push(event))
    const append = vi.spyOn(registry.sessionStore.sync, 'appendChanges')
    for (let i = 0; i < 200; i++) {
      registry.modules.sessions.onClientMessage(clientId, {
        type: 'resize',
        sessionId,
        cols: 100 + i,
        rows: 40 + i,
      })
    }

    expect(append).not.toHaveBeenCalled()
    expect(events).toEqual([])
    registry.modules.sessions.flushBroadcasts()
    expect(append).toHaveBeenCalledTimes(1)
    expect(events).toHaveLength(1)
    expect(events[0]?.changes).toHaveLength(1)
    expect((events[0]?.changes[0] as { value?: SessionMeta }).value?.geometry).toEqual({
      cols: 299,
      rows: 239,
    })
    append.mockRestore()
    off()
  })

  it('retains dirty live-view and machine patches across one append failure', () => {
    const registry = makeRegistry()
    const { sessionId } = registry.modules.sessions.createSession({ agentKind: 'shell', cwd: '/w' })
    registry.modules.machines.ensureLocalMachine('first-host')
    registry.modules.sessions.flushBroadcasts()
    const events: ProjectionEvent[] = []
    const off = registry.modules.sessions.onSessionProjection((event) => events.push(event))
    const sync = registry.sessionStore.sync

    const failAndHeal = (trigger: () => void, assertValue: (value: SessionMeta) => void) => {
      const before = events.length
      const append = vi.spyOn(sync, 'appendChanges').mockImplementationOnce(() => {
        throw new Error('transient session capture failure')
      })
      trigger()
      expect(append).not.toHaveBeenCalled()
      expect(() => registry.modules.sessions.flushBroadcasts()).toThrow(
        'transient session capture failure',
      )
      expect(events).toHaveLength(before)
      append.mockRestore()
      registry.modules.sessions.flushBroadcasts()
      expect(events).toHaveLength(before + 1)
      const change = events.at(-1)?.changes.find((candidate) => candidate.id === sessionId)
      expect(change?.op).toBe('upsert')
      assertValue((change as { value: SessionMeta }).value)
    }

    const firstClient = registry.modules.sessions.attachClient(() => {})
    failAndHeal(
      () => registry.modules.sessions.onClientMessage(firstClient, { type: 'attach', sessionId }),
      (value) => expect(value).toMatchObject({ clientCount: 1, controllerId: firstClient }),
    )
    registry.modules.sessions.onClientMessage(firstClient, {
      type: 'viewState',
      visible: [sessionId],
      focused: sessionId,
    })
    registry.modules.sessions.flushBroadcasts()
    failAndHeal(
      () =>
        registry.modules.sessions.onClientMessage(firstClient, {
          type: 'resize',
          sessionId,
          cols: 123,
          rows: 47,
        }),
      (value) => expect(value.geometry).toEqual({ cols: 123, rows: 47 }),
    )

    const secondClient = registry.modules.sessions.attachClient(() => {})
    failAndHeal(
      () => registry.modules.sessions.onClientMessage(secondClient, { type: 'attach', sessionId }),
      (value) => expect(value.clientCount).toBe(2),
    )
    failAndHeal(
      () =>
        registry.modules.sessions.onClientMessage(secondClient, {
          type: 'requestControl',
          sessionId,
        }),
      (value) => expect(value.controllerId).toBe(secondClient),
    )
    failAndHeal(
      () => registry.modules.sessions.onClientMessage(secondClient, { type: 'detach', sessionId }),
      (value) => expect(value).toMatchObject({ clientCount: 1, controllerId: firstClient }),
    )
    failAndHeal(
      () => registry.modules.machines.renameMachine(LOCAL_MACHINE_ID, 'healed-host'),
      (value) => expect(value.machineName).toBe('healed-host'),
    )
    off()
  })

  it('captures a 588-session disconnect in one retryable batch', () => {
    const registry = makeRegistry()
    const sessionIds = Array.from(
      { length: 588 },
      (_, i) =>
        registry.modules.sessions.createSession({ agentKind: 'shell', cwd: `/w/` }).sessionId,
    )
    const clientId = registry.modules.sessions.attachClient(() => {})
    for (const sessionId of sessionIds) {
      registry.modules.sessions.onClientMessage(clientId, { type: 'attach', sessionId })
    }
    registry.modules.sessions.flushBroadcasts()

    const events: ProjectionEvent[] = []
    const off = registry.modules.sessions.onSessionProjection((event) => events.push(event))
    const append = vi
      .spyOn(registry.sessionStore.sync, 'appendChanges')
      .mockImplementationOnce(() => {
        throw new Error('disconnect batch failed')
      })

    registry.modules.sessions.detachClient(clientId)
    expect(append).not.toHaveBeenCalled()
    expect(() => registry.modules.sessions.flushBroadcasts()).toThrow('disconnect batch failed')
    expect(append).toHaveBeenCalledTimes(1)
    expect(events).toEqual([])

    registry.modules.sessions.flushBroadcasts()
    expect(append).toHaveBeenCalledTimes(2)
    expect(events).toHaveLength(1)
    expect(events[0]?.changes).toHaveLength(588)
    expect(
      events[0]?.changes.every(
        (change) => (change as { value?: SessionMeta }).value?.clientCount === 0,
      ),
    ).toBe(true)
    append.mockRestore()
    off()
  })

  it('rolls back live rename state when the durable append fails', () => {
    const registry = makeRegistry()
    const { sessionId } = registry.modules.sessions.createSession({ agentKind: 'shell', cwd: '/w' })
    registry.modules.sessions.flushBroadcasts()
    const cursor = cursorOf(registry)
    const events: ProjectionEvent[] = []
    registry.modules.sessions.onSessionProjection((event) => events.push(event))
    const append = vi
      .spyOn(registry.sessionStore.sync, 'appendChanges')
      .mockImplementationOnce(() => {
        throw new Error('rename append failed')
      })

    expect(() =>
      registry.modules.sessions.renameSession({ sessionId, name: 'phantom-name' }),
    ).toThrow('rename append failed')
    append.mockRestore()
    expect(
      registry.modules.sessions.listSessions().find((s) => s.sessionId === sessionId)?.name,
    ).toBeUndefined()
    expect(
      registry.sessionStore.sessions.loadSessions().find((row) => row.id === sessionId)?.name,
    ).toBeNull()
    expect(cursorOf(registry)).toBe(cursor)
    expect(events).toEqual([])

    registry.modules.sessions.broadcastSessions()
    registry.modules.sessions.flushBroadcasts()
    expect(
      registry.modules.sessions.listSessions().find((s) => s.sessionId === sessionId)?.name,
    ).toBeUndefined()
    expect(registry.modules.sessions.syncChangesSince(cursor)).toEqual({
      kind: 'delta',
      cursor,
      changes: [],
    })

    registry.modules.sessions.renameSession({ sessionId, name: 'committed-name' })
    expect(events).toHaveLength(1)
    expect(events[0]?.changes).toHaveLength(1)
    expect((events[0]?.changes[0] as { value?: SessionMeta }).value?.name).toBe('committed-name')
  })

  it('rolls back live and SQLite snooze state when the durable append fails', () => {
    const registry = makeRegistry()
    const { sessionId } = registry.modules.sessions.createSession({ agentKind: 'shell', cwd: '/w' })
    registry.modules.sessions.flushBroadcasts()
    const cursor = cursorOf(registry)
    const events: ProjectionEvent[] = []
    registry.modules.sessions.onSessionProjection((event) => events.push(event))
    const append = vi
      .spyOn(registry.sessionStore.sync, 'appendChanges')
      .mockImplementationOnce(() => {
        throw new Error('snooze append failed')
      })

    expect(() =>
      registry.modules.sessions.setSnooze({ sessionId, until: '2026-07-20T12:00:00.000Z' }),
    ).toThrow('snooze append failed')
    append.mockRestore()
    expect(
      registry.modules.sessions.listSessions().find((s) => s.sessionId === sessionId)?.snoozedUntil,
    ).toBeUndefined()
    expect(registry.sessionStore.sessions.listSnoozes()).not.toHaveProperty(sessionId)
    expect(cursorOf(registry)).toBe(cursor)
    expect(events).toEqual([])

    registry.modules.sessions.broadcastSessions()
    registry.modules.sessions.flushBroadcasts()
    expect(
      registry.modules.sessions.listSessions().find((s) => s.sessionId === sessionId)?.snoozedUntil,
    ).toBeUndefined()
    expect(registry.modules.sessions.syncChangesSince(cursor)).toEqual({
      kind: 'delta',
      cursor,
      changes: [],
    })

    registry.modules.sessions.setSnooze({
      sessionId,
      until: '2026-07-20T12:00:00.000Z',
    })
    expect(events).toHaveLength(1)
    expect(events[0]?.changes).toHaveLength(1)
    expect((events[0]?.changes[0] as { value?: SessionMeta }).value?.snoozedUntil).toBe(
      '2026-07-20T12:00:00.000Z',
    )
  })

  it.each([
    ['legacy', null, false],
    ['causal nonterminal', { checkpoint: { terminalFence: null } }, false],
    ['causal terminal', { checkpoint: { terminalFence: { turnEpoch: 1 } } }, true],
  ] as const)(
    '(exit fence) %s session emits terminal proof only for a durable terminal fence',
    (_name, checkpointRecord, terminalFenceReported) => {
      const registry = makeRegistry()
      const { sessionId } = registry.modules.sessions.createSession({
        agentKind: 'shell',
        cwd: '/w',
      })
      vi.spyOn(registry.sessionStore.observationCheckpoints, 'get').mockReturnValue(
        checkpointRecord as never,
      )

      registry.modules.sessions.killSession({ sessionId })

      const exited = registry.sessionStore.events
        .listEventsSince(0, { kinds: ['session.exited'] })
        .at(-1)
      expect(exited?.subject).toBe(sessionId)
      if (terminalFenceReported) {
        expect(exited?.payload).toMatchObject({ terminalFenceReported: true })
      } else {
        expect(exited?.payload).not.toHaveProperty('terminalFenceReported')
      }
    },
  )

  it('(k) a failed change append on kill leaves the session fully live (#247)', () => {
    const registry = makeRegistry()
    const { sessionId } = registry.modules.sessions.createSession({ agentKind: 'shell', cwd: '/w' })
    registry.modules.sessions.flushBroadcasts()
    const cursor = cursorOf(registry)
    const spy = vi.spyOn(registry.sessionStore.sync, 'appendChanges').mockImplementationOnce(() => {
      throw new Error('append failed')
    })
    expect(() => registry.modules.sessions.killSession({ sessionId })).toThrow('append failed')
    spy.mockRestore()
    // Memory truth survived: the session is still listed; the store rolled the
    // tombstone write back inside the same transact span.
    expect(registry.modules.sessions.listSessions().some((s) => s.sessionId === sessionId)).toBe(
      true,
    )
    expect(registry.sessionStore.sessions.loadSessions().some((r) => r.id === sessionId)).toBe(true)
    expect(registry.sessionStore.sessions.loadDeletedSessions()).toEqual([])
    // A subsequent broadcast is snapshot-only and appends NOTHING for the untouched entity.
    registry.modules.sessions.broadcastSessions()
    registry.modules.sessions.flushBroadcasts()
    const healed = registry.modules.sessions.syncChangesSince(cursor)
    expect(healed.kind).toBe('delta')
    if (healed.kind !== 'delta') return
    expect(healed.changes.filter((c) => c.entity === 'session')).toEqual([])
    // And the kill still works once the append path recovers.
    registry.modules.sessions.killSession({ sessionId })
    expect(registry.modules.sessions.listSessions().some((s) => s.sessionId === sessionId)).toBe(
      false,
    )
    expect(registry.sessionStore.sessions.loadDeletedSessions()).toEqual([
      expect.objectContaining({ id: sessionId, deletionSource: 'standalone' }),
    ])
  })

  it('(l) a transient issue-append failure during a session-driven broadcast is retried by the NEXT broadcast (#247)', () => {
    const registry = makeRegistry()
    // An issue whose wire embeds the session (SessionMeta[] member data) — so an
    // issue-RELEVANT session field change (workState) changes the ISSUE wire too,
    // via the broadcast-tail publishIssues() reconcile, with no issue write of its
    // own. (A bare attach moves only clientCount, which POD-722 excludes from the
    // issue republish, so it deliberately would NOT drive this path — see
    // modules/sessions/broadcast-issue-skip.test.ts.)
    const issue = registry.issues.create({ repoPath: '/r', title: 'watched', startNow: false })
    const { sessionId } = registry.modules.sessions.createSession({
      agentKind: 'shell',
      cwd: '/w',
      issueId: issue.id,
    })
    registry.modules.sessions.flushBroadcasts()
    const cursor = cursorOf(registry)
    // Fail ONLY issue-entity appends: the persist-owned session capture (workState
    // flip) must land, then publishIssues()' issue reconcile throws — Codex's
    // scenario. Before the fix the byte-skip cache was already stamped, so every
    // later same-bytes broadcast early-returned and the embedded issue snapshot
    // stayed stale FOREVER.
    const sync = registry.sessionStore.sync
    const realAppend = sync.appendChanges.bind(sync)
    const spy = vi.spyOn(sync, 'appendChanges').mockImplementation((rows, eventTime) => {
      if (rows.some((r) => r.entity === 'issue')) throw new Error('transient issue append failure')
      return realAppend(rows, eventTime)
    })
    expect(() =>
      registry.modules.sessions.setWorkState({ sessionId, workState: 'testing' }),
    ).toThrow('transient issue append failure')
    spy.mockRestore()
    // The failed broadcast recorded the SESSION flip but no issue change yet.
    const partial = registry.modules.sessions.syncChangesSince(cursor)
    expect(partial.kind).toBe('delta')
    if (partial.kind !== 'delta') return
    expect(partial.changes.some((c) => c.entity === 'issue')).toBe(false)
    // Next broadcast carries the SAME session bytes — before the fix the stamped
    // byte-skip cache early-returned here and the issue snapshot never converged.
    registry.modules.sessions.broadcastSessions()
    registry.modules.sessions.flushBroadcasts()
    const healed = registry.modules.sessions.syncChangesSince(cursor)
    expect(healed.kind).toBe('delta')
    if (healed.kind !== 'delta') return
    const issueChange = healed.changes.find(
      (c) => c.entity === 'issue' && c.id === issue.id && c.op === 'upsert',
    ) as { value?: { sessions?: Array<{ workState?: string }> } } | undefined
    expect(issueChange?.value?.sessions?.[0]?.workState).toBe('testing')
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
