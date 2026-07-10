import type { MetadataChange, ServerMessage, SessionMeta } from '@podium/protocol'
import { Ledger } from '@podium/sync'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { LOCAL_MACHINE_ID } from './local-machine'
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

  it('(h) upstream mirror sets and staleness flips reach the durable log (reconcile-at-broadcast, #247)', () => {
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
    // Mirror set: the hub-fed rows never persist() — only the broadcast sees them.
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
    // Mirror cleared: the reconcile's full-list remove-diff evicts the row.
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

  it('(i) startup adoption and a machine rename re-capture machineId/machineName (#247)', () => {
    const registry = makeRegistry()
    const { sessionId } = registry.modules.sessions.createSession({ agentKind: 'shell', cwd: '/w' })
    registry.modules.sessions.flushBroadcasts()
    const cursor = cursorOf(registry)
    // ensureLocalMachine → adoptPlaceholderRows rewrites machineId in memory and
    // in the store WITHOUT a persist(); its broadcast reconciles the flip in.
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
  })

  it('(j) the daemon-disconnect reconnecting flip reaches the durable log (#247)', () => {
    const registry = makeRegistry()
    const { sessionId } = registry.modules.sessions.createSession({ agentKind: 'shell', cwd: '/w' })
    // Attaching the local daemon adopts the placeholder session onto LOCAL_MACHINE_ID.
    registry.modules.sessions.attachDaemon(LOCAL_MACHINE_ID, () => {})
    registry.modules.sessions.flushBroadcasts()
    const cursor = cursorOf(registry)
    // The disconnect sweep flips live/starting → 'reconnecting' with NO persist;
    // only the broadcast reconcile captures it.
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
    // row delete back inside the same transact span.
    expect(registry.modules.sessions.listSessions().some((s) => s.sessionId === sessionId)).toBe(
      true,
    )
    expect(registry.sessionStore.sessions.loadSessions().some((r) => r.id === sessionId)).toBe(true)
    // A subsequent broadcast reconcile appends NOTHING for the untouched entity.
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
  })

  it('(l) a transient issue-append failure during an attach-driven broadcast is retried by the NEXT broadcast (#247)', () => {
    const registry = makeRegistry()
    // An issue whose wire embeds the session (SessionMeta[] member data) — so a
    // clientCount flip changes the ISSUE wire too, via the broadcast-tail
    // publishIssues() reconcile, with no issue write of its own.
    const issue = registry.issues.create({ repoPath: '/r', title: 'watched', startNow: false })
    const { sessionId } = registry.modules.sessions.createSession({
      agentKind: 'shell',
      cwd: '/w',
      issueId: issue.id,
    })
    registry.modules.sessions.flushBroadcasts()
    const cursor = cursorOf(registry)
    // Fail ONLY issue-entity appends: the attach-driven broadcast's session
    // reconcile (clientCount 0→1) must land, then publishIssues()' issue
    // reconcile throws — Codex's scenario. Before the fix the byte-skip cache
    // was already stamped, so every later same-bytes broadcast early-returned
    // and the embedded issue snapshot stayed stale FOREVER.
    const sync = registry.sessionStore.sync
    const realAppend = sync.appendChanges.bind(sync)
    const spy = vi.spyOn(sync, 'appendChanges').mockImplementation((rows, eventTime) => {
      if (rows.some((r) => r.entity === 'issue')) throw new Error('transient issue append failure')
      return realAppend(rows, eventTime)
    })
    const clientId = registry.modules.sessions.attachClient(() => {})
    expect(() =>
      registry.modules.sessions.onClientMessage(clientId, { type: 'attach', sessionId }),
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
    ) as { value?: { sessions?: Array<{ clientCount?: number }> } } | undefined
    expect(issueChange?.value?.sessions?.[0]?.clientCount).toBe(1)
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
