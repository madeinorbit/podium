import type { IssueWire, SessionMeta, TranscriptItem } from '@podium/protocol'
import { beforeEach, describe, expect, it } from 'vitest'
import {
  createReplica,
  REPLICA_TRANSCRIPT_CONVERSATION_CAP,
  REPLICA_TRANSCRIPT_ITEM_CAP,
  type ReplicaInit,
} from './replica'

// ---------------------------------------------------------------------------
// Replica adapter (docs/spec/thin-client-replica.md): persisted entity
// collections + cursor + bounded transcript windows over the storage seam.
// Each test namespaces its keys (fresh prefix) so instances don't share blobs.
// ---------------------------------------------------------------------------

/** Recording storage fake: a Map plus an ordered log of every setItem key. */
function makeStorage(): {
  storage: NonNullable<ReplicaInit['storage']>
  data: Map<string, string>
  writes: string[]
} {
  const data = new Map<string, string>()
  const writes: string[] = []
  return {
    data,
    writes,
    storage: {
      getItem: (k) => data.get(k) ?? null,
      setItem: (k, v) => {
        writes.push(k)
        data.set(k, v)
      },
      removeItem: (k) => void data.delete(k),
    },
  }
}

let prefixSeq = 0
let prefix = ''
beforeEach(() => {
  prefix = `test.replica.${++prefixSeq}`
})

function session(id: string, title = id): SessionMeta {
  return {
    sessionId: id,
    agentKind: 'claude-code',
    title,
    cwd: '/w',
    status: 'live',
    controllerId: 'c0',
    geometry: { cols: 80, rows: 24 },
    epoch: 0,
    clientCount: 1,
    createdAt: '2026-07-01T00:00:00.000Z',
    lastActiveAt: '2026-07-01T00:00:00.000Z',
    origin: { kind: 'spawn' },
    archived: false,
  }
}

function issue(id: string, title = id): IssueWire {
  return {
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
  }
}

function item(id: string, text = id): TranscriptItem {
  return { id, cursor: id, role: 'assistant', text }
}

const settle = () => new Promise((r) => setTimeout(r, 0))

