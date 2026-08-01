import { FIRST_ADMIN_USER_ID, SOLE_USER_ID, asSessionId, type SessionMeta } from '@podium/model'
import { WIRE_VERSION, type MetadataChange, type ServerMessage } from '@podium/protocol'
import { Ledger } from '@podium/sync'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { LOCAL_MACHINE_ID } from '@podium/runtime/local-machine'
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
    const id = registry.clientGateway.attachClient((msg) => inbox.push(msg))
    registry.clientGateway.routeClientFrame(id, {
      type: 'hello',
      clientId: '',
      wireVersion: WIRE_VERSION,
      viewport: { cols: 80, rows: 24, dpr: 1 },
      caps: ['metadataDelta'],
    })
    return { inbox }
  }

  const batches = (inbox: ServerMessage[]): { seq: number; changes: MetadataChange[] }[] =>
    inbox.flatMap((m) => {
      if (m.type === 'metadataDelta') return [m]
      if (m.type !== 'feedDelta') return []
      return [{
        seq: m.seq,
        changes: m.changes
          .filter((change) => change.op !== 'evict')
          .map((change) => ({ ...change, id: change.entityId }) as MetadataChange),
      }]
    })

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
            id: asSessionId('s-atomic'),
            ownerUserId: FIRST_ADMIN_USER_ID,
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
    registry.gateway.routeDaemonFrame('m1', {
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
    registry.gateway.routeDaemonFrame('m1', {
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
    expect(received.length).toBeGreaterThanOrEqual(2)
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
    registry.gateway.attachDaemon(LOCAL_MACHINE_ID, () => {})
    registry.modules.sessions.flushBroadcasts()
    const cursor = cursorOf(registry)
    // The disconnect sweep flips live/starting → 'reconnecting' with NO persist;
    // the disconnect seam captures the touched sessions as one explicit batch.
    registry.gateway.detachDaemon(LOCAL_MACHINE_ID)
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
    const clientId = registry.clientGateway.attachClient(() => {})
    registry.clientGateway.routeClientFrame(clientId, { type: 'attach', sessionId })
    registry.clientGateway.routeClientFrame(clientId, {
      type: 'viewState',
      visible: [sessionId],
      focused: sessionId,
    })
    registry.clientGateway.routeClientFrame(clientId, {
      type: 'resize',
      sessionId,
      cols: 100,
      rows: 40,
    })
    registry.clientGateway.routeClientFrame(clientId, { type: 'detach', sessionId })
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
  })

  it('emits ordered self-contained projection events for persist and every live-view seam', () => {
    const registry = makeRegistry()
    const events: ProjectionEvent[] = []
    const off = registry.modules.sessions.onSessionProjection((event) => events.push(event))
    const { sessionId } = registry.modules.sessions.createSession({ agentKind: 'shell', cwd: '/w' })
    const afterCreate = registry.modules.sessions.sessionsGeneration()

    registry.gateway.routeDaemonFrame('m1', {
      type: 'agentState',
      sessionId,
      state: { phase: 'working', since: '2026-07-10T00:00:00.000Z', nativeSubagentCount: 0 },
    })
    const afterPersist = registry.modules.sessions.sessionsGeneration()

    const clientId = registry.clientGateway.attachClient(() => {})
    registry.clientGateway.routeClientFrame(clientId, { type: 'attach', sessionId })
    registry.modules.sessions.flushBroadcasts()
    const afterAttach = registry.modules.sessions.sessionsGeneration()
    registry.clientGateway.routeClientFrame(clientId, {
      type: 'viewState',
      visible: [sessionId],
      focused: sessionId,
    })
    registry.clientGateway.routeClientFrame(clientId, {
      type: 'resize',
      sessionId,
      cols: 110,
      rows: 42,
    })
    registry.modules.sessions.flushBroadcasts()
    const afterResize = registry.modules.sessions.sessionsGeneration()
    const secondClientId = registry.clientGateway.attachClient(() => {})
    registry.clientGateway.routeClientFrame(secondClientId, { type: 'attach', sessionId })
    registry.modules.sessions.flushBroadcasts()
    const afterSecondAttach = registry.modules.sessions.sessionsGeneration()
    registry.clientGateway.routeClientFrame(secondClientId, { type: 'requestControl', sessionId })
    registry.modules.sessions.flushBroadcasts()
    const afterControl = registry.modules.sessions.sessionsGeneration()
    // A no-op repeat must not fabricate work.
    const eventCountBeforeNoop = events.length
    registry.clientGateway.routeClientFrame(secondClientId, { type: 'requestControl', sessionId })
    registry.modules.sessions.flushBroadcasts()
    expect(events).toHaveLength(eventCountBeforeNoop)
    registry.clientGateway.routeClientFrame(secondClientId, { type: 'detach', sessionId })
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
    const clientId = first.clientGateway.attachClient(() => {})
    first.clientGateway.routeClientFrame(clientId, { type: 'attach', sessionId })
    first.clientGateway.routeClientFrame(clientId, {
      type: 'viewState',
      visible: [sessionId],
      focused: sessionId,
    })
    first.clientGateway.routeClientFrame(clientId, {
      type: 'resize',
      sessionId,
      cols: 101,
      rows: 37,
    })
    first.clientGateway.routeClientFrame(clientId, { type: 'detach', sessionId })
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
    expect(second.modules.sessions.syncChangesSince(cursorAfterRecovery)).toMatchObject({
      kind: 'delta',
      cursor: cursorAfterRecovery,
      changes: [],
    })
    expect(second.modules.sessions.listSessions()[0]).not.toHaveProperty('generation')
    expect(second.modules.sessions.listSessions()[0]).not.toHaveProperty('revision')
  })

  it('publishes the final state when coalesced changes revert to identical bytes', () => {
    const registry = makeRegistry()
    const current = deltaClient(registry)
    const { sessionId } = registry.modules.sessions.createSession({ agentKind: 'shell', cwd: '/w' })
    registry.modules.sessions.flushBroadcasts()
    const originalSession = registry.modules.sessions
      .listSessions()
      .find((session) => session.sessionId === sessionId)
    expect(originalSession).toBeDefined()
    const original = originalSession?.name
    current.inbox.length = 0
    const cursorBefore = registry.modules.sessions.syncChangesSince(null).cursor

    registry.modules.sessions.renameSession({ sessionId, name: 'temporary' })
    registry.modules.sessions.renameSession({ sessionId, name: original ?? '' })
    registry.modules.sessions.flushBroadcasts()

    const projected = sessionChanges(current.inbox).filter(
      (change) => change.id === sessionId && change.op === 'upsert',
    )
    expect(projected.length).toBeGreaterThan(0)
    expect((projected.at(-1)?.value as SessionMeta | undefined)?.name).toBe(original)
    const renames = registry.modules.sessions.syncChangesSince(cursorBefore)
    expect(renames.kind).toBe('delta')
    expect(renames.kind === 'delta' ? renames.changes.length : 0).toBeGreaterThanOrEqual(2)
  })


  it('coalesces a resize burst into one async capture and one projection event', () => {
    const registry = makeRegistry()
    const { sessionId } = registry.modules.sessions.createSession({ agentKind: 'shell', cwd: '/w' })
    const clientId = registry.clientGateway.attachClient(() => {})
    registry.clientGateway.routeClientFrame(clientId, { type: 'attach', sessionId })
    registry.clientGateway.routeClientFrame(clientId, {
      type: 'viewState',
      visible: [sessionId],
      focused: sessionId,
    })
    registry.modules.sessions.flushBroadcasts()

    const events: ProjectionEvent[] = []
    const off = registry.modules.sessions.onSessionProjection((event) => events.push(event))
    const append = vi.spyOn(registry.sessionStore.sync, 'appendChanges')
    for (let i = 0; i < 200; i++) {
      registry.clientGateway.routeClientFrame(clientId, {
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

    const firstClient = registry.clientGateway.attachClient(() => {})
    failAndHeal(
      () => registry.clientGateway.routeClientFrame(firstClient, { type: 'attach', sessionId }),
      (value) => expect(value).toMatchObject({ clientCount: 1, controllerId: firstClient }),
    )
    registry.clientGateway.routeClientFrame(firstClient, {
      type: 'viewState',
      visible: [sessionId],
      focused: sessionId,
    })
    registry.modules.sessions.flushBroadcasts()
    failAndHeal(
      () =>
        registry.clientGateway.routeClientFrame(firstClient, {
          type: 'resize',
          sessionId,
          cols: 123,
          rows: 47,
        }),
      (value) => expect(value.geometry).toEqual({ cols: 123, rows: 47 }),
    )

    const secondClient = registry.clientGateway.attachClient(() => {})
    failAndHeal(
      () => registry.clientGateway.routeClientFrame(secondClient, { type: 'attach', sessionId }),
      (value) => expect(value.clientCount).toBe(2),
    )
    failAndHeal(
      () =>
        registry.clientGateway.routeClientFrame(secondClient, {
          type: 'requestControl',
          sessionId,
        }),
      (value) => expect(value.controllerId).toBe(secondClient),
    )
    failAndHeal(
      () => registry.clientGateway.routeClientFrame(secondClient, { type: 'detach', sessionId }),
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
    const clientId = registry.clientGateway.attachClient(() => {})
    for (const sessionId of sessionIds) {
      registry.clientGateway.routeClientFrame(clientId, { type: 'attach', sessionId })
    }
    registry.modules.sessions.flushBroadcasts()

    const events: ProjectionEvent[] = []
    const off = registry.modules.sessions.onSessionProjection((event) => events.push(event))
    const append = vi
      .spyOn(registry.sessionStore.sync, 'appendChanges')
      .mockImplementationOnce(() => {
        throw new Error('disconnect batch failed')
      })

    registry.clientGateway.detachClient(clientId)
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
    expect(registry.modules.sessions.syncChangesSince(cursor)).toMatchObject({
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

    // A FUTURE deadline. It was a fixed past date and still produced a change to
    // append, because the projection read a never-lapsing `snoozedUntil` MIRROR on
    // the live session. POD-1076 deleted the mirror; the projection reads the
    // `snoozes` table, which prunes lapsed timed snoozes on read, so a past
    // deadline now yields NO wire change, the ledger's byte-dedup drops it, and
    // `appendChanges` is never reached — the append could not fail because there
    // was nothing to append. The rollback behaviour under test is unchanged.
    expect(() =>
      registry.modules.sessions.setSnooze({
        userId: SOLE_USER_ID,
        sessionId,
        until: '2999-07-20T12:00:00.000Z',
      }),
    ).toThrow('snooze append failed')
    append.mockRestore()
    expect(
      registry.modules.sessions.listSessions().find((s) => s.sessionId === sessionId)?.snoozedUntil,
    ).toBeUndefined()
    expect(registry.sessionStore.sessions.listSnoozes(SOLE_USER_ID)).not.toHaveProperty(sessionId)
    expect(cursorOf(registry)).toBe(cursor)
    expect(events).toEqual([])

    registry.modules.sessions.broadcastSessions()
    registry.modules.sessions.flushBroadcasts()
    expect(
      registry.modules.sessions.listSessions().find((s) => s.sessionId === sessionId)?.snoozedUntil,
    ).toBeUndefined()
    expect(registry.modules.sessions.syncChangesSince(cursor)).toMatchObject({
      kind: 'delta',
      cursor,
      changes: [],
    })

    // Same future deadline as the failed attempt, for the same reason: a lapsed
    // timed snooze is pruned on read and would produce no change to project.
    registry.modules.sessions.setSnooze({
      userId: SOLE_USER_ID,
      sessionId,
      until: '2999-07-20T12:00:00.000Z',
    })
    expect(events).toHaveLength(1)
    expect(events[0]?.changes).toHaveLength(1)
    expect((events[0]?.changes[0] as { value?: SessionMeta }).value?.snoozedUntil).toBe(
      '2999-07-20T12:00:00.000Z',
    )
  })

  it.each([
    ['legacy', null, false],
    ['causal nonterminal', { checkpoint: { terminalFence: null } }, false],
    [
      'causal terminal without matching candidate',
      { checkpoint: { terminalFence: { turnEpoch: 1 } } },
      false,
    ],
  ] as const)('(exit fence) %s session emits terminal proof only for a durable terminal fence', (_name, checkpointRecord, terminalFenceReported) => {
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
  })

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

  // POD-797: deleted the session-derived issue append retry test with the wire path it exercised.
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

  /**
   * AC4 of POD-366: the store/live -> wire mapping is ONE function. `sessionWire()`
   * has always documented that "the committed payload and the legacy snapshot rows
   * must agree byte-for-byte or the ledger's dedup and the clients' replicas would
   * diverge" — but `listSessions()` restated its body character-for-character and
   * NOTHING asserted the agreement. POD-366 made listSessions call the one mapper;
   * this test is what makes that structural rather than a comment.
   *
   * Why it is here rather than a values check on one field: mutating the mapper's
   * `machineName` stamp broke no test in the sessions or relay suites, so the
   * invariant was genuinely uncovered. A surviving mutant is the reason this exists.
   */
  it('(i) listSessions and the broadcast payload come from the ONE wire mapper [POD-366]', () => {
    const registry = makeRegistry()
    const cursor = cursorOf(registry)
    const { sessionId } = registry.modules.sessions.createSession({
      agentKind: 'claude-code',
      cwd: '/w',
      spawnedBy: 'user',
    })
    registry.modules.sessions.flushBroadcasts()

    const listed = registry.modules.sessions.listSessions().find((s) => s.sessionId === sessionId)
    expect(listed).toBeDefined()

    const after = registry.modules.sessions.syncChangesSince(cursor)
    expect(after.kind).toBe('delta')
    if (after.kind !== 'delta') return
    const broadcast = (
      after.changes.find(
        (c) => c.entity === 'session' && c.id === sessionId && c.op === 'upsert',
      ) as { value?: SessionMeta } | undefined
    )?.value
    expect(broadcast).toBeDefined()

    // The whole payload, not a chosen field: a per-field assertion would go stale
    // the moment the mapper gains a key, which is exactly the drift being deleted.
    expect(listed).toEqual(broadcast)

    // And pin the stamp the mapper owns, so mutating it inside sessionWire() is a
    // kill rather than a survivor. Resolved against the session's OWN machineId:
    // a freshly created session sits on the '__local__' placeholder until a real
    // machine adopts it, not on LOCAL_MACHINE_ID — asserting the latter is what
    // this test got wrong on its first run.
    expect(listed?.machineName).toBe(registry.modules.machines.machineName(listed?.machineId ?? ''))
    expect(listed?.machineName).not.toBe(undefined)
  })
})

/**
 * Feed identity on the wire (ADR 2 D1/D5) at the REAL registry, so these pin the
 * production wiring rather than a stub: what `sync.changesSince` actually
 * returns, and what a delta client actually receives.
 */
describe('feed identity on the wire (ADR 2 D1/D5)', () => {
  const registries: SessionRegistry[] = []
  afterEach(() => {
    for (const r of registries.splice(0)) r.dispose()
  })

  function makeRegistry(): SessionRegistry {
    const registry = new SessionRegistry()
    registries.push(registry)
    return registry
  }

  /** A client whose hello advertises exactly `caps`. */
  function client(registry: SessionRegistry, caps: string[]): { inbox: ServerMessage[] } {
    const inbox: ServerMessage[] = []
    const id = registry.clientGateway.attachClient((msg) => inbox.push(msg))
    registry.clientGateway.routeClientFrame(id, {
      type: 'hello',
      clientId: '',
      wireVersion: WIRE_VERSION,
      viewport: { cols: 80, rows: 24, dpr: 1 },
      caps,
    })
    return { inbox }
  }

  const deltas = (inbox: ServerMessage[]) =>
    inbox.flatMap((m) => (m.type === 'feedDelta' ? [m] : []))

  it('(c) the bootstrap snapshot carries feedId, epoch and minAvailableSeq', () => {
    // The snapshot arm needs the identity MOST: every rung of the D7 healing
    // ladder terminates in a re-bootstrap, and this is where a replica learns
    // which generation it landed on.
    const registry = makeRegistry()
    // One append first, exactly as the two cases below do. `minAvailableSeq` is
    // the FIRST SERVABLE SEQ, so on an empty log it is honestly 0 and the `>= 1`
    // check would be asserting that the log is non-empty rather than that the
    // floor is published. Seeding makes the floor a real one.
    registry.modules.sessions.createSession({ agentKind: 'shell', cwd: '/w' })
    const boot = registry.modules.sessions.syncChangesSince(null)
    expect(boot.kind).toBe('snapshot')
    expect(boot.feedId).toBeTruthy()
    expect(boot.epoch).toBeTruthy()
    expect(boot.feedId).not.toBe(boot.epoch)
    expect(boot.minAvailableSeq).toBeGreaterThanOrEqual(1)
  })

  it('(c) the delta arm carries the SAME identity as the snapshot arm', () => {
    // One authority, one feed: a client that bootstraps and then catches up must
    // not see the identity change under it, or it would re-bootstrap forever.
    const registry = makeRegistry()
    const boot = registry.modules.sessions.syncChangesSince(null)
    registry.modules.sessions.createSession({ agentKind: 'shell', cwd: '/w' })
    const catchUp = registry.modules.sessions.syncChangesSince(boot.cursor)
    expect(catchUp.kind).toBe('delta')
    expect(catchUp.feedId).toBe(boot.feedId)
    expect(catchUp.epoch).toBe(boot.epoch)
    expect(catchUp.minAvailableSeq).toBeGreaterThanOrEqual(1)
  })

  it('publishes minAvailableSeq consistently with what it will actually serve', () => {
    const registry = makeRegistry()
    registry.modules.sessions.createSession({ agentKind: 'shell', cwd: '/w' })
    const reply = registry.modules.sessions.syncChangesSince(null)
    const horizon = reply.minAvailableSeq as number
    // Nothing has been pruned, so the whole log is servable and the horizon is
    // the log's first seq — a replica at cursor 0 must NOT be told to re-bootstrap.
    expect(horizon).toBe(1)
    expect(registry.modules.sessions.syncChangesSince(0).kind).toBe('delta')
  })

  it('serves identity on every production wire-v2 delta', () => {
    const registry = makeRegistry()
    const asked = client(registry, ['metadataDelta', 'syncFeedIdentity'])
    const baseline = client(registry, ['metadataDelta'])
    asked.inbox.length = 0
    baseline.inbox.length = 0

    registry.modules.sessions.createSession({ agentKind: 'shell', cwd: '/w' })
    registry.modules.funnel.flushDeltas()

    const mine = deltas(asked.inbox)
    const theirs = deltas(baseline.inbox)
    expect(mine.length).toBeGreaterThan(0)
    expect(theirs.length).toBe(mine.length)
    for (const frame of [mine[0], theirs[0]]) {
      expect(Object.keys(frame ?? {}).sort()).toEqual([
        'changes',
        'epoch',
        'feedId',
        'fromSeq',
        'minAvailableSeq',
        'seq',
        'type',
      ])
    }

    const identity = registry.modules.sessions.syncChangesSince(null)
    expect(identity.feedId).toBeTruthy()
    expect(identity.epoch).toBeTruthy()
  })


  it('both clients receive the SAME changes in the SAME order — the cap changes the envelope, never the feed', () => {
    const registry = makeRegistry()
    const withIdentity = client(registry, ['metadataDelta', 'syncFeedIdentity'])
    const legacy = client(registry, ['metadataDelta'])
    withIdentity.inbox.length = 0
    legacy.inbox.length = 0

    registry.modules.sessions.createSession({ agentKind: 'shell', cwd: '/w' })
    registry.modules.funnel.flushDeltas()
    registry.modules.sessions.createSession({ agentKind: 'shell', cwd: '/w' })
    registry.modules.funnel.flushDeltas()

    const strip = (m: ServerMessage[]) => deltas(m).map((d) => ({ seq: d.seq, changes: d.changes }))
    expect(strip(withIdentity.inbox)).toEqual(strip(legacy.inbox))
  })
})
