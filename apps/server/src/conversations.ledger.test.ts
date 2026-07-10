import type { ConversationSummaryWire, MetadataChange, ServerMessage } from '@podium/protocol'
import { Ledger } from '@podium/sync'
import { afterEach, describe, expect, it } from 'vitest'
import { SessionRegistry } from './relay'
import { SessionStore } from './store'

/**
 * Conversation writes on the write-seam Ledger ([spec:SP-3fe2] #257 — the LAST
 * entity kind; after this the legacy diff-at-broadcast oplog records nothing):
 * discovery upserts/deletes commit atomically with their store writes (the
 * store's own transaction() spans nest as savepoints), volatile-field churn
 * dedups via the built-in conversation projection, setConversationMeta is no
 * longer a silent store write, boot deliberately does NOT reconcile (daemon-fed
 * entity — the folded baseline dedups the first post-restart scan instead),
 * and diagnostics keep riding snapshots, never deltas.
 */
describe('conversation writes on the write-seam Ledger ([spec:SP-3fe2] #257)', () => {
  const registries: SessionRegistry[] = []
  afterEach(() => {
    for (const r of registries.splice(0)) r.dispose()
  })

  function makeRegistry(store?: SessionStore): SessionRegistry {
    const registry = new SessionRegistry(store)
    registries.push(registry)
    return registry
  }

  const conv = (
    id: string,
    extra: Partial<ConversationSummaryWire> = {},
  ): ConversationSummaryWire =>
    ({ id, agentKind: 'claude-code', providerId: 'claude-code-jsonl', ...extra }) as never

  function push(
    registry: SessionRegistry,
    conversations: ConversationSummaryWire[],
    opts: {
      diagnostics?: { severity: 'warning' | 'error'; message: string }[]
      removed?: string[]
    } = {},
  ): void {
    registry.modules.sessions.onDaemonMessageFrom('m1', {
      type: 'conversationsChanged',
      conversations,
      diagnostics: opts.diagnostics ?? [],
      ...(opts.removed ? { removed: opts.removed } : {}),
    })
  }

  function client(registry: SessionRegistry, caps: string[] = []): { inbox: ServerMessage[] } {
    const inbox: ServerMessage[] = []
    const id = registry.modules.sessions.attachClient((msg) => inbox.push(msg))
    registry.modules.sessions.onClientMessage(id, {
      type: 'hello',
      clientId: '',
      viewport: { cols: 80, rows: 24, dpr: 1 },
      ...(caps.length ? { caps } : {}),
    })
    return { inbox }
  }

  const cursorOf = (registry: SessionRegistry): number =>
    registry.modules.sessions.syncChangesSince(null).cursor

  const conversationChangesSince = (
    registry: SessionRegistry,
    cursor: number,
  ): MetadataChange[] => {
    const healed = registry.modules.sessions.syncChangesSince(cursor)
    if (healed.kind !== 'delta') throw new Error('expected a delta read')
    return healed.changes.filter((c) => c.entity === 'conversation')
  }

  const deltaConversationChanges = (inbox: ServerMessage[]): MetadataChange[] =>
    inbox
      .flatMap((m) => (m.type === 'metadataDelta' ? m.changes : []))
      .filter((c) => c.entity === 'conversation')

  it('(a) a throw between the store writes and the change append rolls BOTH back (nested-savepoint layering)', () => {
    const store = new SessionStore(':memory:')
    const ledger = new Ledger({
      repo: store.sync,
      now: () => 1_000,
      transact: (fn) => store.transact(fn),
    })
    // Seed one row so the delete half of the batch has something to bite on.
    store.conversations.upsertConversations([
      { id: 'c-old', agentKind: 'claude-code', providerId: 'p' },
    ])
    const cursorBefore = ledger.cursor()
    expect(() =>
      ledger.commit({
        // BOTH store methods open their own transaction() internally — inside
        // the ledger's transact span they degrade to savepoints (depth 1), and
        // the outer rollback must unwind them together.
        write: () => {
          store.conversations.upsertConversations([
            { id: 'c-new', agentKind: 'claude-code', providerId: 'p' },
          ])
          store.conversations.deleteConversations(['c-old'])
        },
        changes: () => {
          throw new Error('declaration failed')
        },
      }),
    ).toThrow('declaration failed')
    const ids = store.conversations.searchConversations({}).map((r) => r.id)
    expect(ids).toContain('c-old') // delete rolled back
    expect(ids).not.toContain('c-new') // upsert rolled back
    expect(ledger.cursor()).toBe(cursorBefore)

    // And the same nested layering COMMITS as one unit when nothing throws.
    ledger.commit({
      write: () => {
        store.conversations.upsertConversations([
          { id: 'c-new', agentKind: 'claude-code', providerId: 'p' },
        ])
        store.conversations.deleteConversations(['c-old'])
      },
      changes: () => [
        { entity: 'conversation', id: 'c-new', op: 'upsert', value: { id: 'c-new' } },
      ],
    })
    const after = store.conversations.searchConversations({}).map((r) => r.id)
    expect(after).toContain('c-new')
    expect(after).not.toContain('c-old')
    expect(ledger.cursor()).toBe(cursorBefore + 1)
  })

  it('(a2) a discovery push with `removed` commits the remove durably with the row delete', () => {
    const registry = makeRegistry()
    registry.modules.sessions.attachDaemon('m1', () => {})
    push(registry, [conv('c1'), conv('c2')])
    const cursor = cursorOf(registry)
    push(registry, [conv('c1')], { removed: ['c2'] })
    const changes = conversationChangesSince(registry, cursor)
    expect(changes.some((c) => c.id === 'c2' && c.op === 'remove')).toBe(true)
    expect(
      registry.sessionStore.conversations.searchConversations({}).map((r) => r.id),
    ).not.toContain('c2')
  })

  it('(b) volatile-only churn appends NOTHING; a stable-field change appends the FULL wire payload', () => {
    const registry = makeRegistry()
    registry.modules.sessions.attachDaemon('m1', () => {})
    push(registry, [
      conv('c1', {
        title: 't',
        updatedAt: '2026-07-01T00:00:00Z',
        messageCount: 1,
        statusHint: 'idle',
      }),
    ])
    const cursor = cursorOf(registry)
    // Volatile fields only (updatedAt/messageCount/statusHint) — the scan-storm
    // churn the conversation projection exists to drop.
    push(registry, [
      conv('c1', {
        title: 't',
        updatedAt: '2026-07-02T00:00:00Z',
        messageCount: 9,
        statusHint: 'busy',
      }),
    ])
    expect(conversationChangesSince(registry, cursor)).toEqual([])
    // A stable field (title) changes → ONE append carrying the FULL wire value,
    // volatile fields included at their current values.
    push(registry, [
      conv('c1', {
        title: 't2',
        updatedAt: '2026-07-03T00:00:00Z',
        messageCount: 12,
        statusHint: 'idle',
      }),
    ])
    const changes = conversationChangesSince(registry, cursor)
    expect(changes).toHaveLength(1)
    const value = (changes[0] as { value?: ConversationSummaryWire }).value
    expect(value?.title).toBe('t2')
    expect(value?.updatedAt).toBe('2026-07-03T00:00:00Z')
    expect(value?.messageCount).toBe(12)
    expect(value?.statusHint).toBe('idle')
    expect(value?.podiumId).toMatch(/^conv_/) // the broadcast enrichment IS the committed payload
  })

  it('(c) setConversationMeta reaches the change log AND the snapshot fan-out (the silent-write fix)', () => {
    const registry = makeRegistry()
    registry.modules.sessions.attachDaemon('m1', () => {})
    push(registry, [conv('c1', { title: 't' })])
    const legacy = client(registry)
    const delta = client(registry, ['metadataDelta'])
    const cursor = cursorOf(registry)
    const legacyBefore = legacy.inbox.length
    const deltaBefore = delta.inbox.length
    registry.modules.conversations.setConversationMeta({ id: 'c1', name: 'My run', summary: 'sum' })
    registry.modules.sessions.flushBroadcasts()
    // Durable: the curated wire row is in the change log…
    const changes = conversationChangesSince(registry, cursor)
    expect(changes).toHaveLength(1)
    const value = (changes[0] as { value?: ConversationSummaryWire }).value
    expect(value?.name).toBe('My run')
    expect(value?.summary).toBe('sum')
    // …and live on BOTH planes: the delta client got the metadataDelta…
    const deltaChanges = deltaConversationChanges(delta.inbox.slice(deltaBefore))
    expect(
      deltaChanges.some((c) => (c as { value?: ConversationSummaryWire }).value?.name === 'My run'),
    ).toBe(true)
    // …and the legacy client got a conversationsChanged snapshot carrying the name.
    const snap = legacy.inbox
      .slice(legacyBefore)
      .filter((m) => m.type === 'conversationsChanged')
      .at(-1)
    if (snap?.type !== 'conversationsChanged') throw new Error('no snapshot fan-out')
    expect(snap.conversations.find((c) => c.id === 'c1')?.name).toBe('My run')
    // The store write itself landed too (the original behavior, now seam-bound).
    expect(
      registry.sessionStore.conversations.searchConversations({}).find((r) => r.id === 'c1')?.name,
    ).toBe('My run')
    // A later identical discovery push must NOT flap the log: the curated meta
    // is overlaid onto scan rows, so the re-committed wire is byte-stable.
    const cursor2 = cursorOf(registry)
    push(registry, [conv('c1', { title: 't' })])
    expect(conversationChangesSince(registry, cursor2)).toEqual([])
  })

  it('(c2) setConversationMeta on an undiscovered id commits the write with no wire change', () => {
    const registry = makeRegistry()
    const cursor = cursorOf(registry)
    registry.modules.conversations.setConversationMeta({ id: 'ghost', name: 'n' })
    // No broadcast row exists for it — nothing declared, nothing appended…
    expect(conversationChangesSince(registry, cursor)).toEqual([])
    // …but the store write (placeholder insert + meta) still landed.
    expect(
      registry.sessionStore.conversations.searchConversations({}).find((r) => r.id === 'ghost')
        ?.name,
    ).toBe('n')
  })

  it('(d) restart: the baseline folds from the retained log — no boot reconcile, and the first scan dedups', () => {
    const store = new SessionStore(':memory:')
    const first = new SessionRegistry(store)
    first.modules.sessions.attachDaemon('m1', () => {})
    push(first, [conv('c1', { title: 't' }), conv('c2')])
    first.dispose()
    const cursor = first.modules.sessions.syncChangesSince(null).cursor
    // Restart over the same store. Conversations are daemon-fed: boot must NOT
    // reconcile them (an empty list means "not scanned yet", not "all gone").
    const second = makeRegistry(store)
    expect(conversationChangesSince(second, cursor)).toEqual([])
    second.modules.sessions.attachDaemon('m1', () => {})
    // First post-restart scan re-reports the same conversations: the folded
    // baseline dedups it — no spurious full re-append.
    push(second, [conv('c1', { title: 't' }), conv('c2')])
    expect(conversationChangesSince(second, cursor)).toEqual([])
    // A real change still lands.
    push(second, [conv('c1', { title: 'renamed' }), conv('c2')])
    const changes = conversationChangesSince(second, cursor)
    expect(changes.map((c) => c.id)).toEqual(['c1'])
  })

  it('(e) diagnostics ride snapshots ONLY — never the delta stream', () => {
    const registry = makeRegistry()
    registry.modules.sessions.attachDaemon('m1', () => {})
    const delta = client(registry, ['metadataDelta'])
    // Diagnostics changed → cap clients get the snapshot too (their only path
    // to scan-level diagnostics).
    push(registry, [conv('c1', { title: 't' })], {
      diagnostics: [{ severity: 'warning', message: 'scan hiccup' }],
    })
    registry.modules.sessions.flushBroadcasts()
    const snap = delta.inbox.filter((m) => m.type === 'conversationsChanged').at(-1)
    if (snap?.type !== 'conversationsChanged')
      throw new Error('cap client missed the diagnostics snapshot')
    expect(snap.diagnostics).toHaveLength(1)
    // Diagnostics unchanged + a conversation change → cap clients get ONLY the
    // metadataDelta (no snapshot re-send), and deltas carry no diagnostics.
    const before = delta.inbox.length
    push(registry, [conv('c1', { title: 't2' })], {
      diagnostics: [{ severity: 'warning', message: 'scan hiccup' }],
    })
    registry.modules.sessions.flushBroadcasts()
    const since = delta.inbox.slice(before)
    expect(since.some((m) => m.type === 'conversationsChanged')).toBe(false)
    expect(deltaConversationChanges(since).some((c) => c.id === 'c1')).toBe(true)
  })

  it('upstream mirror paths reconcile the local ∪ upstream UNION (removes included)', () => {
    const registry = makeRegistry()
    registry.modules.sessions.attachDaemon('m1', () => {})
    push(registry, [conv('c1')])
    const cursor = cursorOf(registry)
    registry.modules.conversations.setUpstreamConversations([conv('hub-1')])
    const added = conversationChangesSince(registry, cursor)
    expect(added.some((c) => c.id === 'hub-1' && c.op === 'upsert')).toBe(true)
    expect(added.some((c) => c.id === 'c1')).toBe(false) // local rows already recorded — union dedups
    // Hub drops the conversation → the union reconcile records the remove.
    registry.modules.conversations.setUpstreamConversations([])
    const removed = conversationChangesSince(registry, cursor)
    expect(removed.some((c) => c.id === 'hub-1' && c.op === 'remove')).toBe(true)
  })

  it('replaying the whole durable log folds to the live conversation list', () => {
    const registry = makeRegistry()
    registry.modules.sessions.attachDaemon('m1', () => {})
    push(registry, [conv('c1', { title: 't' }), conv('c2')])
    registry.modules.conversations.setConversationMeta({ id: 'c1', name: 'kept' })
    push(registry, [conv('c1', { title: 't' }), conv('c3')], { removed: ['c2'] })
    const healed = registry.modules.sessions.syncChangesSince(0)
    expect(healed.kind).toBe('delta')
    if (healed.kind !== 'delta') return
    const folded = new Map<string, unknown>()
    for (const c of healed.changes) {
      if (c.entity !== 'conversation') continue
      if (c.op === 'upsert') folded.set(c.id, c.value)
      else folded.delete(c.id)
    }
    const live = registry.modules.conversations.allConversations()
    expect([...folded.keys()].sort()).toEqual(live.map((c) => c.id).sort())
    expect(folded.get('c1')).toEqual(live.find((c) => c.id === 'c1'))
  })
})