describe('replica adapter', () => {
  it('round-trips snapshots, changes, and the cursor across instances', async () => {
    const { storage } = makeStorage()
    const a = createReplica({ storage, keyPrefix: prefix })
    expect(a.available).toBe(true)
    a.applySnapshot('sessions', [session('s1'), session('s2')])
    a.applySnapshot('issues', [issue('i1')])
    a.setCursor(7)
    await settle()

    // Fresh instance over the same storage — the reload path.
    const b = createReplica({ storage, keyPrefix: prefix })
    const hydrated = await b.hydrate()
    expect(hydrated.sessions.map((s) => s.sessionId).sort()).toEqual(['s1', 's2'])
    expect(hydrated.issues.map((i) => i.id)).toEqual(['i1'])
    expect(hydrated.cursor).toBe(7)

    // Delta semantics: upsert replaces by id, remove drops, others untouched.
    b.applyChanges('sessions', [session('s2', 'renamed'), session('s3')], ['s1'])
    await settle()
    const c = createReplica({ storage, keyPrefix: prefix })
    const again = await c.hydrate()
    expect(again.sessions.map((s) => `${s.sessionId}:${s.title}`).sort()).toEqual([
      's2:renamed',
      's3:s3',
    ])
  })

  it('applySnapshot removes rows missing from the new list', async () => {
    const { storage } = makeStorage()
    const a = createReplica({ storage, keyPrefix: prefix })
    a.applySnapshot('issues', [issue('i1'), issue('i2')])
    a.applySnapshot('issues', [issue('i2', 'kept')])
    await settle()
    const b = createReplica({ storage, keyPrefix: prefix })
    const h = await b.hydrate()
    expect(h.issues.map((i) => `${i.id}:${i.title}`)).toEqual(['i2:kept'])
  })

  it('a corrupt storage blob cold-starts instead of throwing', async () => {
    const { storage, data } = makeStorage()
    data.set(`${prefix}.sessions.v1`, '{not json!!')
    data.set(`${prefix}.cursor.v1`, 'NaN-garbage')
    const r = createReplica({ storage, keyPrefix: prefix })
    const h = await r.hydrate()
    expect(h.sessions).toEqual([])
    expect(h.cursor).toBeNull()
    // And the replica still works after the cold start.
    r.applySnapshot('sessions', [session('s1')])
    await settle()
    const again = await createReplica({ storage, keyPrefix: prefix }).hydrate()
    expect(again.sessions.map((s) => s.sessionId)).toEqual(['s1'])
  })

  it('persists the cursor AFTER the data it covers (invariant 3)', async () => {
    const { storage, writes } = makeStorage()
    const r = createReplica({ storage, keyPrefix: prefix })
    writes.length = 0 // ignore probe traffic
    r.applySnapshot('sessions', [session('s1')])
    r.setCursor(42)
    await settle()
    const sessionsWrite = writes.indexOf(`${prefix}.sessions.v1`)
    const cursorWrite = writes.indexOf(`${prefix}.cursor.v1`)
    expect(sessionsWrite).toBeGreaterThanOrEqual(0)
    expect(cursorWrite).toBeGreaterThan(sessionsWrite)
  })

  it('bounds transcript windows: item cap per conversation + conversation LRU', async () => {
    const { storage } = makeStorage()
    let clock = 0
    const r = createReplica({ storage, keyPrefix: prefix, now: () => ++clock })
    // Item cap: only the NEWEST cap items survive.
    const many = Array.from({ length: REPLICA_TRANSCRIPT_ITEM_CAP + 50 }, (_, i) =>
      item(`t${i.toString().padStart(4, '0')}`),
    )
    r.putTranscriptWindow('conv-big', many)
    const win = r.transcriptWindow('conv-big')
    expect(win?.items).toHaveLength(REPLICA_TRANSCRIPT_ITEM_CAP)
    expect(win?.items[0]?.id).toBe(many[50]?.id) // oldest 50 trimmed
    expect(win?.items.at(-1)?.id).toBe(many.at(-1)?.id)

    // LRU: fill past the conversation cap; the least-recently-written fall out.
    for (let i = 0; i < REPLICA_TRANSCRIPT_CONVERSATION_CAP + 5; i++) {
      r.putTranscriptWindow(`conv-${i}`, [item(`x${i}`)])
    }
    await settle()
    // 'conv-big' was written first → evicted; the newest cap survive.
    expect(r.transcriptWindow('conv-big')).toBeUndefined()
    expect(r.transcriptWindow('conv-0')).toBeUndefined() // also aged out (5 over cap incl. conv-big)
    expect(r.transcriptWindow(`conv-${REPLICA_TRANSCRIPT_CONVERSATION_CAP + 4}`)).toBeDefined()
    // Re-writing an existing key refreshes its slot (update path) and survives.
    r.putTranscriptWindow('conv-5', [item('fresh')])
    expect(r.transcriptWindow('conv-5')?.items[0]?.id).toBe('fresh')

    // Windows persist across instances.
    const b = createReplica({ storage, keyPrefix: prefix })
    await b.hydrate()
    expect(b.transcriptWindow('conv-5')?.items[0]?.id).toBe('fresh')
  })

  it('unavailable storage degrades to a fully inert adapter (invariant 4)', async () => {
    const throwing: NonNullable<ReplicaInit['storage']> = {
      getItem: () => {
        throw new Error('denied')
      },
      setItem: () => {
        throw new Error('denied')
      },
      removeItem: () => {
        throw new Error('denied')
      },
    }
    const r = createReplica({ storage: throwing, keyPrefix: prefix })
    expect(r.available).toBe(false)
    // Every operation is a no-op that never throws.
    const h = await r.hydrate()
    expect(h).toEqual({ sessions: [], issues: [], conversations: [], cursor: null })
    r.applySnapshot('sessions', [session('s1')])
    r.applyChanges('issues', [issue('i1')], [])
    r.setCursor(1)
    r.putTranscriptWindow('c', [item('a')])
    expect(r.getCursor()).toBeNull()
    expect(r.transcriptWindow('c')).toBeUndefined()
  })

  it('re-applying an identical snapshot issues no storage writes', async () => {
    const { storage, writes } = makeStorage()
    const r = createReplica({ storage, keyPrefix: prefix })
    r.applySnapshot('sessions', [session('s1'), session('s2')])
    await settle()
    writes.length = 0
    r.applySnapshot('sessions', [session('s1'), session('s2')])
    await settle()
    expect(writes).toEqual([])
  })
})
