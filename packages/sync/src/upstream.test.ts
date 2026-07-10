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
    const heals: Array<number | null> = []
    let healResult: SyncChangesSinceResultLenient = { kind: 'delta', changes: [], cursor: 0 }
    const trpc: UpstreamTrpcClient = {
      sync: {
        changesSince: {
          query: ({ cursor: c }) => {
            heals.push(c)
            return Promise.resolve(healResult)
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
      setHealResult: (r: SyncChangesSinceResultLenient) => {
        healResult = r
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
