import type {
  AutomationRunWire,
  AutomationWire,
  IssueWire,
  SyncChangesSinceResult,
  SyncChangesSinceResultLenient,
} from '@podium/protocol'
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
  readAt: null,
  unread: false,
  origin: 'human',
  audience: 'human',
  draft: false,
  sessions: [],
  sessionSummary: { total: 0, byPhase: {} },
})

const automation = (
  id: string,
  name: string,
  sessionMode: AutomationWire['sessionMode'] = 'fresh',
): AutomationWire => ({
  id,
  name,
  enabled: true,
  repoPath: '/r',
  scheduleKind: 'cron',
  cron: '* * * * *',
  runAt: null,
  targetSessionId: null,
  agentKind: 'codex',
  model: 'auto',
  effort: 'auto',
  prompt: 'Run it.',
  sessionMode,
  nextRunAt: '2026-07-01T00:01:00.000Z',
  lastRunAt: null,
  createdAt: '2026-07-01T00:00:00.000Z',
})

const automationRun = (id: string, automationId: string): AutomationRunWire => ({
  id,
  automationId,
  firedAt: '2026-07-01T00:00:00.000Z',
  sessionId: 'sess_1',
  outcome: 'spawned',
  detail: null,
})

const snapshot = (
  cursor: number,
  issues: IssueWire[] = [],
): Extract<SyncChangesSinceResult, { kind: 'snapshot' }> => ({
  kind: 'snapshot',
  sessions: [],
  issues,
  conversations: [],
  diagnostics: [],
  cursor,
})

