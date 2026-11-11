import {
  asMachineId,
  asSessionId,
  asUserId,
  firstAdminMemberId,
  type SessionMeta,
} from '@podium/model'
import {
  asCapabilityRef,
  asDeviceId,
  CLIENT_WIRE_VERSION,
  type MetadataChange,
  type ServerMessage,
} from '@podium/protocol'
import { CHANGE_LOG_OBSERVER, Ledger } from '@podium/sync'
import { fixtureWriteScope, testLedgerWriter } from '@podium/sync/testing'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SessionRegistry } from './relay'
import type { SessionStore } from './store'
import { authoritySnapshot } from './test-support/authority-snapshot'
import { attachTestClient } from './test-support/client-transport'
import { feedDelta } from './test-support/feed-delta'
import { attachHostDaemon } from './test-support/host-daemon'
import { openTestStore } from './test-support/open-test-store'
import { testStoreRecords } from './test-support/record-writer'
import { clientSessionViews } from './test-support/session-views'

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
    vi.useRealTimers()
  })

  /** Sessions are placed only on an assigned machine with an attached daemon, and
   *  issues only on a machine that reported their repo (2b803efb5), so the host
   *  daemon is attached and reports the fixture's issue repo. A restart over an
   *  existing `store` keeps the posture it had before: no daemon. */
  async function makeRegistry(store?: SessionStore): Promise<SessionRegistry> {
    const registry = await SessionRegistry.create(store, undefined, { instanceId: 'default' })
    registries.push(registry)
    if (!store) await attachHostDaemon(registry, () => {}, { repos: ['/r'] })
    return registry
  }

  it('awaits metadata persistence and propagates issue attachment failures', async () => {
    const registry = await makeRegistry()
    const { sessionId } = await registry.modules.sessions.createSession({
      agentKind: 'shell',
      cwd: '/w',
    })
    // The issue's repo is reported only AFTER the spawn, as before 2b803efb5: a
    // session born inside a reported repo takes a draft ref at spawn, and this
    // test is about the issue ref the attachment allocates.
    await registry.sessionStore.repos.addRepo('/w', registry.sessionStore.hostMachineId)
    const issue = await registry.issues.crud.create(registry.issues.reports.store.serverWriter, {
      repoPath: '/w',
      title: 'Attachment',
      startNow: false,
    })
    const sessions = registry.modules.sessions
    // Fail the append that carries THIS session's row, and only that one: other
    // writers (the issue create's feed captures) may still be appending.
    const sync = registry.sessionStore.sync
    const realAppend = sync.appendChanges.bind(sync)
    const appended: string[][] = []
    let failed = false
    const append = vi.spyOn(sync, 'appendChanges').mockImplementation(async (rows, eventTime) => {
      appended.push(rows.map((row) => `${row.entity}:${row.entityId}`))
      if (!failed && rows.some((row) => row.entity === 'session' && row.entityId === sessionId)) {
        failed = true
        throw new Error('attach failed')
      }
      return await realAppend(rows, eventTime)
    })
    await expect(
      sessions.setSessionIssueId(sessions.serverWriter, sessionId, issue.id),
    ).rejects.toThrow('attach failed')
    // The rejected append was this session's: the issue create's event capture
    // may come first, and must not be the one that fails.
    expect(appended.flat()).toContain(`session:${sessionId}`)
    expect(await sessions.readSessionIssueId(sessionId)).toBeNull()
    append.mockRestore()
    await sessions.setSessionIssueId(sessions.serverWriter, sessionId, issue.id)
    const attached = await registry.sessionStore.sessions.getSession(sessionId)
    expect(attached?.issueId).toBe(issue.id)
    expect(attached?.refIssueId).toBe(issue.id)
    expect(attached?.refLetter).toBeTruthy()
    await sessions.setSessionCwd(sessions.serverWriter, sessionId, '/w/new')
    expect((await registry.sessionStore.sessions.getSession(sessionId))?.cwd).toBe('/w/new')
  })

  it('resolves the trusted principal for snooze and read operations', async () => {
    const registry = await makeRegistry()
    const { sessionId } = await registry.modules.sessions.createSession({
      agentKind: 'shell',
      cwd: '/w',
    })
    const sessions = registry.modules.sessions
    await sessions.setSnooze(sessions.serverWriter, {
      userId: firstAdminMemberId(),
      sessionId,
      until: null,
    })
    expect(await registry.sessionStore.sessions.listSnoozes(firstAdminMemberId())).toHaveProperty(
      sessionId,
    )
    await sessions.clearSnooze(sessions.serverWriter, firstAdminMemberId(), sessionId)
    expect(
      await registry.sessionStore.sessions.listSnoozes(firstAdminMemberId()),
    ).not.toHaveProperty(sessionId)
    await sessions.markSessionRead(sessions.serverWriter, firstAdminMemberId(), sessionId)
    expect(
      (await clientSessionViews(registry)).find((s) => s.sessionId === sessionId)?.readAt,
    ).toBeTruthy()
    await sessions.markSessionUnread(sessions.serverWriter, firstAdminMemberId(), sessionId)
    expect(
      (await clientSessionViews(registry)).find((s) => s.sessionId === sessionId)?.readAt,
    ).toBeNull()
  })

  async function deltaClient(registry: SessionRegistry): Promise<{ inbox: ServerMessage[] }> {
    const inbox: ServerMessage[] = []
    const id = attachTestClient(registry.clientGateway, (msg) => inbox.push(msg))
    await registry.clientGateway.routeClientFrame(id, {
      type: 'hello',
      clientId: '',
      wireVersion: CLIENT_WIRE_VERSION,
      viewport: { cols: 80, rows: 24, dpr: 1 },
      // Admission requires the HTTP sync capability (6b22a3650).
      caps: ['metadataDelta', 'sync.http.v1'],
    })
    await vi.waitFor(() => {
      expect(inbox.some((message) => message.type === 'feedResume')).toBe(true)
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

  const cursorOf = async (registry: SessionRegistry): Promise<number> =>
    await registry.changeLedger.cursor()

  it('(a) a throw between the row write and the change append rolls BOTH back', async () => {
    const store = await openTestStore(':memory:')
    const ledger = new Ledger({
      repo: store.sync,
      records: testStoreRecords(store),
      now: () => 1_000,
      transact: async (fn) => await store.transact(fn),
    })
    const cursorBefore = await ledger.cursor()
    await expect(
      testLedgerWriter(ledger).commit({
        write: async () =>
          await store.sessions.upsertSession(fixtureWriteScope(), {
            id: asSessionId('s-atomic'),
            ownerUserId: firstAdminMemberId(),
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
        creates: () => {
          throw new Error('record naming failed')
        },
      }),
    ).rejects.toThrow('record naming failed')
    // The session row write inside the same transact span rolled back too.
    expect((await store.sessions.loadSessions()).find((r) => r.id === 's-atomic')).toBeUndefined()
    expect(await ledger.cursor()).toBe(cursorBefore)
  })

  it('(b) an agentState persist yields a durable ledger change (the staleness-gap fix)', async () => {
    const registry = await makeRegistry()
    const { sessionId } = await registry.modules.sessions.createSession({
      agentKind: 'shell',
      cwd: '/w',
    })
    const cursor = await cursorOf(registry)
    await registry.gateway.routeDaemonFrame('m1', {
      type: 'agentState',
      sessionId,
      state: { phase: 'working', since: '2026-07-09T00:00:00.000Z', nativeSubagentCount: 0 },
    })
    const healed = await feedDelta(registry, cursor, CHANGE_LOG_OBSERVER)
    const change = healed.changes.find(
      (c) => c.entity === 'session' && c.id === sessionId && c.op === 'upsert',
    ) as { value?: SessionMeta } | undefined
    expect(change?.value?.agentState?.phase).toBe('working')
    expect((await registry.sessionStore.sessions.getSession(sessionId))?.agentState?.phase).toBe(
      'working',
    )
    await registry.dispose()
    const restarted = await makeRegistry(registry.sessionStore)
    const snapshot = await authoritySnapshot(restarted)
    expect(snapshot.sessions.find((row) => row.sessionId === sessionId)?.agentState?.phase).toBe(
      'working',
    )
  })

  it('(b2) a title persist yields a durable ledger change', async () => {
    const registry = await makeRegistry()
    const { sessionId } = await registry.modules.sessions.createSession({
      agentKind: 'shell',
      cwd: '/w',
    })
    const cursor = await cursorOf(registry)
    await registry.gateway.routeDaemonFrame('m1', {
      type: 'title',
      sessionId,
      title: 'a real durable title',
    })
    const healed = await feedDelta(registry, cursor, CHANGE_LOG_OBSERVER)
    const change = healed.changes.find(
      (c) => c.entity === 'session' && c.id === sessionId && c.op === 'upsert',
    ) as { value?: SessionMeta } | undefined
    expect(change?.value?.title).toBe('a real durable title')
  })

  it('(c) session and issue commits interleave onto delta clients in seq order with no gaps', async () => {
    const registry = await makeRegistry()
    const delta = await deltaClient(registry)
    const before = delta.inbox.length
    const { sessionId } = await registry.modules.sessions.createSession({
      agentKind: 'shell',
      cwd: '/w',
    })
    await registry.issues.crud.create(registry.issues.reports.store.serverWriter, {
      repoPath: '/r',
      title: 'interleaved',
      startNow: false,
    })
    await registry.modules.sessions.renameSession(registry.modules.sessions.serverWriter, {
      sessionId,
      name: 'renamed-mid-stream',
    })
    await registry.modules.sessions.flushBroadcasts() // drain the coalesced pipeline
    await vi.waitFor(() => {
      const received = batches(delta.inbox.slice(before)).flatMap((b) => b.changes)
      expect(received.length).toBeGreaterThanOrEqual(2)
      expect(received.some((c) => c.entity === 'session')).toBe(true)
      expect(received.some((c) => c.entity === 'issueProjection')).toBe(true)
      // Strict seq order, and gap-free: the stream carries EVERY seq in its range.
      const seqs = received.map((c) => c.seq)
      for (let i = 1; i < seqs.length; i++) expect(seqs[i]).toBe((seqs[i - 1] as number) + 1)
      // Batch stamps match their last change.
      for (const b of batches(delta.inbox.slice(before))) {
        expect(b.changes.at(-1)?.seq).toBe(b.seq)
      }
    })
  })

  it('(d) one appended batch reaches a delta client exactly once (no double emission via publishComputed)', async () => {
    const registry = await makeRegistry()
    const delta = await deltaClient(registry)
    const before = delta.inbox.length
    const { sessionId } = await registry.modules.sessions.createSession({
      agentKind: 'shell',
      cwd: '/w',
    })
    await registry.modules.sessions.flushBroadcasts()
    await vi.waitFor(() => {
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
      expect(delta.inbox.slice(before).map((m) => m.type)).not.toContain('sessionsChanged')
    })
  })

  it('(e) kill commits a remove in the same transaction as the row tombstone', async () => {
    const registry = await makeRegistry()
    const { sessionId } = await registry.modules.sessions.createSession({
      agentKind: 'shell',
      cwd: '/w',
    })
    const cursor = await cursorOf(registry)
    const delta = await deltaClient(registry)
    const before = delta.inbox.length
    await registry.modules.sessions.killSession(registry.modules.sessions.serverWriter, {
      sessionId,
    })
    await registry.modules.sessions.flushBroadcasts()
    // Durable: the remove is in the log…
    const healed = await feedDelta(registry, cursor, CHANGE_LOG_OBSERVER)
    expect(
      healed.changes.some((c) => c.entity === 'session' && c.id === sessionId && c.op === 'remove'),
    ).toBe(true)
    // …and live: it reached the delta client, while the durable row is tombstoned.
    await vi.waitFor(() => {
      expect(
        sessionChanges(delta.inbox.slice(before)).some(
          (c) => c.id === sessionId && c.op === 'remove',
        ),
      ).toBe(true)
    })
    expect(await registry.sessionStore.sessions.loadSessions()).toHaveLength(0)
    expect(await registry.sessionStore.sessions.loadDeletedSessions()).toEqual([
      expect.objectContaining({
        id: sessionId,
        deletionSource: 'standalone',
        deletedByIssueId: null,
      }),
    ])
  })

  it('(f) boot reads current rows without reconciling offline writes', async () => {
    const store = await openTestStore(':memory:')
    const first = await SessionRegistry.create(store, undefined, { instanceId: 'default' })
    await attachHostDaemon(first, () => {})
    const { sessionId } = await first.modules.sessions.createSession({
      agentKind: 'shell',
      cwd: '/w',
    })
    await first.dispose()
    const cursor = (await authoritySnapshot(first)).cursor
    // Offline mutation: rename the row behind the server's back.
    const row = (await store.sessions.loadSessions()).find((r) => r.id === sessionId)
    if (!row) throw new Error('row missing')
    await store.sessions.upsertSession(fixtureWriteScope(), { ...row, name: 'changed offline' })
    // Startup streams the tables. An out-of-band writer must invalidate the
    // kind generation; boot itself never repairs the log.
    const second = await makeRegistry(store)
    const healed = await feedDelta(second, cursor, CHANGE_LOG_OBSERVER)
    expect(healed.changes.filter((change) => change.entity === 'session')).toEqual([])
    const snapshot = await authoritySnapshot(second)
    expect(snapshot.sessions.find((session) => session.sessionId === sessionId)?.name).toBe(
      'changed offline',
    )
  })

  it('(g) a reentrant ledger commit during oplog.appended cannot reorder the delta stream (#247)', async () => {
    const registry = await makeRegistry()
    const a = await registry.modules.sessions.createSession({ agentKind: 'shell', cwd: '/w1' })
    const b = await registry.modules.sessions.createSession({ agentKind: 'shell', cwd: '/w2' })
    await registry.modules.sessions.flushBroadcasts()
    const delta = await deltaClient(registry)
    const before = delta.inbox.length
    // A bus consumer that commits AGAIN while handling 'oplog.appended' — its
    // batch carries a LATER seq than the one being announced. Bus-before-pipe
    // delivered [N+1, N] and the client's cursor jumped past N without healing.
    let reentered = false
    let resolveInner!: () => void
    let rejectInner!: (error: unknown) => void
    const innerRename = new Promise<void>((resolve, reject) => {
      resolveInner = resolve
      rejectInner = reject
    })
    registry.bus.on('oplog.appended', () => {
      if (reentered) return
      reentered = true
      void registry.modules.sessions
        .renameSession(registry.modules.sessions.serverWriter, {
          sessionId: b.sessionId,
          name: 'inner-commit',
        })
        .then(resolveInner, rejectInner)
    })
    await Promise.all([
      registry.modules.sessions.renameSession(registry.modules.sessions.serverWriter, {
        sessionId: a.sessionId,
        name: 'outer-commit',
      }),
      innerRename,
    ])
    await registry.modules.sessions.flushBroadcasts()
    await vi.waitFor(() => {
      const seqs = batches(delta.inbox.slice(before))
        .flatMap((m) => m.changes)
        .map((c) => c.seq)
      expect(seqs.length).toBeGreaterThanOrEqual(2)
      // Strict append (= seq) order, gap-free — the client gap rule's invariant.
      for (let i = 1; i < seqs.length; i++) expect(seqs[i]).toBe((seqs[i - 1] as number) + 1)
    })
  })

  it('(i) enrollment and rename publish machine rows without recapturing sessions; revoke keeps the label', async () => {
    const registry = await makeRegistry()
    const { sessionId } = await registry.modules.sessions.createSession({
      agentKind: 'shell',
      cwd: '/w',
    })
    await registry.modules.sessions.flushBroadcasts()
    const host = registry.modules.machines.hostMachineId
    let cursor = await cursorOf(registry)
    for (const name of ['adopting-host', 'renamed-host']) {
      if (name === 'adopting-host') await registry.modules.machines.ensureHostMachine(name)
      else await registry.modules.machines.renameMachine(host, name)
      await registry.modules.sessions.flushBroadcasts()
      const delta = await feedDelta(registry, cursor, CHANGE_LOG_OBSERVER)
      expect(delta.changes.filter((row) => row.entity === 'session')).toEqual([])
      expect(delta.changes.filter((row) => row.entity === 'machine')).toEqual([
        expect.objectContaining({ id: host, value: expect.objectContaining({ id: host, name }) }),
      ])
      expect(
        (await clientSessionViews(registry)).find((row) => row.sessionId === sessionId)
          ?.machineName,
      ).toBe(name)
      cursor = delta.cursor
    }
    await registry.modules.machines.revokeMachine(host)
    await registry.modules.sessions.flushBroadcasts()
    expect((await registry.sessionStore.machines.getMachine(host))?.revokedAt).toEqual(
      expect.any(String),
    )
    expect(
      (await clientSessionViews(registry)).find((row) => row.sessionId === sessionId)?.machineName,
    ).toBe('renamed-host')
  })

  it('(j) a daemon disconnect writes nothing to the durable log: reconnecting is not synced (POD-6646)', async () => {
    const registry = await makeRegistry()
    const { sessionId } = await registry.modules.sessions.createSession({
      agentKind: 'shell',
      cwd: '/w',
    })
    // The host daemon attaches under the id the session is already attributed to.
    const host = registry.modules.machines.hostMachineId
    await registry.gateway.attachDaemon(host, () => {})
    await registry.modules.sessions.flushBroadcasts()
    const cursor = await cursorOf(registry)
    // The disconnect marks live/starting rows awaiting a rebind, server-side
    // only. Reconnecting is a condition every reader derives from the machine's
    // link (ADR 12 D1), so no session change reaches the synced log.
    registry.gateway.detachDaemon(host)
    await registry.modules.sessions.flushBroadcasts()
    const healed = await feedDelta(registry, cursor, CHANGE_LOG_OBSERVER)
    const flipped = healed.changes.filter(
      (c) => c.entity === 'session' && c.id === sessionId && c.op === 'upsert',
    ) as { value?: SessionMeta }[]
    expect(flipped.map((c) => c.value?.status).filter((s) => s !== 'live')).toEqual([])
  })

  it('retires full-world session reconcile after boot while keeping every owning seam durable', async () => {
    const registry = await makeRegistry()

    const { sessionId } = await registry.modules.sessions.createSession({
      agentKind: 'shell',
      cwd: '/w',
    })
    const clientId = attachTestClient(registry.clientGateway, () => {})
    await registry.clientGateway.routeClientFrame(clientId, { type: 'attach', sessionId })
    await registry.clientGateway.routeClientFrame(clientId, {
      type: 'viewState',
      visible: [sessionId],
      focused: sessionId,
    })
    await registry.clientGateway.routeClientFrame(clientId, {
      type: 'resize',
      sessionId,
      cols: 100,
      rows: 40,
    })
    // The forward moves nothing; the daemon's report of the new size does (POD-4771).
    await registry.gateway.routeDaemonFrame(registry.sessionStore.hostMachineId, {
      type: 'geometryApplied',
      sessionId,
      geometry: { cols: 100, rows: 40 },
      cause: 'request',
    })
    await registry.clientGateway.routeClientFrame(clientId, { type: 'detach', sessionId })
    await registry.modules.sessions.flushBroadcasts()

    const changes = await feedDelta(registry, 0, CHANGE_LOG_OBSERVER)
    // The size is a live reading (POD-6764): no session change carries it, and
    // the terminal state topic answers it.
    const sized = changes.changes.filter(
      (change) =>
        change.entity === 'session' &&
        change.id === sessionId &&
        change.op === 'upsert' &&
        'geometry' in (change.value as object),
    )
    expect(sized).toEqual([])
    expect(
      await registry.modules.sessions.liveTopics.snapshot('session.terminalState', sessionId),
    ).toMatchObject({ geometry: { cols: 100, rows: 40 } })
  })

  it('emits ordered self-contained projection events for durable writes', async () => {
    const registry = await makeRegistry()
    const events: ProjectionEvent[] = []
    const off = registry.modules.sessions.onSessionProjection((event) => events.push(event))
    const { sessionId } = await registry.modules.sessions.createSession({
      agentKind: 'shell',
      cwd: '/w',
    })
    const afterCreate = registry.modules.sessions.sessionsGeneration()

    await registry.gateway.routeDaemonFrame('m1', {
      type: 'agentState',
      sessionId,
      state: { phase: 'working', since: '2026-07-10T00:00:00.000Z', nativeSubagentCount: 0 },
    })
    const afterPersist = registry.modules.sessions.sessionsGeneration()

    const clientId = attachTestClient(registry.clientGateway, () => {})
    await registry.clientGateway.routeClientFrame(clientId, { type: 'attach', sessionId })
    await registry.modules.sessions.flushBroadcasts()
    const afterAttach = registry.modules.sessions.sessionsGeneration()
    await registry.clientGateway.routeClientFrame(clientId, {
      type: 'viewState',
      visible: [sessionId],
      focused: sessionId,
    })
    await registry.clientGateway.routeClientFrame(clientId, {
      type: 'resize',
      sessionId,
      cols: 110,
      rows: 42,
    })
    await registry.modules.sessions.flushBroadcasts()
    const afterResize = registry.modules.sessions.sessionsGeneration()
    const secondClientId = attachTestClient(registry.clientGateway, () => {})
    await registry.clientGateway.routeClientFrame(secondClientId, { type: 'attach', sessionId })
    await registry.modules.sessions.flushBroadcasts()
    const afterSecondAttach = registry.modules.sessions.sessionsGeneration()
    await registry.clientGateway.routeClientFrame(secondClientId, {
      type: 'requestControl',
      sessionId,
    })
    await registry.modules.sessions.flushBroadcasts()
    const afterControl = registry.modules.sessions.sessionsGeneration()
    // A no-op repeat must not fabricate work.
    const eventCountBeforeNoop = events.length
    await registry.clientGateway.routeClientFrame(secondClientId, {
      type: 'requestControl',
      sessionId,
    })
    await registry.modules.sessions.flushBroadcasts()
    expect(events).toHaveLength(eventCountBeforeNoop)
    await registry.clientGateway.routeClientFrame(secondClientId, { type: 'detach', sessionId })
    await registry.modules.sessions.flushBroadcasts()
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
    expect((await registry.modules.sessions.listSessions(undefined, 'rpc'))[0]).not.toHaveProperty(
      'generation',
    )
    expect((await registry.modules.sessions.listSessions(undefined, 'rpc'))[0]).not.toHaveProperty(
      'revision',
    )
  })

  it('resets the internal generation across restart without disturbing durable ledger order', async () => {
    const store = await openTestStore(':memory:')
    const first = await SessionRegistry.create(store, undefined, { instanceId: 'default' })
    await attachHostDaemon(first, () => {})
    const { sessionId } = await first.modules.sessions.createSession({
      agentKind: 'shell',
      cwd: '/w',
    })
    const clientId = attachTestClient(first.clientGateway, () => {})
    await first.clientGateway.routeClientFrame(clientId, { type: 'attach', sessionId })
    await first.clientGateway.routeClientFrame(clientId, {
      type: 'viewState',
      visible: [sessionId],
      focused: sessionId,
    })
    await first.clientGateway.routeClientFrame(clientId, {
      type: 'resize',
      sessionId,
      cols: 101,
      rows: 37,
    })
    await first.clientGateway.routeClientFrame(clientId, { type: 'detach', sessionId })
    await first.modules.sessions.flushBroadcasts()
    const generationBeforeRestart = first.modules.sessions.sessionsGeneration()
    const cursorBeforeRestart = (await authoritySnapshot(first)).cursor
    await first.dispose()

    const second = await makeRegistry(store)
    // The generation starts over. Booting changes no session (its status is the
    // stored one, POD-6646), so the first change after the restart is the bind.
    expect(second.modules.sessions.sessionsGeneration()).toBeLessThan(generationBeforeRestart)
    await attachHostDaemon(second, () => {})
    await second.gateway.routeDaemonFrame(second.sessionStore.hostMachineId, {
      type: 'bind',
      sessionId,
      cmd: 'bash',
      cwd: '/w',
      agentKind: 'shell',
      geometry: { cols: 80, rows: 24 },
    })
    await second.modules.sessions.flushBroadcasts()
    const generationAfterRestart = second.modules.sessions.sessionsGeneration()
    expect(generationAfterRestart).toBeGreaterThan(0)
    const cursorAfterRecovery = (await authoritySnapshot(second)).cursor
    expect(cursorAfterRecovery).toBeGreaterThan(cursorBeforeRestart)
    const recovered = await feedDelta(second, cursorBeforeRestart, CHANGE_LOG_OBSERVER)
    expect(
      recovered.changes.some(
        (change) =>
          change.entity === 'session' && change.id === sessionId && change.op === 'upsert',
      ),
    ).toBe(true)
    second.modules.sessions.broadcastSessions()
    await second.modules.sessions.flushBroadcasts()
    expect(await feedDelta(second, cursorAfterRecovery, CHANGE_LOG_OBSERVER)).toMatchObject({
      kind: 'delta',
      cursor: cursorAfterRecovery,
      changes: [],
    })
    expect((await second.modules.sessions.listSessions(undefined, 'rpc'))[0]).not.toHaveProperty(
      'generation',
    )
    expect((await second.modules.sessions.listSessions(undefined, 'rpc'))[0]).not.toHaveProperty(
      'revision',
    )
  })

  it('publishes the final state when coalesced changes revert to identical bytes', async () => {
    const registry = await makeRegistry()
    const current = await deltaClient(registry)
    const { sessionId } = await registry.modules.sessions.createSession({
      agentKind: 'shell',
      cwd: '/w',
    })
    await registry.modules.sessions.flushBroadcasts()
    const originalSession = (await registry.modules.sessions.listSessions(undefined, 'rpc')).find(
      (session) => session.sessionId === sessionId,
    )
    expect(originalSession).toBeDefined()
    const original = originalSession?.name
    current.inbox.length = 0
    const cursorBefore = (await authoritySnapshot(registry)).cursor

    await registry.modules.sessions.renameSession(registry.modules.sessions.serverWriter, {
      sessionId,
      name: 'temporary',
    })
    await registry.modules.sessions.renameSession(registry.modules.sessions.serverWriter, {
      sessionId,
      name: original ?? '',
    })
    await registry.modules.sessions.flushBroadcasts()

    await vi.waitFor(() => {
      const projected = sessionChanges(current.inbox).filter(
        (change) => change.id === sessionId && change.op === 'upsert',
      )
      expect(projected.length).toBeGreaterThan(0)
      expect((projected.at(-1)?.value as SessionMeta | undefined)?.name).toBe(original)
    })
    const renames = await feedDelta(registry, cursorBefore, CHANGE_LOG_OBSERVER)
    expect(renames.changes.length).toBeGreaterThanOrEqual(2)
  })

  it('a burst of size reports appends no session change; the newest size is the live reading', async () => {
    const registry = await makeRegistry()
    const { sessionId } = await registry.modules.sessions.createSession({
      agentKind: 'shell',
      cwd: '/w',
    })
    const clientId = attachTestClient(registry.clientGateway, () => {})
    await registry.clientGateway.routeClientFrame(clientId, { type: 'attach', sessionId })
    await registry.clientGateway.routeClientFrame(clientId, {
      type: 'viewState',
      visible: [sessionId],
      focused: sessionId,
    })
    await registry.modules.sessions.flushBroadcasts()

    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const events: ProjectionEvent[] = []
    const off = registry.modules.sessions.onSessionProjection((event) => events.push(event))
    const append = vi.spyOn(registry.sessionStore.sync, 'appendChanges')
    const frames: Promise<void>[] = []
    // A window drag: the daemon reports each size the pty passes through
    // (POD-4771 — the report, not the ask, moves the copy).
    for (let i = 0; i < 200; i++) {
      frames.push(
        registry.gateway.routeDaemonFrame(registry.sessionStore.hostMachineId, {
          type: 'geometryApplied',
          sessionId,
          geometry: { cols: 100 + i, rows: 40 + i },
          cause: 'request',
        }),
      )
    }
    await Promise.all(frames)

    expect(append).not.toHaveBeenCalled()
    expect(events).toEqual([])
    await registry.modules.sessions.flushBroadcasts()
    // The size left the synced record (POD-6764): a drag is not a record change.
    expect(append).not.toHaveBeenCalled()
    expect(events).toEqual([])
    expect(
      await registry.modules.sessions.liveTopics.snapshot('session.terminalState', sessionId),
    ).toMatchObject({ geometry: { cols: 299, rows: 239 } })
    append.mockRestore()
    off()
  })

  it('admits only the owner to a session room, without counting duplicate tabs (POD-6283)', async () => {
    const registry = await makeRegistry()
    const { sessionId } = await registry.modules.sessions.createSession({
      agentKind: 'shell',
      cwd: '/w',
    })
    const room = { kind: 'session' as const, id: sessionId }
    const legacyGrantee = asUserId('room-viewer')
    const ownerMessages: ServerMessage[] = []
    const granteeMessages: ServerMessage[] = []
    const owner = attachTestClient(registry.clientGateway, (msg) => ownerMessages.push(msg))
    const tab = attachTestClient(registry.clientGateway, () => {})
    const grantee = attachTestClient(registry.clientGateway, {
      userId: legacyGrantee,
      userRole: 'member',
      send: (msg) => granteeMessages.push(msg),
    })
    // A legacy session grant: kept, and it admits nobody (sessions are private).
    await registry.sessionStore.grants.upsert({
      resourceKind: 'session',
      resourceId: sessionId,
      grantee: legacyGrantee,
      verb: 'read',
      owner: firstAdminMemberId(),
      visibility: 'personal',
      createdAt: new Date().toISOString(),
      actorKind: 'user',
      actorId: firstAdminMemberId(),
      onBehalfOf: null,
    })
    for (const id of [owner, tab]) {
      await registry.clientGateway.routeClientFrame(id, { type: 'presenceSubscribe', room })
    }
    expect(ownerMessages).toContainEqual(
      expect.objectContaining({
        type: 'presenceRoomState',
        room,
        members: [
          expect.objectContaining({ identity: { kind: 'user', user: firstAdminMemberId() } }),
        ],
      }),
    )
    granteeMessages.length = 0
    await registry.clientGateway.routeClientFrame(grantee, {
      type: 'presenceSubscribe',
      room,
      token: 'denied',
    })
    expect(granteeMessages).toEqual([{ type: 'presenceRoomClosed', room, token: 'denied' }])
    await registry.modules.sessions.flushBroadcasts()
    await registry.clientGateway.routeClientFrame(grantee, { type: 'attach', sessionId })
    expect(granteeMessages).toContainEqual({
      type: 'terminalOutcome',
      sessionId,
      outcome: 'unauthorized',
    })
  })

  it('attach, resize, control and detach append no session change and reach the live topics (POD-6764)', async () => {
    const registry = await makeRegistry()
    const { sessionId } = await registry.modules.sessions.createSession({
      agentKind: 'shell',
      cwd: '/w',
    })
    await registry.modules.sessions.flushBroadcasts()
    const events: ProjectionEvent[] = []
    const off = registry.modules.sessions.onSessionProjection((event) => events.push(event))
    const append = vi.spyOn(registry.sessionStore.sync, 'appendChanges')
    const terminalState = () =>
      registry.modules.sessions.liveTopics.snapshot('session.terminalState', sessionId)

    const firstClient = attachTestClient(registry.clientGateway, () => {})
    await registry.clientGateway.routeClientFrame(firstClient, { type: 'attach', sessionId })
    await registry.modules.sessions.flushBroadcasts()
    expect(await terminalState()).toMatchObject({ controller: firstClient })

    await registry.clientGateway.routeClientFrame(firstClient, {
      type: 'viewState',
      visible: [sessionId],
      focused: sessionId,
    })
    await registry.gateway.routeDaemonFrame(registry.sessionStore.hostMachineId, {
      type: 'geometryApplied',
      sessionId,
      geometry: { cols: 123, rows: 47 },
      cause: 'request',
    })
    await registry.modules.sessions.flushBroadcasts()
    expect(await terminalState()).toMatchObject({ geometry: { cols: 123, rows: 47 } })

    const secondClient = attachTestClient(registry.clientGateway, () => {})
    await registry.clientGateway.routeClientFrame(secondClient, { type: 'attach', sessionId })
    await registry.clientGateway.routeClientFrame(secondClient, {
      type: 'requestControl',
      sessionId,
    })
    await registry.modules.sessions.flushBroadcasts()
    expect(await terminalState()).toMatchObject({ controller: secondClient })

    await registry.clientGateway.routeClientFrame(secondClient, { type: 'detach', sessionId })
    await registry.modules.sessions.flushBroadcasts()
    // Control reverts to the first connection.
    expect(await terminalState()).toMatchObject({ controller: firstClient })

    expect(
      append.mock.calls.flatMap(([changes]) => changes).filter((c) => c.entity === 'session'),
    ).toEqual([])
    expect(events).toEqual([])
    append.mockRestore()
    off()
  })

  it('a 588-session disconnect appends no session change (POD-6764)', async () => {
    const registry = await makeRegistry()
    const sessionIds = await Promise.all(
      Array.from(
        { length: 588 },
        async (_, i) =>
          (await registry.modules.sessions.createSession({ agentKind: 'shell', cwd: `/w/` }))
            .sessionId,
      ),
    )
    const clientId = attachTestClient(registry.clientGateway, () => {})
    for (const sessionId of sessionIds) {
      await registry.clientGateway.routeClientFrame(clientId, { type: 'attach', sessionId })
    }
    await registry.modules.sessions.flushBroadcasts()

    const events: ProjectionEvent[] = []
    const off = registry.modules.sessions.onSessionProjection((event) => events.push(event))
    const append = vi.spyOn(registry.sessionStore.sync, 'appendChanges')
    const detached = vi.spyOn(registry.modules.sessions, 'onClientDetached')
    registry.clientGateway.detachClient(clientId)
    await detached.mock.results[0]?.value
    await registry.modules.sessions.flushBroadcasts()
    // Who is attached and how many clients watch are live (the terminal state
    // topic and the presence room): a disconnect changes no record.
    expect(append).not.toHaveBeenCalled()
    expect(events).toEqual([])
    append.mockRestore()
    off()
  })

  it('rolls back live rename state when the durable append fails', async () => {
    const registry = await makeRegistry()
    const { sessionId } = await registry.modules.sessions.createSession({
      agentKind: 'shell',
      cwd: '/w',
    })
    await registry.modules.sessions.flushBroadcasts()
    const cursor = await cursorOf(registry)
    const events: ProjectionEvent[] = []
    registry.modules.sessions.onSessionProjection((event) => events.push(event))
    const append = vi
      .spyOn(registry.sessionStore.sync, 'appendChanges')
      .mockImplementationOnce(() => {
        throw new Error('rename append failed')
      })

    await expect(
      registry.modules.sessions.renameSession(registry.modules.sessions.serverWriter, {
        sessionId,
        name: 'phantom-name',
      }),
    ).rejects.toThrow('rename append failed')
    append.mockRestore()
    expect(
      (await clientSessionViews(registry)).find((s) => s.sessionId === sessionId)?.name,
    ).toBeUndefined()
    expect(
      (await registry.sessionStore.sessions.loadSessions()).find((row) => row.id === sessionId)
        ?.name,
    ).toBeNull()
    expect(await cursorOf(registry)).toBe(cursor)
    expect(events).toEqual([])

    registry.modules.sessions.broadcastSessions()
    await registry.modules.sessions.flushBroadcasts()
    expect(
      (await clientSessionViews(registry)).find((s) => s.sessionId === sessionId)?.name,
    ).toBeUndefined()
    expect(await feedDelta(registry, cursor, CHANGE_LOG_OBSERVER)).toMatchObject({
      kind: 'delta',
      cursor,
      changes: [],
    })

    await registry.modules.sessions.renameSession(registry.modules.sessions.serverWriter, {
      sessionId,
      name: 'committed-name',
    })
    expect(events).toHaveLength(1)
    expect(events[0]?.changes).toHaveLength(1)
    expect((events[0]?.changes[0] as { value?: SessionMeta }).value?.name).toBe('committed-name')
  })

  it('rolls back live and SQLite snooze state when the durable append fails', async () => {
    const registry = await makeRegistry()
    const { sessionId } = await registry.modules.sessions.createSession({
      agentKind: 'shell',
      cwd: '/w',
    })
    await registry.modules.sessions.flushBroadcasts()
    const cursor = await cursorOf(registry)
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
      registry.modules.sessions.setSnooze(registry.modules.sessions.serverWriter, {
        userId: firstAdminMemberId(),
        sessionId,
        until: '2999-07-20T12:00:00.000Z',
      }),
    ).rejects.toThrow('snooze append failed')
    append.mockRestore()
    expect(
      (await clientSessionViews(registry)).find((s) => s.sessionId === sessionId)?.snoozedUntil,
    ).toBeUndefined()
    expect(
      await registry.sessionStore.sessions.listSnoozes(firstAdminMemberId()),
    ).not.toHaveProperty(sessionId)
    expect(await cursorOf(registry)).toBe(cursor)
    expect(await registry.changeLedger.changesSince(cursor)).toEqual([])

    registry.modules.sessions.broadcastSessions()
    await registry.modules.sessions.flushBroadcasts()
    expect(
      (await clientSessionViews(registry)).find((s) => s.sessionId === sessionId)?.snoozedUntil,
    ).toBeUndefined()
    expect(await feedDelta(registry, cursor, CHANGE_LOG_OBSERVER)).toMatchObject({
      kind: 'delta',
      cursor,
      changes: [],
    })

    // Same future deadline as the failed attempt, for the same reason: a lapsed
    // timed snooze is pruned on read and would produce no change to project.
    await registry.modules.sessions.setSnooze(registry.modules.sessions.serverWriter, {
      userId: firstAdminMemberId(),
      sessionId,
      until: '2999-07-20T12:00:00.000Z',
    })
    const delta = await feedDelta(registry, cursor, {
      kind: 'user',
      user: firstAdminMemberId(),
      device: asDeviceId('snooze-reader'),
      capability: asCapabilityRef('snooze-reader'),
    })
    expect(delta.changes).toHaveLength(1)
    expect(delta.changes[0]).toMatchObject({
      entity: 'sessionUserState',
      value: { snoozedUntil: '2999-07-20T12:00:00.000Z' },
    })
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
    vi.spyOn(registry.sessionStore.observationCheckpoints, 'get').mockResolvedValue(
      checkpointRecord as never,
    )

    await registry.modules.sessions.killSession(registry.modules.sessions.serverWriter, {
      sessionId,
    })

    await vi.waitFor(async () => {
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
  })

  it('(k) a failed change append on kill leaves the session fully live (#247)', async () => {
    const registry = await makeRegistry()
    const { sessionId } = await registry.modules.sessions.createSession({
      agentKind: 'shell',
      cwd: '/w',
    })
    await registry.modules.sessions.flushBroadcasts()
    const cursor = await cursorOf(registry)
    const spy = vi.spyOn(registry.sessionStore.sync, 'appendChanges').mockImplementationOnce(() => {
      throw new Error('append failed')
    })
    await expect(
      registry.modules.sessions.killSession(registry.modules.sessions.serverWriter, { sessionId }),
    ).rejects.toThrow('append failed')
    spy.mockRestore()
    // Memory truth survived: the session is still listed; the store rolled the
    // tombstone write back inside the same transact span.
    expect((await clientSessionViews(registry)).some((s) => s.sessionId === sessionId)).toBe(true)
    expect(
      (await registry.sessionStore.sessions.loadSessions()).some((r) => r.id === sessionId),
    ).toBe(true)
    expect(await registry.sessionStore.sessions.loadDeletedSessions()).toEqual([])
    // A subsequent broadcast is snapshot-only and appends NOTHING for the untouched entity.
    registry.modules.sessions.broadcastSessions()
    await registry.modules.sessions.flushBroadcasts()
    const healed = await feedDelta(registry, cursor, CHANGE_LOG_OBSERVER)
    expect(healed.changes.filter((c) => c.entity === 'session')).toEqual([])
    // And the kill still works once the append path recovers.
    await registry.modules.sessions.killSession(registry.modules.sessions.serverWriter, {
      sessionId,
    })
    expect((await clientSessionViews(registry)).some((s) => s.sessionId === sessionId)).toBe(false)
    expect(await registry.sessionStore.sessions.loadDeletedSessions()).toEqual([
      expect.objectContaining({ id: sessionId, deletionSource: 'standalone' }),
    ])
  })

  // POD-797: deleted the session-derived issue append retry test with the wire path it exercised.
  it('replaying the whole durable log folds to the live session list', async () => {
    const registry = await makeRegistry()
    const a = await registry.modules.sessions.createSession({ agentKind: 'shell', cwd: '/w1' })
    const b = await registry.modules.sessions.createSession({ agentKind: 'shell', cwd: '/w2' })
    await registry.modules.sessions.renameSession(registry.modules.sessions.serverWriter, {
      sessionId: a.sessionId,
      name: 'kept',
    })
    await registry.modules.sessions.killSession(registry.modules.sessions.serverWriter, {
      sessionId: b.sessionId,
    })
    const healed = await feedDelta(registry, 0, CHANGE_LOG_OBSERVER)
    const folded = new Map<string, unknown>()
    for (const c of healed.changes) {
      if (c.entity !== 'session') continue
      if (c.op === 'upsert') folded.set(c.id, c.value)
      else folded.delete(c.id)
    }
    const live = await registry.modules.sessions.listSessions(undefined, 'rpc')
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
    await registry.modules.sessions.flushBroadcasts()

    const listed = (await registry.modules.sessions.listSessions(undefined, 'rpc')).find(
      (s) => s.sessionId === sessionId,
    )
    expect(listed).toBeDefined()

    const after = await feedDelta(registry, cursor, CHANGE_LOG_OBSERVER)
    const broadcast = (
      after.changes.find(
        (c) => c.entity === 'session' && c.id === sessionId && c.op === 'upsert',
      ) as { value?: SessionMeta } | undefined
    )?.value
    expect(broadcast).toBeDefined()

    // The whole payload, not a chosen field: a per-field assertion would go stale
    // the moment the mapper gains a key, which is exactly the drift being deleted.
    expect(listed).toEqual(broadcast)

    // The mapper sends source identity; the client joins the display name.
    expect(listed?.machineId).toBe(registry.sessionStore.hostMachineId)
    expect(listed).not.toHaveProperty('machineName')
  })
})

/**
 * Feed identity on the wire (ADR 2 D1/D5) at the REAL registry, so these pin the
 * production wiring rather than a stub: the worker bootstrap and direct
 * Authority read share the identity the delta client receives.
 */
describe('feed identity on the wire (ADR 2 D1/D5)', () => {
  const registries: SessionRegistry[] = []
  afterEach(async () => {
    for (const r of registries.splice(0)) await r.dispose()
    vi.useRealTimers()
  })

  async function makeRegistry(): Promise<SessionRegistry> {
    const registry = await SessionRegistry.create(undefined, undefined, { instanceId: 'default' })
    registries.push(registry)
    // Sessions are placed only on an assigned machine with a daemon (34aa06cf2).
    await attachHostDaemon(registry, () => {})
    return registry
  }

  /** A client whose hello advertises exactly `caps`. */
  async function client(
    registry: SessionRegistry,
    caps: string[],
  ): Promise<{ inbox: ServerMessage[] }> {
    const inbox: ServerMessage[] = []
    const id = attachTestClient(registry.clientGateway, (msg) => inbox.push(msg))
    await registry.clientGateway.routeClientFrame(id, {
      type: 'hello',
      clientId: '',
      wireVersion: CLIENT_WIRE_VERSION,
      viewport: { cols: 80, rows: 24, dpr: 1 },
      caps: ['sync.http.v1', ...caps],
    })
    await vi.waitFor(() => {
      expect(inbox.some((message) => message.type === 'feedResume')).toBe(true)
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
    const boot = await authoritySnapshot(registry)
    expect(boot.feedId).toBeTruthy()
    expect(boot.epoch).toBeTruthy()
    expect(boot.feedId).not.toBe(boot.epoch)
    expect(boot.minAvailableSeq).toBeGreaterThanOrEqual(1)
  })

  it('(c) the delta arm carries the SAME identity as the snapshot arm', async () => {
    // One authority, one feed: a client that bootstraps and then catches up must
    // not see the identity change under it, or it would re-bootstrap forever.
    const registry = await makeRegistry()
    const boot = await authoritySnapshot(registry)
    await registry.modules.sessions.createSession({ agentKind: 'shell', cwd: '/w' })
    const catchUp = await feedDelta(registry, boot.cursor, CHANGE_LOG_OBSERVER)
    expect(catchUp.feedId).toBe(boot.feedId)
    expect(catchUp.epoch).toBe(boot.epoch)
    expect(catchUp.minAvailableSeq).toBeGreaterThanOrEqual(1)
  })

  it('publishes minAvailableSeq consistently with what it will actually serve', async () => {
    const registry = await makeRegistry()
    await registry.modules.sessions.createSession({ agentKind: 'shell', cwd: '/w' })
    const reply = await authoritySnapshot(registry)
    const horizon = reply.minAvailableSeq as number
    // Nothing has been pruned, so the whole log is servable and the horizon is
    // the log's first seq — a replica at cursor 0 must NOT be told to re-bootstrap.
    expect(horizon).toBe(1)
    await feedDelta(registry, 0, CHANGE_LOG_OBSERVER)
  })

  it('serves identity on every production wire-v2 delta', async () => {
    const registry = await makeRegistry()
    const asked = await client(registry, ['metadataDelta', 'syncFeedIdentity'])
    const baseline = await client(registry, ['metadataDelta'])
    asked.inbox.length = 0
    baseline.inbox.length = 0

    await registry.modules.sessions.createSession({ agentKind: 'shell', cwd: '/w' })
    registry.modules.funnel.flushDeltas()

    await vi.waitFor(() => {
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
    })
    const identity = await authoritySnapshot(registry)
    expect(identity.feedId).toBeTruthy()
    expect(identity.epoch).toBeTruthy()
  })

  it('both clients receive the SAME changes in the SAME order — the cap changes the envelope, never the feed', async () => {
    const registry = await makeRegistry()
    const withIdentity = await client(registry, ['metadataDelta', 'syncFeedIdentity'])
    const legacy = await client(registry, ['metadataDelta'])
    withIdentity.inbox.length = 0
    legacy.inbox.length = 0

    await registry.modules.sessions.createSession({ agentKind: 'shell', cwd: '/w' })
    registry.modules.funnel.flushDeltas()
    await registry.modules.sessions.createSession({ agentKind: 'shell', cwd: '/w' })
    registry.modules.funnel.flushDeltas()

    const strip = (m: ServerMessage[]) => deltas(m).map((d) => ({ seq: d.seq, changes: d.changes }))
    await vi.waitFor(() => {
      expect(deltas(withIdentity.inbox).at(-1)?.seq).toBeGreaterThan(0)
      expect(strip(withIdentity.inbox)).toEqual(strip(legacy.inbox))
    })
  })
})
