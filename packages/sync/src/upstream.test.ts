import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { IssueWire, SyncChangesSinceResultLenient } from '@podium/protocol'
import { afterAll, describe, expect, it, vi } from 'vitest'
import {
  normalizeUpstreamUrl,
  readOwnDaemonMachineId,
  UpstreamSync,
  type UpstreamTrpcClient,
} from './upstream'

describe('normalizeUpstreamUrl', () => {
  it('derives http+ws bases from any scheme, trailing slash tolerated', () => {
    expect(normalizeUpstreamUrl('http://hub:18787/')).toEqual({
      http: 'http://hub:18787',
      ws: 'ws://hub:18787',
    })
    expect(normalizeUpstreamUrl('https://hub.example')).toEqual({
      http: 'https://hub.example',
      ws: 'wss://hub.example',
    })
    expect(normalizeUpstreamUrl('ws://hub:18787')).toEqual({
      http: 'http://hub:18787',
      ws: 'ws://hub:18787',
    })
    expect(normalizeUpstreamUrl('wss://hub.example/')).toEqual({
      http: 'https://hub.example',
      ws: 'wss://hub.example',
    })
  })
})

describe('readOwnDaemonMachineId', () => {
  const dirs: string[] = []
  afterAll(() => {
    for (const d of dirs) rmSync(d, { recursive: true, force: true })
  })
  const tmp = (): string => {
    const d = mkdtempSync(join(tmpdir(), 'podium-upstream-id-'))
    dirs.push(d)
    return d
  }

  it('reads the daemon identity machineId (the hub-side echo-filter key)', () => {
    const dir = tmp()
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'daemon.json'), JSON.stringify({ machineId: 'm-abc', token: 't' }))
    expect(readOwnDaemonMachineId(dir)).toBe('m-abc')
  })

  it('absent or corrupt identity file → undefined (nothing to filter)', () => {
    expect(readOwnDaemonMachineId(tmp())).toBeUndefined()
    const dir = tmp()
    writeFileSync(join(dir, 'daemon.json'), 'not json')
    expect(readOwnDaemonMachineId(dir)).toBeUndefined()
    const dir2 = tmp()
    writeFileSync(join(dir2, 'daemon.json'), JSON.stringify({ machineId: 42 }))
    expect(readOwnDaemonMachineId(dir2)).toBeUndefined()
  })
})