function setup(
  results: Array<SyncChangesSinceResultLenient | Error>,
  extra: Partial<ConstructorParameters<typeof SocketHub>[0]> = {},
) {
  const sock = new FakeSocket()
  const calls: Array<number | null> = []
  const fetchChangesSince = vi.fn((cursor: number | null) => {
    calls.push(cursor)
    const next = results.shift()
    if (next === undefined) return new Promise<SyncChangesSinceResultLenient>(() => {}) // hang
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

  it('bootstraps and incrementally updates durable automation definitions and runs', async () => {
    const initial = automation('aut_1', 'Nightly sweep')
    const initialRun = automationRun('arun_1', initial.id)
    const { sock, hub } = setup([
      {
        ...snapshot(5),
        automations: [initial],
        automationRuns: [initialRun],
      },
    ])
    const seen: string[][] = []
    hub.on('automations', (rows) => seen.push(rows.map((row) => row.name)))
    hub.connect()
    sock.open()
    await flush()

    expect(hub.automations()).toEqual([initial])
    expect(hub.automationRuns()).toEqual([initialRun])
    sock.recv({
      type: 'metadataDelta',
      seq: 7,
      changes: [
        {
          seq: 6,
          entity: 'automation',
          id: initial.id,
          op: 'upsert',
          value: automation(initial.id, 'Nightly sweep v2', 'resume'),
        },
        { seq: 7, entity: 'automationRun', id: initialRun.id, op: 'remove' },
      ],
    })

    expect(hub.automations()).toEqual([automation(initial.id, 'Nightly sweep v2', 'resume')])
    expect(hub.automationRuns()).toEqual([])
    expect(seen.at(-1)).toEqual(['Nightly sweep v2'])
  })

  it('ignores stale batches and heals on a seq gap', async () => {
    const { sock, hub, calls } = setup([
      snapshot(5),
      // The heal response for the gap: contiguous 6..9 from the requested
      // cursor (removes of unknown ids — no-ops). parseChangesSinceResult
      // (#247) rejects the old empty-delta-with-advanced-cursor shorthand,
      // which the real server never produces.
      {
        kind: 'delta',
        changes: [
          { seq: 6, entity: 'issue', id: 'q6', op: 'remove' },
          { seq: 7, entity: 'issue', id: 'q7', op: 'remove' },
          { seq: 8, entity: 'issue', id: 'q8', op: 'remove' },
          { seq: 9, entity: 'issue', id: 'q9', op: 'remove' },
        ],
        cursor: 9,
      },
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

  it('accepts filtered source ranges and advances across hidden-only rows', async () => {
    const { sock, hub, calls } = setup([snapshot(5)])
    hub.connect()
    sock.open()
    await flush()

    sock.recv({ type: 'metadataDelta', fromExclusive: 5, seq: 8, changes: [] })
    sock.recv({
      type: 'metadataDelta',
      fromExclusive: 8,
      seq: 10,
      changes: [{ seq: 10, entity: 'issue', id: 'visible', op: 'remove' }],
    })

    expect(calls).toEqual([null])
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
    const { sock, hub, calls } = setup([
      snapshot(5),
      // Heal response: contiguous 6..7 (removes — the poisoned upsert is
      // server-side history the client refetched; empty-with-advanced-cursor
      // is rejected by #247 validation).
      {
        kind: 'delta',
        changes: [
          { seq: 6, entity: 'issue', id: 'ok', op: 'remove' },
          { seq: 7, entity: 'issue', id: 'bad', op: 'remove' },
        ],
        cursor: 7,
      },
    ])
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    hub.connect()
    sock.open()
    await flush()
    // Raw frame with one poisoned change row (a KNOWN kind whose value fails
    // its schema) — the lenient parser drops it, which for a delta stream is
    // an invisible hole -> heal, not apply.
    sock.onmessage?.({
      data: JSON.stringify({
        type: 'metadataDelta',
        seq: 7,
        changes: [
          { seq: 6, entity: 'issue', id: 'ok', op: 'upsert', value: issue('ok', 'fine') },
          { seq: 7, entity: 'issue', id: 'bad', op: 'upsert', value: { not: 'an issue' } },
        ],
      }),
    })
    await flush()
    expect(calls).toEqual([null, 5])
    expect(hub.issues()).toEqual([]) // nothing applied from the poisoned batch
    warn.mockRestore()
  })

  it('a malformed KNOWN-kind element in a heal delta escalates to a snapshot heal — never installed, never skipped (#247)', async () => {
    const { sock, hub, calls } = setup([
      snapshot(5, [issue('a', 'base')]),
      // Heal for the gap below: a delta whose KNOWN-kind element carries a
      // malformed value. isKnownMetadataChange alone (an entity-string check)
      // would install {bogus:true} into the issue list and advance the cursor
      // past it permanently — the runtime parser rejects the whole result.
      {
        kind: 'delta',
        changes: [{ seq: 6, entity: 'issue', id: 'bad', op: 'upsert', value: { bogus: true } }],
        cursor: 6,
      } as unknown as SyncChangesSinceResultLenient,
      // Escalation: the null-cursor refetch answers with the full snapshot.
      snapshot(9, [issue('healed', 'from snapshot')]),
    ])
    hub.connect()
    sock.open()
    await flush()
    expect(calls).toEqual([null])
    // A live seq gap forces the heal.
    sock.recv({
      type: 'metadataDelta',
      seq: 8,
      changes: [{ seq: 8, entity: 'issue', id: 'x', op: 'upsert', value: issue('x', 'late') }],
    })
    await flush()
    // Heal from the live cursor → malformed → escalate to a null-cursor snapshot.
    expect(calls).toEqual([null, 5, null])
    // The snapshot replaced the lists wholesale; the bogus row never installed.
    expect(hub.issues().map((i) => i.title)).toEqual(['from snapshot'])
    // Cursor landed on the snapshot's cursor: seq 10 is contiguous, no re-heal.
    sock.recv({
      type: 'metadataDelta',
      seq: 10,
      changes: [{ seq: 10, entity: 'issue', id: 'y', op: 'upsert', value: issue('y', 'next') }],
    })
    await flush()
    expect(hub.issues().map((i) => i.title)).toEqual(['from snapshot', 'next'])
    expect(calls).toEqual([null, 5, null])
  })

  it('a malformed SNAPSHOT heal result is a failed heal: retried on the timer, nothing installed (#247)', async () => {
    vi.useFakeTimers()
    try {
      const { sock, hub, calls } = setup([
        // Bootstrap answers with a snapshot missing its arrays — malformed, and
        // with a null cursor there is nowhere to escalate: fail → retry timer.
        { kind: 'snapshot', cursor: 5 } as unknown as SyncChangesSinceResultLenient,
        snapshot(7, [issue('ok', 'valid')]),
      ])
      hub.connect()
      sock.open()
      await vi.advanceTimersByTimeAsync(0)
      expect(calls).toEqual([null])
      expect(hub.issues()).toEqual([]) // the malformed snapshot never installed
      await vi.advanceTimersByTimeAsync(3_000) // HEAL_RETRY_MS
      expect(calls).toEqual([null, null])
      expect(hub.issues().map((i) => i.title)).toEqual(['valid'])
    } finally {
      vi.useRealTimers()
    }
  })

  it('applies known kinds, ignores an UNKNOWN entity kind, and advances the cursor without healing ([spec:SP-3fe2] #258)', async () => {
    const { sock, hub, calls } = setup([snapshot(5)])
    const debug = vi.spyOn(console, 'debug').mockImplementation(() => {})
    hub.connect()
    sock.open()
    await flush()
    expect(calls).toEqual([null])
    // A NEWER server streams a batch with a kind this build doesn't know
    // ('machine'). The known changes apply, the unknown row is ignored (never
    // folded into the conversation list), and the cursor advances past it.
    sock.onmessage?.({
      data: JSON.stringify({
        type: 'metadataDelta',
        seq: 8,
        changes: [
          { seq: 6, entity: 'issue', id: 'a', op: 'upsert', value: issue('a', 'known') },
          { seq: 7, entity: 'machine', id: 'm1', op: 'upsert', value: { id: 'm1', os: 'linux' } },
          { seq: 8, entity: 'issue', id: 'b', op: 'upsert', value: issue('b', 'also known') },
        ],
      }),
    })
    await flush()
    expect(hub.issues().map((i) => i.title)).toEqual(['known', 'also known'])
    expect(hub.conversations()).toEqual([]) // the unknown row corrupted nothing
    expect(debug).toHaveBeenCalledWith(expect.stringContaining("unknown entity kind 'machine'"))
    // No heal loop: the cursor moved to 8, so the NEXT contiguous batch applies
    // cleanly and changesSince was never re-fetched.
    sock.recv({
      type: 'metadataDelta',
      seq: 9,
      changes: [{ seq: 9, entity: 'issue', id: 'a', op: 'remove' }],
    })
    await flush()
    expect(hub.issues().map((i) => i.title)).toEqual(['also known'])
    expect(calls).toEqual([null]) // bootstrap only — never healed
    debug.mockRestore()
  })

  it('a changesSince delta result carrying an unknown kind applies the known rows and lands on the result cursor', async () => {
    const { sock, hub, calls } = setup(
      [
        {
          kind: 'delta',
          changes: [
            { seq: 6, entity: 'issue', id: 'a', op: 'upsert', value: issue('a', 'known') },
            { seq: 7, entity: 'settings', id: 's1', op: 'upsert', value: { theme: 'dark' } },
          ],
          cursor: 7,
        },
      ],
      { initialCursor: 5 },
    )
    const debug = vi.spyOn(console, 'debug').mockImplementation(() => {})
    hub.connect()
    sock.open()
    await flush()
    expect(calls).toEqual([5])
    expect(hub.issues().map((i) => i.title)).toEqual(['known'])
    // Cursor landed on the result cursor (7): seq 8 is contiguous, no heal.
    sock.recv({
      type: 'metadataDelta',
      seq: 8,
      changes: [{ seq: 8, entity: 'issue', id: 'b', op: 'upsert', value: issue('b', 'next') }],
    })
    expect(hub.issues().map((i) => i.title)).toEqual(['known', 'next'])
    expect(calls).toEqual([5])
    debug.mockRestore()
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
        // The gap heal below: contiguous 7..9 from the LIVE cursor (6). An
        // empty delta with an advanced cursor is rejected by #247 validation.
        {
          kind: 'delta',
          changes: [
            { seq: 7, entity: 'issue', id: 'q7', op: 'remove' },
            { seq: 8, entity: 'issue', id: 'q8', op: 'remove' },
            { seq: 9, entity: 'issue', id: 'q9', op: 'remove' },
          ],
          cursor: 9,
        },
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
