import type { IssueWire, SessionMeta, TranscriptItem } from '@podium/protocol'
import { beforeEach, describe, expect, it } from 'vitest'
import { OUTBOX_LS_KEY, Outbox, type OutboxEntry } from './outbox'
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

/** Storage fake whose ENTITY-BLOB writes throw QuotaExceededError while
 *  `failing` — the #181 production failure (small keys like the cursor still
 *  succeed, exactly the asymmetry that opened the cursor/data gap). */
function makeQuotaStorage(): {
  storage: NonNullable<ReplicaInit['storage']>
  data: Map<string, string>
  failedAttempts: () => number
  setFailing: (f: boolean) => void
} {
  const data = new Map<string, string>()
  let failing = false
  let failed = 0
  const isEntityBlob = (k: string) => /\.(sessions|issues|conversations|transcripts)\.v1$/.test(k)
  return {
    data,
    failedAttempts: () => failed,
    setFailing: (f) => {
      failing = f
    },
    storage: {
      getItem: (k) => data.get(k) ?? null,
      setItem: (k, v) => {
        if (failing && isEntityBlob(k)) {
          failed++
          const err = new Error('exceeded the quota')
          err.name = 'QuotaExceededError'
          throw err
        }
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
    readAt: null,
    unread: false,
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
    readAt: null,
    unread: false,
    sessions: [],
    sessionSummary: { total: 0, byPhase: {} },
    origin: 'human' as const,
    audience: 'human' as const,
    draft: false,
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
    expect(a.persistent).toBe(true)
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

  it('applySnapshot drops a field that goes present→absent (unsnooze clear #170)', async () => {
    // The unsnooze bug: an issue's `deferUntil` was set (snoozed), then the server
    // cleared it — the wire OMITS deferUntil. An in-place merge can't remove a key
    // (TanStack's update draft ignores `delete`), so the stale deferUntil would
    // survive and the "Unsnoozed" tag never cleared. A key-dropping row must be
    // fully replaced.
    const { storage } = makeStorage()
    const a = createReplica({ storage, keyPrefix: prefix })
    const snoozed: IssueWire = { ...issue('i1'), deferUntil: '2026-07-07T00:00:00.000Z' }
    a.applySnapshot('issues', [snoozed])
    await settle()
    // Server clears the snooze → the wire no longer carries deferUntil at all.
    a.applySnapshot('issues', [issue('i1')])
    await settle()
    const b = createReplica({ storage, keyPrefix: prefix })
    const h = await b.hydrate()
    const got = h.issues.find((i) => i.id === 'i1')
    expect(got).toBeDefined()
    expect(got?.deferUntil ?? null).toBeNull()
  })

  it('applyChanges (optimistic) also drops a removed field', async () => {
    const { storage } = makeStorage()
    const a = createReplica({ storage, keyPrefix: prefix })
    a.applySnapshot('issues', [{ ...issue('i1'), deferUntil: '2026-07-07T00:00:00.000Z' }])
    await settle()
    a.applyChanges('issues', [issue('i1')], [])
    await settle()
    const h = await createReplica({ storage, keyPrefix: prefix }).hydrate()
    expect(h.issues.find((i) => i.id === 'i1')?.deferUntil ?? null).toBeNull()
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

  it('unusable storage degrades to a WORKING in-memory replica (private mode, invariant 4)', async () => {
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
    expect(r.persistent).toBe(false)
    // Same seam, in-memory backing: every operation still works for the tab's
    // lifetime — no parallel "inert" path.
    const cold = await r.hydrate()
    expect(cold).toEqual({
      sessions: [],
      issues: [],
      conversations: [],
      automations: [],
      automationRuns: [],
      cursor: null,
    })
    r.applySnapshot('sessions', [session('s1')])
    r.applyChanges('issues', [issue('i1')], [])
    r.setCursor(1)
    r.putTranscriptWindow('c', [item('a')])
    await settle()
    expect(r.getCursor()).toBe(1)
    expect(r.transcriptWindow('c')?.items[0]?.id).toBe('a')
    const h = await r.hydrate()
    expect(h.sessions.map((x) => x.sessionId)).toEqual(['s1'])
    expect(h.issues.map((x) => x.id)).toEqual(['i1'])
    // …but nothing reaches the broken storage: a NEW instance over it is cold.
    const again = createReplica({ storage: throwing, keyPrefix: prefix })
    expect(await again.hydrate()).toEqual({
      sessions: [],
      issues: [],
      conversations: [],
      automations: [],
      automationRuns: [],
      cursor: null,
    })
  })

  it('a quota-exceeded entity write degrades to memory: ingest completes, no cursor advance (#181)', async () => {
    // Production-sized data blows the ~5MB localStorage quota; the collection
    // layer swallows the QuotaExceededError while the tiny cursor write still
    // succeeds → reload hydrates stale collections at an advanced cursor: a
    // permanent gap. The guard must (a) keep ingest working in memory, (b) never
    // let the cursor persist past unpersisted data, (c) stop hitting storage.
    const { storage, data, failedAttempts, setFailing } = makeQuotaStorage()
    const r = createReplica({ storage, keyPrefix: prefix })
    r.applySnapshot('issues', [issue('i1')]) // persists fine pre-quota
    await settle()
    expect(data.has(`${prefix}.issues.v1`)).toBe(true)

    setFailing(true)
    // Must not throw into the ingest path…
    r.applySnapshot('sessions', [session('s1'), session('s2')])
    r.setCursor(42)
    await settle()

    // …and the rows are still queryable (live data flows from the in-memory state).
    const rows = (r.collection('sessions') as { toArray: SessionMeta[] }).toArray
    expect(rows.map((s) => s.sessionId).sort()).toEqual(['s1', 's2'])
    // Cursor honesty: the data write did NOT persist, so the cursor may not either.
    expect(data.has(`${prefix}.cursor.v1`)).toBe(false)
    expect(r.getCursor()).toBeNull()
    // Freed quota: the (now possibly inconsistent) persisted entity blobs are gone.
    expect(data.has(`${prefix}.issues.v1`)).toBe(false)
    expect(data.has(`${prefix}.sessions.v1`)).toBe(false)

    // Permanently degraded: further entity writes never touch durable storage again.
    const attemptsAfterDegrade = failedAttempts()
    r.applySnapshot('sessions', [session('s1'), session('s2'), session('s3')])
    await settle()
    expect(failedAttempts()).toBe(attemptsAfterDegrade)
    const again = (r.collection('sessions') as { toArray: SessionMeta[] }).toArray
    expect(again.map((s) => s.sessionId).sort()).toEqual(['s1', 's2', 's3'])
  })

  it('reload after a quota degrade does a FULL resync — no cursor gap (#181)', async () => {
    const { storage, setFailing } = makeQuotaStorage()
    // Healthy phase: rows + cursor persisted.
    const a = createReplica({ storage, keyPrefix: prefix })
    a.applySnapshot('sessions', [session('s1')])
    a.setCursor(7)
    await settle()

    // Second session hits the quota mid-ingest.
    setFailing(true)
    const b = createReplica({ storage, keyPrefix: prefix })
    const hb = await b.hydrate()
    expect(hb.cursor).toBe(7) // pre-degrade the persisted cursor was honest
    b.applySnapshot('sessions', [session('s1'), session('s2')])
    b.setCursor(9)
    await settle()
    expect(b.getCursor()).toBeNull() // degraded: the cursor is void immediately

    // Reload (quota freed by the degrade cleanup): a cold client, not a gap —
    // null cursor makes the hub's first changesSince a full snapshot.
    setFailing(false)
    const c = createReplica({ storage, keyPrefix: prefix })
    const hc = await c.hydrate()
    expect(hc.cursor).toBeNull()
    expect(hc.sessions).toEqual([])
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

// ---------------------------------------------------------------------------
// P6b Part 2: the outbox's storage seam backed by a replica collection
// (`<prefix>.outbox.v1`) — one persistence layer, FIFO order via a stable per-
// entry seq, one-time migration of the legacy podium.outbox.v1 blob, and cross-
// tab consistency through the lib's `storage` events.
// ---------------------------------------------------------------------------

function entry(mutationId: string, queuedAt = 1): OutboxEntry {
  return { mutationId, kind: 'rename', input: { sessionId: 's1', name: mutationId }, queuedAt }
}

describe('replica outbox storage', () => {
  it('round-trips entries in FIFO order across save/load and across instances', async () => {
    const { storage } = makeStorage()
    const a = createReplica({ storage, keyPrefix: prefix }).outboxStorage()
    a.save([entry('m1'), entry('m2'), entry('m3')])
    // Same instance reads back synchronously (optimistic state).
    expect(a.load().map((e) => e.mutationId)).toEqual(['m1', 'm2', 'm3'])
    // FIFO shift-from-front + push-at-back keeps order without rewriting rows.
    a.save([entry('m2'), entry('m3'), entry('m4')])
    expect(a.load().map((e) => e.mutationId)).toEqual(['m2', 'm3', 'm4'])
    await settle()
    // Reload path: a fresh replica over the same storage sees the same queue.
    const b = createReplica({ storage, keyPrefix: prefix }).outboxStorage()
    expect(b.load().map((e) => e.mutationId)).toEqual(['m2', 'm3', 'm4'])
    expect(b.load()[0]).toEqual(entry('m2'))
  })

  it('migrates the legacy podium.outbox.v1 blob into the collection once', () => {
    const { storage, data } = makeStorage()
    storage.setItem(OUTBOX_LS_KEY, JSON.stringify([entry('legacy1'), entry('legacy2')]))
    const s = createReplica({ storage, keyPrefix: prefix }).outboxStorage()
    expect(s.load().map((e) => e.mutationId)).toEqual(['legacy1', 'legacy2'])
    // The legacy key is retired so an old blob can't be re-imported later.
    expect(data.has(OUTBOX_LS_KEY)).toBe(false)
  })

  it('follows another tab through the storage event', async () => {
    const { storage } = makeStorage()
    const listeners: Array<(e: unknown) => void> = []
    const storageEventApi = {
      addEventListener: (_type: string, cb: (e: never) => void) =>
        listeners.push(cb as (e: unknown) => void),
      removeEventListener: () => {},
    }
    const tabA = createReplica({ storage, storageEventApi, keyPrefix: prefix }).outboxStorage()
    expect(tabA.load()).toEqual([])
    // "Tab B": a second adapter over the same storage persists an entry…
    const tabB = createReplica({ storage, keyPrefix: prefix }).outboxStorage()
    tabB.save([entry('cross')])
    await settle()
    // …and the browser's storage event tells tab A, whose collection re-syncs.
    for (const cb of listeners) {
      cb({ key: `${prefix}.outbox.v1`, storageArea: storage })
    }
    expect(tabA.load().map((e) => e.mutationId)).toEqual(['cross'])
  })

  it('private mode: the outbox stores AND drains in memory behind the same seam', async () => {
    const r = createReplica({
      storage: {
        getItem: () => null,
        setItem: () => {
          throw new Error('quota')
        },
        removeItem: () => {},
      },
      keyPrefix: prefix,
    })
    expect(r.persistent).toBe(false)
    const storage = r.outboxStorage()
    // Queue while "offline": entries live in the in-memory collection.
    storage.save([entry('m1'), entry('m2')])
    expect(storage.load().map((e) => e.mutationId)).toEqual(['m1', 'm2'])

    // Drive a real Outbox over this storage: connectivity returns and the
    // queue drains FIFO through the executor, emptying the in-memory backing.
    const executed: string[] = []
    const outbox = new Outbox<{ rename: { sessionId: string; name: string } }>({
      storage,
      executors: {
        rename: async (input) => {
          executed.push(input.mutationId)
        },
      },
      isOnline: () => true,
    })
    await outbox.drain()
    expect(executed).toEqual(['m1', 'm2'])
    expect(storage.load()).toEqual([])
    outbox.dispose()
  })
})
