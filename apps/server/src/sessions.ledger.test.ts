import {
  asMachineId,
  asSessionId,
  asUserId,
  FIRST_ADMIN_USER_ID,
  type SessionMeta,
  SOLE_USER_ID,
} from '@podium/model'
import { type MetadataChange, type ServerMessage, WIRE_VERSION } from '@podium/protocol'
import { Ledger } from '@podium/sync'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SessionRegistry } from './relay'
import type { SessionStore } from './store'
import { attachTestClient } from './test-support/client-transport'
import { openTestStore } from './test-support/open-test-store'

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
  afterEach(async () => {
    for (const r of registries.splice(0)) await r.dispose()
  })

  async function makeRegistry(store?: SessionStore): Promise<SessionRegistry> {
    const registry = await SessionRegistry.create(store, undefined, { instanceId: 'default' })
    registries.push(registry)
    return registry
  }

  function deltaClient(registry: SessionRegistry): { inbox: ServerMessage[] } {
    const inbox: ServerMessage[] = []
    const id = attachTestClient(registry.clientGateway, (msg) => inbox.push(msg))
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
      return [
        {
          seq: m.seq,
          changes: m.changes
            .filter((change) => change.op !== 'evict')
            .map((change) => ({ ...change, id: change.entityId }) as MetadataChange),
        },
      ]
    })

  const sessionChanges = (inbox: ServerMessage[]): MetadataChange[] =>
    batches(inbox)
      .flatMap((b) => b.changes)
      .filter((c) => c.entity === 'session')

  const cursorOf = async (registry: SessionRegistry): Promise<number> => {
    const boot = await registry.modules.sessions.syncChangesSince(null)
    return boot.cursor
  }

  it('(a) a throw between the row write and the change append rolls BOTH back', async () => {
    const store = await openTestStore(':memory:')
    const ledger = new Ledger({
      repo: store.sync,
      now: () => 1_000,
      transact: async (fn) => await store.transact(fn),
    })
    const cursorBefore = await ledger.cursor()
    expect(() =>
      ledger.commit({
        write: async () =>
          await store.sessions.upsertSession({
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
            machineId: asMachineId('m1'),
            headless: false,
            issueId: null,
          }),
        changes: () => {
          throw new Error('declaration failed')
        },
      }),
    ).toThrow('declaration failed')
    // The session row write inside the same transact span rolled back too.
    expect((await store.sessions.loadSessions()).find((r) => r.id === 's-atomic')).toBeUndefined()
    expect(await ledger.cursor()).toBe(cursorBefore)
  })

  it('(b) an agentState persist yields a durable ledger change (the staleness-gap fix)', async () => {
    const registry = await makeRegistry()
    const { sessionId } = await registry.modules.sessions.createSession({ agentKind: 'shell', cwd: '/w' })
    const cursor = await cursorOf(registry)
    registry.gateway.routeDaemonFrame('m1', {
      type: 'agentState',
      sessionId,
      state: { phase: 'working', since: '2026-07-09T00:00:00.000Z', nativeSubagentCount: 0 },
    })
    const healed = await registry.modules.sessions.syncChangesSince(cursor)
    expect(healed.kind).toBe('delta')
    if (healed.kind !== 'delta') return
    const change = healed.changes.find(
      (c) => c.entity === 'session' && c.id === sessionId && c.op === 'upsert',
    ) as { value?: SessionMeta } | undefined
    expect(change?.value?.agentState?.phase).toBe('working')
  })

  it('(b2) a title persist yields a durable ledger change', async () => {
    const registry = await makeRegistry()
    const { sessionId } = await registry.modules.sessions.createSession({ agentKind: 'shell', cwd: '/w' })
    const cursor = await cursorOf(registry)
    registry.gateway.routeDaemonFrame('m1', {
      type: 'title',
      sessionId,
      title: 'a real durable title',
    })
    const healed = await registry.modules.sessions.syncChangesSince(cursor)
    expect(healed.kind).toBe('delta')
    if (healed.kind !== 'delta') return
    const change = healed.changes.find(
      (c) => c.entity === 'session' && c.id === sessionId && c.op === 'upsert',
    ) as { value?: SessionMeta } | undefined
    expect(change?.value?.title).toBe('a real durable title')
  })

  it('(c) session and issue commits interleave onto delta clients in seq order with no gaps', async () => {
    const registry = await makeRegistry()
    const delta = deltaClient(registry)
    const before = delta.inbox.length
    const { sessionId } = await registry.modules.sessions.createSession({ agentKind: 'shell', cwd: '/w' })
    await registry.issues.create({ repoPath: '/r', title: 'interleaved', startNow: false })
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

  it('(d) one appended batch reaches a delta client exactly once (no double emission via publishComputed)', async () => {
    const registry = await makeRegistry()
    const delta = deltaClient(registry)
    const before = delta.inbox.length
    const { sessionId } = await registry.modules.sessions.createSession({ agentKind: 'shell', cwd: '/w' })
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

  it('(e) kill commits a remove in the same transaction as the row tombstone', async () => {
    const registry = await makeRegistry()
    const { sessionId } = await registry.modules.sessions.createSession({ agentKind: 'shell', cwd: '/w' })
    const cursor = await cursorOf(registry)
    const delta = deltaClient(registry)
    const before = delta.inbox.length
    await registry.modules.sessions.killSession({ sessionId })
    registry.modules.sessions.flushBroadcasts()
    // Durable: the remove is in the log…
    const healed = await registry.modules.sessions.syncChangesSince(cursor)
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
    expect(await registry.sessionStore.sessions.loadSessions()).toHaveLength(0)
    expect(await registry.sessionStore.sessions.loadDeletedSessions()).toEqual([
      expect.objectContaining({
        id: sessionId,
        deletionSource: 'standalone',
        deletedByIssueId: null,
      }),
    ])
  })

  it('(f) boot reconcile records offline row changes durably, with no fan-out', async () => {
    const store = await openTestStore(':memory:')
    const first = await SessionRegistry.create(store, undefined, { instanceId: 'default' })
    const { sessionId } = await first.modules.sessions.createSession({ agentKind: 'shell', cwd: '/w' })
    await first.dispose()
    const cursor = (await first.modules.sessions.syncChangesSince(null)).cursor
    // Offline mutation: rename the row behind the server's back.
    const row = (await store.sessions.loadSessions()).find((r) => r.id === sessionId)
    if (!row) throw new Error('row missing')
    await store.sessions.upsertSession({ ...row, name: 'changed offline' })
    // Restart over the same store: loadFromStore reconciles against the ledger.
    const second = await makeRegistry(store)
    const healed = await second.modules.sessions.syncChangesSince(cursor)
    expect(healed.kind).toBe('delta')
    if (healed.kind !== 'delta') return
    const change = healed.changes.find(
      (c) => c.entity === 'session' && c.id === sessionId && c.op === 'upsert',
    ) as { value?: SessionMeta } | undefined
    expect(change?.value?.name).toBe('changed offline')
  })

  it('(g) a reentrant ledger commit during oplog.appended cannot reorder the delta stream (#247)', async () => {
    const registry = await makeRegistry()
    const a = await registry.modules.sessions.createSession({ agentKind: 'shell', cwd: '/w1' })
    const b = await registry.modules.sessions.createSession({ agentKind: 'shell', cwd: '/w2' })
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

  it('(i) startup adoption and a machine rename re-capture machineId/machineName (#247)', async () => {
    const registry = await makeRegistry()
    const { sessionId } = await registry.modules.sessions.createSession({ agentKind: 'shell', cwd: '/w' })
    registry.modules.sessions.flushBroadcasts()
    const cursor = await cursorOf(registry)
    // The session was created ON this host already (POD-318: no placeholder, no
    // adoption). What `ensureHostMachine` changes is the machine ROW's name, and the
    // machine seam captures the derived machineName flip WITHOUT a session persist.
    const host = registry.modules.machines.hostMachineId
    await registry.modules.machines.ensureHostMachine('adopting-host')
    registry.modules.sessions.flushBroadcasts()
    const afterAdopt = await registry.modules.sessions.syncChangesSince(cursor)
    expect(afterAdopt.kind).toBe('delta')
    if (afterAdopt.kind !== 'delta') return
    const adopted = afterAdopt.changes.find(
      (c) => c.entity === 'session' && c.id === sessionId && c.op === 'upsert',
    ) as { value?: SessionMeta } | undefined
    expect(adopted?.value?.machineId).toBe(host)
    expect(adopted?.value?.machineName).toBe('adopting-host')
    // Rename: machineName is stamped at wire time, no session row changes.
    await registry.modules.machines.renameMachine(host, 'renamed-host')
    registry.modules.sessions.flushBroadcasts()
    const afterRename = await registry.modules.sessions.syncChangesSince(afterAdopt.cursor)
    expect(afterRename.kind).toBe('delta')
    if (afterRename.kind !== 'delta') return
    const renamed = afterRename.changes.find(
      (c) => c.entity === 'session' && c.id === sessionId && c.op === 'upsert',
    ) as { value?: SessionMeta } | undefined
    expect(renamed?.value?.machineName).toBe('renamed-host')
    // Revoke: deleting the machine row changes the derived name to its id fallback.
    await registry.modules.machines.revokeMachine(host)
    registry.modules.sessions.flushBroadcasts()
    const afterRevoke = await registry.modules.sessions.syncChangesSince(afterRename.cursor)
    expect(afterRevoke.kind).toBe('delta')
    if (afterRevoke.kind !== 'delta') return
    const revoked = afterRevoke.changes.find(
      (c) => c.entity === 'session' && c.id === sessionId && c.op === 'upsert',
    ) as { value?: SessionMeta } | undefined
    expect(revoked?.value?.machineName).toBe(host)
  })

  it('(j) the daemon-disconnect reconnecting flip reaches the durable log (#247)', async () => {
    const registry = await makeRegistry()
    const { sessionId } = await registry.modules.sessions.createSession({ agentKind: 'shell', cwd: '/w' })
    // The host daemon attaches under the id the session is already attributed to.
    const host = registry.modules.machines.hostMachineId
    registry.gateway.attachDaemon(host, () => {})
    registry.modules.sessions.flushBroadcasts()
    const cursor = await cursorOf(registry)
    // The disconnect sweep flips live/starting → 'reconnecting' with NO persist;
    // the disconnect seam captures the touched sessions as one explicit batch.
    registry.gateway.detachDaemon(host)
    registry.modules.sessions.flushBroadcasts()
    const healed = await registry.modules.sessions.syncChangesSince(cursor)
    expect(healed.kind).toBe('delta')
    if (healed.kind !== 'delta') return
    const flipped = healed.changes.find(
      (c) => c.entity === 'session' && c.id === sessionId && c.op === 'upsert',
    ) as { value?: SessionMeta } | undefined
    expect(flipped?.value?.status).toBe('reconnecting')
  })

  it('retires full-world session reconcile after boot while keeping every owning seam durable', async () => {
    const reconcile = vi.spyOn(Ledger.prototype, 'reconcile')
    const registry = await makeRegistry()
    reconcile.mockClear()

    const { sessionId } = await registry.modules.sessions.createSession({ agentKind: 'shell', cwd: '/w' })
    const clientId = attachTestClient(registry.clientGateway, () => {})
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
    const changes = await registry.modules.sessions.syncChangesSince(0)
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

  it('emits ordered self-contained projection events for persist and every live-view seam', async () => {
    const registry = await makeRegistry()
    const events: ProjectionEvent[] = []
    const off = registry.modules.sessions.onSessionProjection((event) => events.push(event))
    const { sessionId } = await registry.modules.sessions.createSession({ agentKind: 'shell', cwd: '/w' })
    const afterCreate = registry.modules.sessions.sessionsGeneration()

    registry.gateway.routeDaemonFrame('m1', {
      type: 'agentState',
      sessionId,
      state: { phase: 'working', since: '2026-07-10T00:00:00.000Z', nativeSubagentCount: 0 },
    })
    const afterPersist = registry.modules.sessions.sessionsGeneration()

    const clientId = attachTestClient(registry.clientGateway, () => {})
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
    const secondClientId = attachTestClient(registry.clientGateway, () => {})
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
    expect((await registry.modules.sessions.listSessions())[0]).not.toHaveProperty('generation')
    expect((await registry.modules.sessions.listSessions())[0]).not.toHaveProperty('revision')
  })

  it('resets the internal generation across restart without disturbing durable ledger order', async () => {
    const store = await openTestStore(':memory:')
    const first = await SessionRegistry.create(store, undefined, { instanceId: 'default' })
    const { sessionId } = await first.modules.sessions.createSession({ agentKind: 'shell', cwd: '/w' })
    const clientId = attachTestClient(first.clientGateway, () => {})
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
    const cursorBeforeRestart = (await first.modules.sessions.syncChangesSince(null)).cursor
    await first.dispose()

    const second = await makeRegistry(store)
    const generationAfterRestart = second.modules.sessions.sessionsGeneration()
    expect(generationAfterRestart).toBeGreaterThan(0)
    expect(generationAfterRestart).toBeLessThan(generationBeforeRestart)
    const cursorAfterRecovery = (await second.modules.sessions.syncChangesSince(null)).cursor
    expect(cursorAfterRecovery).toBeGreaterThan(cursorBeforeRestart)
    const recovered = await second.modules.sessions.syncChangesSince(cursorBeforeRestart)
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
    expect(await second.modules.sessions.syncChangesSince(cursorAfterRecovery)).toMatchObject({
      kind: 'delta',
      cursor: cursorAfterRecovery,
      changes: [],
    })
    expect((await second.modules.sessions.listSessions())[0]).not.toHaveProperty('generation')
    expect((await second.modules.sessions.listSessions())[0]).not.toHaveProperty('revision')
  })

  it('publishes the final state when coalesced changes revert to identical bytes', async () => {
    const registry = await makeRegistry()
    const current = deltaClient(registry)
    const { sessionId } = await registry.modules.sessions.createSession({ agentKind: 'shell', cwd: '/w' })
    registry.modules.sessions.flushBroadcasts()
    const originalSession = (await registry.modules.sessions
      .listSessions())
      .find((session) => session.sessionId === sessionId)
    expect(originalSession).toBeDefined()
    const original = originalSession?.name
    current.inbox.length = 0
    const cursorBefore = (await registry.modules.sessions.syncChangesSince(null)).cursor

    registry.modules.sessions.renameSession({ sessionId, name: 'temporary' })
    registry.modules.sessions.renameSession({ sessionId, name: original ?? '' })
    registry.modules.sessions.flushBroadcasts()

    const projected = sessionChanges(current.inbox).filter(
      (change) => change.id === sessionId && change.op === 'upsert',
    )
    expect(projected.length).toBeGreaterThan(0)
    expect((projected.at(-1)?.value as SessionMeta | undefined)?.name).toBe(original)
    const renames = await registry.modules.sessions.syncChangesSince(cursorBefore)
    expect(renames.kind).toBe('delta')
    expect(renames.kind === 'delta' ? renames.changes.length : 0).toBeGreaterThanOrEqual(2)
  })

  it('coalesces a resize burst into one async capture and one projection event', async () => {
    const registry = await makeRegistry()
    const { sessionId } = await registry.modules.sessions.createSession({ agentKind: 'shell', cwd: '/w' })
    const clientId = attachTestClient(registry.clientGateway, () => {})
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

  it('retains dirty live-view and machine patches across one append failure', async () => {
    const registry = await makeRegistry()
    const { sessionId } = await registry.modules.sessions.createSession({ agentKind: 'shell', cwd: '/w' })
    await registry.modules.machines.ensureHostMachine('first-host')
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

    const firstClient = attachTestClient(registry.clientGateway, () => {})
    failAndHeal(
      () => registry.clientGateway.routeClientFrame(firstClient, { type: 'attach', sessionId }),
      // POD-1081: clientCount is room occupancy (per principal), not attach-set size.
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

    // A second CONNECTION of the SAME principal does not change occupancy
    // (ADR 7 D9.4: two tabs are one member). Control transfer still dirties.
    const secondClient = attachTestClient(registry.clientGateway, () => {})
    registry.clientGateway.routeClientFrame(secondClient, { type: 'attach', sessionId })
    registry.modules.sessions.flushBroadcasts()
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
      // First principal still in the room; controller reverts to first connection.
      (value) => expect(value).toMatchObject({ clientCount: 1, controllerId: firstClient }),
    )
    failAndHeal(
      () =>
        registry.modules.machines.renameMachine(
          registry.modules.machines.hostMachineId,
          'healed-host',
        ),
      (value) => expect(value.machineName).toBe('healed-host'),
    )
    off()
  })

  it('captures a 588-session disconnect in one retryable batch', async () => {
    const registry = await makeRegistry()
    const sessionIds = await Promise.all(
      Array.from(
        { length: 588 },
        async (_, i) =>
          (await registry.modules.sessions.createSession({ agentKind: 'shell', cwd: `/w/` })).sessionId,
      ),
    )
    const clientId = attachTestClient(registry.clientGateway, () => {})
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

  it('rolls back live rename state when the durable append fails', async () => {
    const registry = await makeRegistry()
    const { sessionId } = await registry.modules.sessions.createSession({ agentKind: 'shell', cwd: '/w' })
    registry.modules.sessions.flushBroadcasts()
    const cursor = await cursorOf(registry)
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
      (await registry.modules.sessions.listSessions()).find((s) => s.sessionId === sessionId)?.name,
    ).toBeUndefined()
    expect(
      (await registry.sessionStore.sessions.loadSessions()).find((row) => row.id === sessionId)
        ?.name,
    ).toBeNull()
    expect(await cursorOf(registry)).toBe(cursor)
    expect(events).toEqual([])

    registry.modules.sessions.broadcastSessions()
    registry.modules.sessions.flushBroadcasts()
    expect(
      (await registry.modules.sessions.listSessions()).find((s) => s.sessionId === sessionId)?.name,
    ).toBeUndefined()
    expect(await registry.modules.sessions.syncChangesSince(cursor)).toMatchObject({
      kind: 'delta',
      cursor,
      changes: [],
    })

    registry.modules.sessions.renameSession({ sessionId, name: 'committed-name' })
    expect(events).toHaveLength(1)
    expect(events[0]?.changes).toHaveLength(1)
    expect((events[0]?.changes[0] as { value?: SessionMeta }).value?.name).toBe('committed-name')
  })

  it('rolls back live and SQLite snooze state when the durable append fails', async () => {
    const registry = await makeRegistry()
    const { sessionId } = await registry.modules.sessions.createSession({ agentKind: 'shell', cwd: '/w' })
    registry.modules.sessions.flushBroadcasts()
    const cursor = await cursorOf(registry)
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
    // The callee is async now, so the same failure arrives as a REJECTION.
    // Spelled `rejects.toThrow` rather than `toThrow`: a sync `toThrow` around an
    // async call passes vacuously, because the call returns a promise instead of
    // throwing [POD-3507].
    await expect(
      registry.modules.sessions.setSnooze({
        userId: asUserId(SOLE_USER_ID),
        sessionId,
        until: '2999-07-20T12:00:00.000Z',
      }),
    ).rejects.toThrow('snooze append failed')
    append.mockRestore()
    expect(
      (await registry.modules.sessions.listSessions()).find((s) => s.sessionId === sessionId)?.snoozedUntil,
    ).toBeUndefined()
    expect(
      await registry.sessionStore.sessions.listSnoozes(asUserId(SOLE_USER_ID)),
    ).not.toHaveProperty(sessionId)
    expect(await cursorOf(registry)).toBe(cursor)
    expect(events).toEqual([])

    registry.modules.sessions.broadcastSessions()
    registry.modules.sessions.flushBroadcasts()
    expect(
      (await registry.modules.sessions.listSessions()).find((s) => s.sessionId === sessionId)?.snoozedUntil,
    ).toBeUndefined()
    expect(await registry.modules.sessions.syncChangesSince(cursor)).toMatchObject({
      kind: 'delta',
      cursor,
      changes: [],
    })

    // Same future deadline as the failed attempt, for the same reason: a lapsed
    // timed snooze is pruned on read and would produce no change to project.
    await registry.modules.sessions.setSnooze({
      userId: asUserId(SOLE_USER_ID),
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
  ] as const)('(exit fence) %s session emits terminal proof only for a durable terminal fence', async (_name, checkpointRecord, terminalFenceReported) => {
    const registry = await makeRegistry()
    const { sessionId } = await registry.modules.sessions.createSession({
      agentKind: 'shell',
      cwd: '/w',
    })
    vi.spyOn(registry.sessionStore.observationCheckpoints, 'get').mockReturnValue(
      checkpointRecord as never,
    )

    await registry.modules.sessions.killSession({ sessionId })

    const exited = (
      await registry.sessionStore.events.listEventsSince(0, { kinds: ['session.exited'] })
    ).at(-1)
    expect(exited?.subject).toBe(sessionId)
    if (terminalFenceReported) {
      expect(exited?.payload).toMatchObject({ terminalFenceReported: true })
    } else {
      expect(exited?.payload).not.toHaveProperty('terminalFenceReported')
    }
  })

  it('(k) a failed change append on kill leaves the session fully live (#247)', async () => {
    const registry = await makeRegistry()
    const { sessionId } = await registry.modules.sessions.createSession({ agentKind: 'shell', cwd: '/w' })
    registry.modules.sessions.flushBroadcasts()
    const cursor = await cursorOf(registry)
    const spy = vi.spyOn(registry.sessionStore.sync, 'appendChanges').mockImplementationOnce(() => {
      throw new Error('append failed')
    })
    await expect(registry.modules.sessions.killSession({ sessionId })).rejects.toThrow('append failed')
    spy.mockRestore()
    // Memory truth survived: the session is still listed; the store rolled the
    // tombstone write back inside the same transact span.
    expect((await registry.modules.sessions.listSessions()).some((s) => s.sessionId === sessionId)).toBe(
      true,
    )
    expect(
      (await registry.sessionStore.sessions.loadSessions()).some((r) => r.id === sessionId),
    ).toBe(true)
    expect(await registry.sessionStore.sessions.loadDeletedSessions()).toEqual([])
    // A subsequent broadcast is snapshot-only and appends NOTHING for the untouched entity.
    registry.modules.sessions.broadcastSessions()
    registry.modules.sessions.flushBroadcasts()
    const healed = await registry.modules.sessions.syncChangesSince(cursor)
    expect(healed.kind).toBe('delta')
    if (healed.kind !== 'delta') return
    expect(healed.changes.filter((c) => c.entity === 'session')).toEqual([])
    // And the kill still works once the append path recovers.
    await registry.modules.sessions.killSession({ sessionId })
    expect((await registry.modules.sessions.listSessions()).some((s) => s.sessionId === sessionId)).toBe(
      false,
    )
    expect(await registry.sessionStore.sessions.loadDeletedSessions()).toEqual([
      expect.objectContaining({ id: sessionId, deletionSource: 'standalone' }),
    ])
  })

  // POD-797: deleted the session-derived issue append retry test with the wire path it exercised.
  it('replaying the whole durable log folds to the live session list', async () => {
    const registry = await makeRegistry()
    const a = await registry.modules.sessions.createSession({ agentKind: 'shell', cwd: '/w1' })
    const b = await registry.modules.sessions.createSession({ agentKind: 'shell', cwd: '/w2' })
    registry.modules.sessions.renameSession({ sessionId: a.sessionId, name: 'kept' })
    await registry.modules.sessions.killSession({ sessionId: b.sessionId })
    const healed = await registry.modules.sessions.syncChangesSince(0)
    expect(healed.kind).toBe('delta')
    if (healed.kind !== 'delta') return
    const folded = new Map<string, unknown>()
    for (const c of healed.changes) {
      if (c.entity !== 'session') continue
      if (c.op === 'upsert') folded.set(c.id, c.value)
      else folded.delete(c.id)
    }
    const live = await registry.modules.sessions.listSessions()
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
  it('(i) listSessions and the broadcast payload come from the ONE wire mapper [POD-366]', async () => {
    const registry = await makeRegistry()
    const cursor = await cursorOf(registry)
    const { sessionId } = await registry.modules.sessions.createSession({
      agentKind: 'claude-code',
      cwd: '/w',
      spawnedBy: 'user',
    })
    registry.modules.sessions.flushBroadcasts()

    const listed = (await registry.modules.sessions.listSessions()).find((s) => s.sessionId === sessionId)
    expect(listed).toBeDefined()

    const after = await registry.modules.sessions.syncChangesSince(cursor)
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
    // kill rather than a survivor. Resolved against the session's OWN machineId,
    // which since POD-318 is this host's minted id from the moment the session is
    // created — there is no placeholder phase to get wrong.
    expect(listed?.machineName).toBe(await registry.modules.machines.machineName(listed?.machineId ?? ''))
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
  afterEach(async () => {
    for (const r of registries.splice(0)) await r.dispose()
  })

  async function makeRegistry(): Promise<SessionRegistry> {
    const registry = await SessionRegistry.create(undefined, undefined, { instanceId: 'default' })
    registries.push(registry)
    return registry
  }

  /** A client whose hello advertises exactly `caps`. */
  function client(registry: SessionRegistry, caps: string[]): { inbox: ServerMessage[] } {
    const inbox: ServerMessage[] = []
    const id = attachTestClient(registry.clientGateway, (msg) => inbox.push(msg))
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

  it('(c) the bootstrap snapshot carries feedId, epoch and minAvailableSeq', async () => {
    // The snapshot arm needs the identity MOST: every rung of the D7 healing
    // ladder terminates in a re-bootstrap, and this is where a replica learns
    // which generation it landed on.
    const registry = await makeRegistry()
    // One append first, exactly as the two cases below do. `minAvailableSeq` is
    // the FIRST SERVABLE SEQ, so on an empty log it is honestly 0 and the `>= 1`
    // check would be asserting that the log is non-empty rather than that the
    // floor is published. Seeding makes the floor a real one.
    await registry.modules.sessions.createSession({ agentKind: 'shell', cwd: '/w' })
    const boot = await registry.modules.sessions.syncChangesSince(null)
    expect(boot.kind).toBe('snapshot')
    expect(boot.feedId).toBeTruthy()
    expect(boot.epoch).toBeTruthy()
    expect(boot.feedId).not.toBe(boot.epoch)
    expect(boot.minAvailableSeq).toBeGreaterThanOrEqual(1)
  })

  it('(c) the delta arm carries the SAME identity as the snapshot arm', async () => {
    // One authority, one feed: a client that bootstraps and then catches up must
    // not see the identity change under it, or it would re-bootstrap forever.
    const registry = await makeRegistry()
    const boot = await registry.modules.sessions.syncChangesSince(null)
    await registry.modules.sessions.createSession({ agentKind: 'shell', cwd: '/w' })
    const catchUp = await registry.modules.sessions.syncChangesSince(boot.cursor)
    expect(catchUp.kind).toBe('delta')
    expect(catchUp.feedId).toBe(boot.feedId)
    expect(catchUp.epoch).toBe(boot.epoch)
    expect(catchUp.minAvailableSeq).toBeGreaterThanOrEqual(1)
  })

  it('publishes minAvailableSeq consistently with what it will actually serve', async () => {
    const registry = await makeRegistry()
    await registry.modules.sessions.createSession({ agentKind: 'shell', cwd: '/w' })
    const reply = await registry.modules.sessions.syncChangesSince(null)
    const horizon = reply.minAvailableSeq as number
    // Nothing has been pruned, so the whole log is servable and the horizon is
    // the log's first seq — a replica at cursor 0 must NOT be told to re-bootstrap.
    expect(horizon).toBe(1)
    expect((await registry.modules.sessions.syncChangesSince(0)).kind).toBe('delta')
  })

  it('serves identity on every production wire-v2 delta', async () => {
    const registry = await makeRegistry()
    const asked = client(registry, ['metadataDelta', 'syncFeedIdentity'])
    const baseline = client(registry, ['metadataDelta'])
    asked.inbox.length = 0
    baseline.inbox.length = 0

    await registry.modules.sessions.createSession({ agentKind: 'shell', cwd: '/w' })
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

    const identity = await registry.modules.sessions.syncChangesSince(null)
    expect(identity.feedId).toBeTruthy()
    expect(identity.epoch).toBeTruthy()
  })

  it('both clients receive the SAME changes in the SAME order — the cap changes the envelope, never the feed', async () => {
    const registry = await makeRegistry()
    const withIdentity = client(registry, ['metadataDelta', 'syncFeedIdentity'])
    const legacy = client(registry, ['metadataDelta'])
    withIdentity.inbox.length = 0
    legacy.inbox.length = 0

    await registry.modules.sessions.createSession({ agentKind: 'shell', cwd: '/w' })
    registry.modules.funnel.flushDeltas()
    await registry.modules.sessions.createSession({ agentKind: 'shell', cwd: '/w' })
    registry.modules.funnel.flushDeltas()

    const strip = (m: ServerMessage[]) => deltas(m).map((d) => ({ seq: d.seq, changes: d.changes }))
    expect(strip(withIdentity.inbox)).toEqual(strip(legacy.inbox))
  })
})
