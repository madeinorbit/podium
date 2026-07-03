import type { IssueWire, SyncChangesSinceResult } from '@podium/protocol'
import { encode, type ServerMessage } from '@podium/protocol'
import { describe, expect, it, vi } from 'vitest'
import { SocketHub, type WebSocketLike } from './connection'

class FakeSocket implements WebSocketLike {
  sent: string[] = []
  onopen: ((ev: unknown) => void) | null = null
  onmessage: ((ev: { data: unknown }) => void) | null = null
  onclose: ((ev: unknown) => void) | null = null
  onerror: ((ev: unknown) => void) | null = null
  send(data: string): void {
    this.sent.push(data)
  }
  close(): void {
    this.onclose?.({})
  }
  open(): void {
    this.onopen?.({})
  }
  recv(msg: ServerMessage): void {
    this.onmessage?.({ data: encode(msg) })
  }
  parsed(): Array<Record<string, unknown>> {
    return this.sent.map((s) => JSON.parse(s) as Record<string, unknown>)
  }
}

const flush = () => new Promise((r) => setTimeout(r, 0))

// Must satisfy the real IssueWire zod schema: the hub's lenient parser quarantines
// invalid change rows and treats a quarantined delta as a cursor gap (a heal),
// so a sloppy fixture would silently test the WRONG code path.
const issue = (id: string, title: string): IssueWire => ({
  id,
  repoPath: '/r',
  seq: 1,
  title,
  description: '',
  stage: 'backlog',
  worktreePath: null,
  branch: null,
  parentBranch: 'main',
  defaultAgent: 'claude-code',
  defaultModel: 'auto',
  defaultEffort: 'auto',
  blockedBy: [],
  priority: 2,
  type: 'task',
  pinned: false,
  needsHuman: false,
  labels: [],
  deps: [],
  dependents: [],
  comments: [],
  ready: true,
  blocked: false,
  deferred: false,
  childCount: 0,
  childDoneCount: 0,
  createdAt: '2026-07-01T00:00:00.000Z',
  updatedAt: '2026-07-01T00:00:00.000Z',
  archived: false,
  sessions: [],
  sessionSummary: { total: 0, byPhase: {} },
})

const snapshot = (cursor: number, issues: IssueWire[] = []): SyncChangesSinceResult => ({
  kind: 'snapshot',
  sessions: [],
  issues,
  conversations: [],
  diagnostics: [],
  cursor,
})

function setup(
  results: Array<SyncChangesSinceResult | Error>,
  extra: Partial<ConstructorParameters<typeof SocketHub>[0]> = {},
) {
  const sock = new FakeSocket()
  const calls: Array<number | null> = []
  const fetchChangesSince = vi.fn((cursor: number | null) => {
    calls.push(cursor)
    const next = results.shift()
    if (next === undefined) return new Promise<SyncChangesSinceResult>(() => {}) // hang
    return next instanceof Error ? Promise.reject(next) : Promise.resolve(next)
  })
  const hub = new SocketHub({
    url: 'ws://x',
    viewport: { cols: 80, rows: 24, dpr: 1 },
    makeSocket: () => sock,
    fetchChangesSince,
    ...extra,
  })
  return { sock, hub, calls }
}