// Kind-tolerant delta application ([spec:SP-3fe2] #258): a NEWER hub may stream
// entity kinds this node doesn't know. The node must apply the known changes,
// IGNORE the unknown rows (the old else-branch folded them into the ISSUES
// mirror, corrupting it), advance its cursor past them, and never heal-loop.
// Driven through the private frame/heal seams — the WS/tRPC transports are
// covered by the server-side e2e suites.
describe('UpstreamSync kind tolerance', () => {
  function makeSync(opts: { cursor?: number | null; issuesJson?: string } = {}) {
    const mirror = {
      sessions: [] as unknown[][],
      conversations: [] as unknown[][],
      issues: [] as IssueWire[][],
      stale: [] as boolean[],
    }
    const cursors: number[] = []
    let cursor = opts.cursor === undefined ? 5 : opts.cursor
    let issuesJson = opts.issuesJson ?? '[]'
    const sync = new UpstreamSync({
      url: 'http://127.0.0.1:1',
      token: 't',
      mirror: {
        setUpstreamSessions: (l) => mirror.sessions.push(l),
        setUpstreamConversations: (l) => mirror.conversations.push(l),
        setUpstreamIssues: (l) => mirror.issues.push(l),
        setUpstreamStale: (s) => mirror.stale.push(s),
      },
      store: {
        getUpstreamCursor: () => cursor,
        setUpstreamCursor: (c) => {
          cursor = c
          cursors.push(c)
        },
        getUpstreamSessionsJson: () => null,
        setUpstreamSessionsJson: () => {},
        getUpstreamConversationsJson: () => null,
        setUpstreamConversationsJson: () => {},
        getUpstreamIssuesJson: () => issuesJson,
        setUpstreamIssuesJson: (json) => {
          issuesJson = json
        },
      },
    })
    // Replace the real tRPC client with a scripted changesSince (the heal seam).
    // Results queue in FIFO order (setHealResult pushes); an exhausted queue
    // answers an empty delta. Typed unknown so tests can script MALFORMED
    // results — the runtime-validation seam under test (#247).
    const heals: Array<number | null> = []
    const healQueue: unknown[] = []
    const trpc: UpstreamTrpcClient = {
      sync: {
        changesSince: {
          query: ({ cursor: c }) => {
            heals.push(c)
            const next =
              healQueue.length > 0
                ? healQueue.shift()
                : ({
                    kind: 'delta',
                    changes: [],
                    cursor: 0,
                  } satisfies SyncChangesSinceResultLenient)
            return Promise.resolve(next)
          },
        },
      },
    }
    const priv = sync as unknown as {
      trpc: UpstreamTrpcClient
      stopped: boolean
      onFrame(raw: string): void
    }
    priv.trpc = trpc
    priv.stopped = false // heal() no-ops while stopped; we never dial the real WS
    return {
      sync,
      mirror,
      cursors,
      heals,
      setHealResult: (r: unknown) => {
        healQueue.push(r)
      },
      frame: (msg: unknown) => priv.onFrame(JSON.stringify(msg)),
      lastCursor: () => cursor,
    }
  }

  const flush = () => new Promise((r) => setTimeout(r, 0))

  it('a live delta with an unknown entity kind applies the known changes, ignores the unknown, advances the cursor, and never heals', async () => {
    const debug = vi.spyOn(console, 'debug').mockImplementation(() => {})
    // Rehydrated replica: issues a + b (JSON.parse cast — no zod on rehydrate).
    const { mirror, cursors, heals, frame, lastCursor } = makeSync({
      issuesJson: JSON.stringify([{ id: 'a' }, { id: 'b' }]),
    })
    frame({
      type: 'metadataDelta',
      seq: 8,
      changes: [
        { seq: 6, entity: 'issue', id: 'a', op: 'remove' },
        { seq: 7, entity: 'machine', id: 'm1', op: 'upsert', value: { id: 'm1', os: 'linux' } },
        { seq: 8, entity: 'issue', id: 'b', op: 'remove' },
      ],
    })
    await flush()
    // Both KNOWN removes applied; the unknown row was NOT folded into the
    // issues mirror (the old else-branch bug).
    expect(mirror.issues.at(-1)).toEqual([])
    // Cursor advanced PAST the unknown row — the next contiguous delta applies.
    expect(cursors).toEqual([8])
    expect(lastCursor()).toBe(8)
    expect(heals).toEqual([]) // no heal loop
    expect(debug).toHaveBeenCalledWith(expect.stringContaining("unknown entity kind 'machine'"))
    debug.mockRestore()
  })

  // Must satisfy the real IssueWire zod schema — the snapshot arm of the heal
  // result parses STRICTLY now (#247); a sloppy fixture would fail the parse
  // and silently test the wrong path.
  const validIssue = (id: string, title: string): IssueWire => ({
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

  it('a malformed KNOWN-kind element in a heal delta escalates to a snapshot heal — never installed, never skipped (#247)', async () => {
    const { mirror, heals, frame, setHealResult, lastCursor, sync } = makeSync({
      issuesJson: JSON.stringify([{ id: 'a' }, { id: 'b' }]),
    })
    // First heal (cursor 5): a delta whose KNOWN-kind element carries a
    // malformed value. isKnownMetadataChange alone would wave it into the
    // mirror; the runtime parser rejects the whole result instead.
    setHealResult({
      kind: 'delta',
      changes: [
        { seq: 6, entity: 'issue', id: 'a', op: 'remove' },
        { seq: 7, entity: 'issue', id: 'bogus', op: 'upsert', value: { bogus: true } },
      ],
      cursor: 7,
    })
    // Escalation (cursor null): the full snapshot, which installs wholesale.
    setHealResult({
      kind: 'snapshot',
      sessions: [],
      issues: [validIssue('healed', 'from snapshot')],
      conversations: [],
      diagnostics: [],
      cursor: 9,
    })
    // A quarantined frame element forces the heal (same trigger as the sibling test).
    frame({
      type: 'metadataDelta',
      seq: 7,
      changes: [{ seq: 6, entity: 'session', id: 's1', op: 'upsert', value: { bogus: true } }],
    })
    await flush()
    // Escalated: the malformed delta was refetched as a null-cursor snapshot.
    expect(heals).toEqual([5, null])
    // The mirror was replaced by the snapshot — the {bogus:true} row never
    // installed, and the pre-heal replica rows are gone with the full replace.
    expect(mirror.issues.at(-1)?.map((i) => i.id)).toEqual(['healed'])
    // The cursor landed on the SNAPSHOT's cursor — never advanced past the
    // malformed row on the strength of the rejected delta.
    expect(lastCursor()).toBe(9)
    expect(sync.lastCatchUpKind).toBe('snapshot')
  })

  it('a cold-start (null cursor) heal answered with a DELTA is rejected — bootstrap requires a snapshot (#247 round 3)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { cursors, heals, frame, setHealResult, lastCursor, sync } = makeSync({ cursor: null })
    // Contract violation: the server answers the bootstrap (cursor null) with
    // a delta. Installing it would apply changes relative to state this node
    // does not have — and stamp a cursor as if it did.
    setHealResult({
      kind: 'delta',
      changes: [{ seq: 6, entity: 'issue', id: 'a', op: 'remove' }],
      cursor: 6,
    })
    // A frame before any cursor exists triggers the bootstrap heal.
    frame({
      type: 'metadataDelta',
      seq: 6,
      changes: [{ seq: 6, entity: 'issue', id: 'a', op: 'remove' }],
    })
    await flush()
    expect(heals).toEqual([null]) // asked once, with the null bootstrap cursor
    expect(cursors).toEqual([]) // the rejected delta never advanced the cursor
    expect(lastCursor()).toBe(null)
    expect(sync.lastCatchUpKind).toBe(null) // nothing installed
    sync.stop()
    warn.mockRestore()
  })

  it('a quarantined KNOWN-kind element still heals — and a heal result carrying an unknown kind applies cleanly', async () => {
    const debug = vi.spyOn(console, 'debug').mockImplementation(() => {})
    const { mirror, heals, frame, setHealResult, lastCursor } = makeSync({
      issuesJson: JSON.stringify([{ id: 'a' }, { id: 'b' }]),
    })
    setHealResult({
      kind: 'delta',
      changes: [
        { seq: 6, entity: 'issue', id: 'a', op: 'remove' },
        { seq: 7, entity: 'widget', id: 'w1', op: 'upsert', value: { spin: true } },
      ],
      cursor: 7,
    })
    // A KNOWN kind with an invalid value is quarantined by the lenient parser —
    // an invisible hole in the batch, so the node must heal, not apply around it.
    frame({
      type: 'metadataDelta',
      seq: 7,
      changes: [
        { seq: 6, entity: 'issue', id: 'a', op: 'remove' },
        { seq: 7, entity: 'session', id: 's1', op: 'upsert', value: { bogus: true } },
      ],
    })
    await flush()
    expect(heals).toEqual([5])
    // The heal's known change applied; its unknown row was ignored; the cursor
    // landed on the result cursor (past the unknown row).
    expect(mirror.issues.at(-1)?.map((i) => i.id)).toEqual(['b'])
    expect(lastCursor()).toBe(7)
    expect(debug).toHaveBeenCalledWith(expect.stringContaining("unknown entity kind 'widget'"))
    debug.mockRestore()
  })
})