// Delta-mode SocketHub (docs/spec/oplog-read-path.md §2.4): caps negotiation,
// cursor bootstrap via changesSince, in-order delta application, and gap healing.
describe('SocketHub metadata delta mode', () => {
  it('advertises the cap in hello only when a fetcher is wired', () => {
    const { sock, hub } = setup([snapshot(0)])
    hub.connect()
    sock.open()
    expect(sock.parsed().find((m) => m.type === 'hello')?.caps).toEqual(['metadataDelta'])

    const plain = new FakeSocket()
    const legacy = new SocketHub({
      url: 'ws://x',
      viewport: { cols: 80, rows: 24, dpr: 1 },
      makeSocket: () => plain,
    })
    legacy.connect()
    plain.open()
    expect(plain.parsed().find((m) => m.type === 'hello')?.caps).toBeUndefined()
  })

  it('bootstraps lists + cursor from the snapshot, then applies deltas in order', async () => {
    const { sock, hub, calls } = setup([snapshot(5, [issue('a', 'one')])])
    const seen: string[][] = []
    hub.onIssues((i) => seen.push(i.map((x) => x.title)))
    hub.connect()
    sock.open()
    await flush()
    expect(calls).toEqual([null])
    expect(hub.issues().map((i) => i.title)).toEqual(['one'])

    sock.recv({
      type: 'metadataDelta',
      seq: 6,
      changes: [{ seq: 6, entity: 'issue', id: 'b', op: 'upsert', value: issue('b', 'two') }],
    })
    expect(hub.issues().map((i) => i.title)).toEqual(['one', 'two'])
    // Upsert replaces in place; remove drops.
    sock.recv({
      type: 'metadataDelta',
      seq: 8,
      changes: [
        { seq: 7, entity: 'issue', id: 'a', op: 'upsert', value: issue('a', 'one v2') },
        { seq: 8, entity: 'issue', id: 'b', op: 'remove' },
      ],
    })
    expect(hub.issues().map((i) => i.title)).toEqual(['one v2'])
    expect(seen.at(-1)).toEqual(['one v2'])
  })

  it('ignores stale batches and heals on a seq gap', async () => {
    const { sock, hub, calls } = setup([
      snapshot(5),
      { kind: 'delta', changes: [], cursor: 9 }, // the heal response for the gap
    ])
    hub.connect()
    sock.open()
    await flush()
    // Entirely stale (seq <= cursor): dropped without a heal.
    sock.recv({ type: 'metadataDelta', seq: 4, changes: [] })
    expect(calls).toEqual([null])
    // Gap (next expected is 6, got 8): must refetch from the held cursor.
    sock.recv({
      type: 'metadataDelta',
      seq: 8,
      changes: [{ seq: 8, entity: 'issue', id: 'x', op: 'upsert', value: issue('x', 'late') }],
    })
    await flush()
    expect(calls).toEqual([null, 5])
    // Post-heal cursor moved to 9: a 6..9 replay would now be stale, a 10 applies.
    sock.recv({
      type: 'metadataDelta',
      seq: 10,
      changes: [{ seq: 10, entity: 'issue', id: 'y', op: 'upsert', value: issue('y', 'next') }],
    })
    expect(hub.issues().map((i) => i.title)).toEqual(['next'])
  })

  it('queues deltas that race the bootstrap and drains them after', async () => {
    let resolveBoot: ((r: SyncChangesSinceResult) => void) | undefined
    const sock = new FakeSocket()
    const hub = new SocketHub({
      url: 'ws://x',
      viewport: { cols: 80, rows: 24, dpr: 1 },
      makeSocket: () => sock,
      fetchChangesSince: () =>
        new Promise<SyncChangesSinceResult>((r) => {
          resolveBoot = r
        }),
    })
    hub.connect()
    sock.open()
    // Delta lands while the snapshot fetch is still in flight.
    sock.recv({
      type: 'metadataDelta',
      seq: 6,
      changes: [{ seq: 6, entity: 'issue', id: 'b', op: 'upsert', value: issue('b', 'raced') }],
    })
    expect(hub.issues()).toEqual([])
    resolveBoot?.(snapshot(5, [issue('a', 'base')]))
    await flush()
    expect(hub.issues().map((i) => i.title)).toEqual(['base', 'raced'])
  })

  it('treats a quarantined delta element as a gap and heals', async () => {
    const { sock, hub, calls } = setup([snapshot(5), { kind: 'delta', changes: [], cursor: 7 }])
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    hub.connect()
    sock.open()
    await flush()
    // Raw frame with one poisoned change row (bad entity) — the lenient parser
    // drops it, which for a delta stream is an invisible hole -> heal, not apply.
    sock.onmessage?.({
      data: JSON.stringify({
        type: 'metadataDelta',
        seq: 7,
        changes: [
          { seq: 6, entity: 'issue', id: 'ok', op: 'upsert', value: issue('ok', 'fine') },
          { seq: 7, entity: 'nope', id: 'bad', op: 'upsert', value: {} },
        ],
      }),
    })
    await flush()
    expect(calls).toEqual([null, 5])
    expect(hub.issues()).toEqual([]) // nothing applied from the poisoned batch
    warn.mockRestore()
  })

  it('initialCursor drives the FIRST changesSince; later heals use the live cursor', async () => {
    const { sock, hub, calls } = setup(
      [
        // Warm reload within retention → the server answers with a delta.
        {
          kind: 'delta',
          changes: [{ seq: 6, entity: 'issue', id: 'a', op: 'upsert', value: issue('a', 'one') }],
          cursor: 6,
        },
        { kind: 'delta', changes: [], cursor: 9 }, // the gap heal below
      ],
      { initialCursor: 5 },
    )
    hub.connect()
    sock.open()
    await flush()
    expect(calls).toEqual([5])
    expect(hub.issues().map((i) => i.title)).toEqual(['one'])
    // A live gap heals from the LIVE cursor (6), not the spent initialCursor.
    sock.recv({
      type: 'metadataDelta',
      seq: 8,
      changes: [{ seq: 8, entity: 'issue', id: 'x', op: 'upsert', value: issue('x', 'late') }],
    })
    await flush()
    expect(calls).toEqual([5, 6])
  })

  it('initialCursor with a compaction fallback still full-replaces from the snapshot', async () => {
    const { sock, hub, calls } = setup([snapshot(20, [issue('s', 'from snapshot')])], {
      initialCursor: 5,
    })
    hub.seedMetadata({ sessions: [], issues: [issue('old', 'stale seed')], conversations: [] })
    hub.connect()
    sock.open()
    await flush()
    expect(calls).toEqual([5])
    // The snapshot replaced the seeded list wholesale — gap-heal semantics unchanged.
    expect(hub.issues().map((i) => i.title)).toEqual(['from snapshot'])
  })

  it('a reconnect after a spent initialCursor without a live cursor falls back to null', async () => {
    // First heal (with initialCursor) FAILS — the cursor never establishes.
    vi.useFakeTimers()
    try {
      const { sock, hub, calls } = setup([new Error('blip'), snapshot(3)], { initialCursor: 7 })
      hub.connect()
      sock.open()
      await vi.advanceTimersByTimeAsync(0)
      expect(calls).toEqual([7])
      // The retry must NOT reuse the spent initialCursor: null → full snapshot.
      await vi.advanceTimersByTimeAsync(3_000)
      expect(calls).toEqual([7, null])
    } finally {
      vi.useRealTimers()
    }
  })

  it('seedMetadata paints lists + notifies observers, and server truth supersedes it', async () => {
    const { sock, hub } = setup([snapshot(5, [issue('a', 'server')])])
    const seen: string[][] = []
    hub.onIssues((i) => seen.push(i.map((x) => x.title)))
    hub.seedMetadata({ sessions: [], issues: [issue('local', 'replica')], conversations: [] })
    // Hydrate-first: the seed is visible before any socket traffic.
    expect(hub.issues().map((i) => i.title)).toEqual(['replica'])
    expect(seen.at(-1)).toEqual(['replica'])
    hub.connect()
    sock.open()
    await flush()
    // Reconcile-on-snapshot: final state = server state.
    expect(hub.issues().map((i) => i.title)).toEqual(['server'])
    // A late seed (e.g. slow hydrate losing the race) can no longer clobber it.
    hub.seedMetadata({ sessions: [], issues: [issue('late', 'stale')], conversations: [] })
    expect(hub.issues().map((i) => i.title)).toEqual(['server'])
  })

  it('a delta first-heal applies onto seeded lists (warm reload catch-up)', async () => {
    const { sock, hub, calls } = setup(
      [
        {
          kind: 'delta',
          changes: [
            { seq: 6, entity: 'issue', id: 'a', op: 'upsert', value: issue('a', 'a v2') },
            { seq: 7, entity: 'issue', id: 'b', op: 'remove' },
          ],
          cursor: 7,
        },
      ],
      { initialCursor: 5 },
    )
    hub.seedMetadata({
      sessions: [],
      issues: [issue('a', 'a v1'), issue('b', 'gone soon'), issue('c', 'untouched')],
      conversations: [],
    })
    hub.connect()
    sock.open()
    await flush()
    expect(calls).toEqual([5])
    expect(hub.issues().map((i) => i.title)).toEqual(['a v2', 'untouched'])
  })

  it('onMetadataApplied fires after each applied batch with cursor + lists', async () => {
    const applied: Array<{ cursor: number; issues: string[] }> = []
    const { sock, hub } = setup([snapshot(5, [issue('a', 'one')])], {
      onMetadataApplied: (s) =>
        applied.push({ cursor: s.cursor, issues: s.issues.map((i) => i.title) }),
    })
    hub.connect()
    sock.open()
    await flush()
    expect(applied).toEqual([{ cursor: 5, issues: ['one'] }])
    // Live delta → another emission with the advanced cursor.
    sock.recv({
      type: 'metadataDelta',
      seq: 6,
      changes: [{ seq: 6, entity: 'issue', id: 'b', op: 'upsert', value: issue('b', 'two') }],
    })
    expect(applied).toEqual([
      { cursor: 5, issues: ['one'] },
      { cursor: 6, issues: ['one', 'two'] },
    ])
  })

  it('a failed heal retries on a timer while the socket is up', async () => {
    vi.useFakeTimers()
    try {
      const { sock, hub, calls } = setup([new Error('blip'), snapshot(3, [issue('a', 'ok')])])
      hub.connect()
      sock.open()
      await vi.advanceTimersByTimeAsync(0)
      expect(calls).toEqual([null])
      await vi.advanceTimersByTimeAsync(3_000) // HEAL_RETRY_MS
      expect(calls).toEqual([null, null])
      expect(hub.issues().map((i) => i.title)).toEqual(['ok'])
    } finally {
      vi.useRealTimers()
    }
  })
})
