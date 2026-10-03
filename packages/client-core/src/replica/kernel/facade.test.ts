import { asIssueId, asMutationId, asUserId, issueUserStateRowId } from '@podium/model'
import type { Cursor, EntityRecord, ReplicaEvent } from '@podium/sync/replica'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { sessionViews } from '../../session-values'
import { FEED_TASK_BUDGET_MS } from '../../socket-transport'
import { memoryStorage } from '../replica'
import { createKernelReplica, type KernelCacheRead } from './facade'
import { entityForKind, kindForEntity, rowKey } from './kinds'
import { createSideCache, OutboxNotDurableError } from './side-cache'

/** A cache the test drives directly. The kernel Replica writes through the real
 *  one; this facade only ever READS, so a read-only double is the whole port. */
class FakeCache implements KernelCacheRead {
  records: EntityRecord[] = []
  cursor: { seq: number; feedId?: string; epoch?: string } | null = null
  completeAt: Cursor | null = null
  mode: 'durable' | 'degraded-memory' | 'unavailable' = 'durable'
  throwOnRead = false
  /** How many times the facade materialised the WHOLE store. The scaling guard
   *  below asserts on this: a delta must not cost a full scan. */
  readEntitiesCalls = 0

  readCursor() {
    return this.cursor
  }
  readPersonalRowsCompleteAt() {
    return this.completeAt
  }
  readEntities(): readonly EntityRecord[] {
    this.readEntitiesCalls += 1
    if (this.throwOnRead) throw new Error('store unreadable')
    return this.records
  }
  read(entity: string, entityId: string): EntityRecord | undefined {
    if (this.throwOnRead) throw new Error('store unreadable')
    return this.records.find((r) => r.entity === entity && r.entityId === entityId)
  }
  durability() {
    return this.mode
  }

  put(entity: string, entityId: string, value: unknown, seq = 1): void {
    this.records = [
      ...this.records.filter((r) => !(r.entity === entity && r.entityId === entityId)),
      { entity, entityId, value, provenance: { seq } },
    ]
  }
  drop(entity: string, entityId: string): void {
    this.records = this.records.filter((r) => !(r.entity === entity && r.entityId === entityId))
  }
}

function build(cache = new FakeCache()) {
  const side = createSideCache({ storage: memoryStorage(), enumerateKeys: () => [] })
  return { cache, replica: createKernelReplica({ cache, side }), side }
}

const session = (sessionId: string) => ({ sessionId, name: sessionId }) as never
const issue = (id: string) => ({ id, title: id }) as never

describe('replica-wide issue reference index', () => {
  it('seeds every stored issue and resolves keyed identities without reads or scans', async () => {
    const { cache, replica } = build()
    cache.put('repo', 'r', { id: 'r', prefix: 'POD' })
    for (const [seq, patch] of [
      [1, { stage: 'review' }],
      [2, { archived: true }],
      [3, { stage: 'done', closedAt: '2026-01-01' }],
      [4, { deletedAt: '2026-01-01' }],
    ] as const)
      cache.put('issueProjection', `i${seq}`, { id: `i${seq}`, seq, repoId: 'r', ...patch })
    await replica.hydrate()
    expect(cache.readEntitiesCalls).toBe(1)
    const read = vi.spyOn(cache, 'read')
    for (let seq = 1; seq <= 4; seq++) {
      expect(replica.issueIdByRef(` POD-00${seq} `)).toBe(`i${seq}`)
    }
    expect(replica.issueIdByRef('POD-999')).toBeUndefined()
    expect(replica.issueIdByRef('POD-1-A')).toBeUndefined()
    expect(replica.issueIdByRef('malformed')).toBeUndefined()
    expect(cache.readEntitiesCalls).toBe(1)
    expect(read).not.toHaveBeenCalled()
  })

  it('maintains issue moves, sequence changes, prefix changes, removals and readmission before notifying', () => {
    const { cache, replica } = build()
    const admit = (entity: string, entityId: string, value: unknown) => {
      cache.put(entity, entityId, value)
      replica.onKernelEvent({
        type: 'upserted',
        record: cache.read(entity, entityId)!,
        readmitted: false,
      })
    }
    admit('issueProjection', 'i', { id: 'i', seq: 7, repoId: 'r', archived: true })
    expect(replica.issueIdByRef('#007')).toBe('i')
    admit('repo', 'r', { id: 'r', prefix: 'POD' })
    expect(replica.issueIdByRef('#7')).toBeUndefined()
    expect(replica.issueIdByRef('POD-7')).toBe('i')
    const seen = vi.fn(() => replica.issueIdByRef('NEW-7'))
    replica.subscribeRows('repos', seen)
    admit('repo', 'r', { id: 'r', prefix: 'NEW' })
    expect(seen.mock.results.at(-1)?.value).toBe('i')
    expect(replica.issueIdByRef('POD-7')).toBeUndefined()
    admit('repo', 'other', { id: 'other', prefix: 'OTH' })
    admit('issueProjection', 'i', { id: 'i', seq: 8, repoId: 'other', displayRef: 'STALE-7' })
    expect(replica.issueIdByRef('NEW-7')).toBeUndefined()
    expect(replica.issueIdByRef('STALE-7')).toBeUndefined()
    expect(replica.issueIdByRef('OTH-8')).toBe('i')
    cache.drop('repo', 'other')
    replica.onKernelEvent({ type: 'evicted', entity: 'repo', entityId: 'other' })
    expect(replica.issueIdByRef('OTH-8')).toBeUndefined()
    expect(replica.issueIdByRef('#8')).toBe('i')
    for (const type of ['removed', 'evicted'] as const) {
      cache.drop('issueProjection', 'i')
      replica.onKernelEvent({ type, entity: 'issueProjection', entityId: 'i' })
      expect(replica.issueIdByRef('#8')).toBeUndefined()
      admit('issueProjection', 'i', { id: 'i', seq: 8, repoId: 'other', deletedAt: '2026-01-01' })
      expect(replica.issueIdByRef('#8')).toBe('i')
    }
    expect(cache.readEntitiesCalls).toBe(1)
  })

  it('retains colliding fallback identities until late repo rows disambiguate them', () => {
    const { cache, replica } = build()
    cache.put('issueProjection', 'a', { id: 'a', seq: 1, repoId: 'ra' })
    cache.put('issueProjection', 'b', { id: 'b', seq: 1, repoId: 'rb' })
    expect(replica.issueIdByRef('#1')).toBeUndefined()
    cache.put('repo', 'ra', { id: 'ra', prefix: 'POD' })
    replica.onKernelEvent({
      type: 'upserted',
      record: cache.read('repo', 'ra')!,
      readmitted: false,
    })
    expect(replica.issueIdByRef('POD-1')).toBe('a')
    expect(replica.issueIdByRef('#1')).toBe('b')
    cache.put('repo', 'rb', { id: 'rb', prefix: 'OTH' })
    replica.onKernelEvent({
      type: 'upserted',
      record: cache.read('repo', 'rb')!,
      readmitted: false,
    })
    expect(replica.issueIdByRef('OTH-1')).toBe('b')
    expect(replica.issueIdByRef('#1')).toBeUndefined()
    expect(cache.readEntitiesCalls).toBe(1)
  })

  it('replaces the full index on rescope and keeps separate replicas isolated', () => {
    const { cache, replica } = build()
    cache.put('repo', 'r', { id: 'r', prefix: 'POD' })
    cache.put('issueProjection', 'old', { id: 'old', seq: 1, repoId: 'r' })
    expect(replica.issueIdByRef('POD-1')).toBe('old')
    cache.records = []
    cache.put('repo', 'r', { id: 'r', prefix: 'NEW' })
    cache.put('issueProjection', 'new', { id: 'new', seq: 2, repoId: 'r' })
    replica.onKernelEvent({
      type: 'bootstrap-installed',
      cause: 'rescope',
      snapshotSeq: 2,
      entityCount: 2,
      bufferedFramesApplied: 0,
    })
    expect(replica.issueIdByRef('POD-1')).toBeUndefined()
    expect(replica.issueIdByRef('NEW-2')).toBe('new')
    expect(build().replica.issueIdByRef('NEW-2')).toBeUndefined()
    expect(cache.readEntitiesCalls).toBe(2)
  })
})

describe('kind mapping', () => {
  it('S6 hydrates old sessions but ignores stale extras through evict, delete, readmission and rescope', async () => {
    const { cache, replica } = build()
    const old = {
      sessionId: 's1',
      lastActiveAt: '2026-10-01T12:00:00Z',
      machineId: 'm1',
      agentKind: 'codex',
      refRepoId: 'r1',
      refSeq: 1,
      refLetter: 'A',
      handoffTargetMachineId: 'm2',
      readAt: 'stale',
      unread: false,
      snoozedUntil: null,
      displayRef: 'STALE-1-A',
      machineName: 'Stale',
      condition: 'logged-out',
      handoffTarget: 'Stale target',
      queuedMessageCount: 2,
      offer: { message: 'Keep the offer', actions: [], createdAt: 't' },
    }
    cache.put('session', 's1', old)
    await replica.hydrate()
    const read = (userId = 'alice') =>
      sessionViews(replica.rows('sessions'), {
        userId,
        userStatesLoaded: replica.sessionUserStatesLoaded?.(),
        userStates: replica.rows('sessionUserStates'),
        repos: replica.rows('repos'),
        machines: replica.rows('machines'),
      })[0]!
    const empty = {
      readAt: null,
      unread: true,
      snoozedUntil: undefined,
      displayRef: undefined,
      machineName: '',
      condition: undefined,
      handoffTarget: undefined,
    }
    expect(read()).toMatchObject({
      ...empty,
      unread: false,
      queuedMessageCount: 2,
      offer: old.offer,
    })
    // Before a slow bootstrap, stale cached read flags cannot flash unread.
    expect(replica.sessionUserStatesLoaded?.()).toBe(false)
    expect(replica.rows('sessions')[0]).toBe(old)
    const personal = { userId: 'alice', sessionId: 's1', readAt: '2026-10-01T13:00:00Z' }
    const key = rowKey('sessionUserStates', personal as never)
    const admit = (entity: string, id: string, value: unknown) => {
      cache.put(entity, id, value)
      replica.onKernelEvent({ type: 'upserted', record: cache.read(entity, id)!, readmitted: true })
    }
    const addHomes = () => {
      admit('sessionUserState', key, personal)
      admit('repo', 'r1', { id: 'r1', prefix: 'NEW' })
      admit('machine', 'm1', { id: 'm1', name: 'Source', loggedOutHarnesses: [] })
      admit('machine', 'm2', { id: 'm2', name: 'Target', loggedOutHarnesses: [] })
    }
    replica.onKernelEvent({
      type: 'bootstrap-installed',
      cause: 'cold-start',
      snapshotSeq: 1,
      entityCount: 1,
      bufferedFramesApplied: 0,
    })
    expect(read()).toMatchObject(empty)
    for (const event of ['evicted', 'removed'] as const) {
      addHomes()
      expect(read()).toMatchObject({
        readAt: personal.readAt,
        unread: false,
        displayRef: 'NEW-1-A',
        machineName: 'Source',
        handoffTarget: 'Target',
      })
      for (const [entity, entityId] of [
        ['sessionUserState', key],
        ['repo', 'r1'],
        ['machine', 'm1'],
        ['machine', 'm2'],
      ] as const) {
        cache.drop(entity, entityId)
        replica.onKernelEvent({ type: event, entity, entityId })
      }
      expect(read()).toMatchObject(empty)
    }
    addHomes()
    expect(read('bob')).toMatchObject({ readAt: null, unread: true, snoozedUntil: undefined })
    cache.records = cache.records.filter((row) => row.entity === 'session')
    replica.onKernelEvent({
      type: 'bootstrap-installed',
      cause: 'rescope',
      snapshotSeq: 5,
      entityCount: 1,
      bufferedFramesApplied: 0,
    })
    expect(read('bob')).toMatchObject(empty)
    expect(replica.rows('sessions')[0]).toBe(old)
  })

  it('settles sparse session markers once on resumed catch-up, preserving raw identity and principal isolation', () => {
    const { cache, replica } = build()
    const raw = { sessionId: 's1', lastActiveAt: '2026-10-01T12:00:00Z', unread: false }
    cache.put('session', 's1', raw)
    cache.cursor = { seq: 10 }
    const read = () =>
      sessionViews(replica.rows('sessions'), {
        userId: 'alice',
        userStatesLoaded: replica.sessionUserStatesLoaded?.(),
        userStates: replica.rows('sessionUserStates'),
        repos: [],
        machines: [],
      })[0]!
    const batches = vi.fn()
    replica.subscribeAddressedBatch!(batches)
    expect(read().unread).toBe(false)
    replica.onKernelEvent({ type: 'posture', posture: 'live', previous: 'stale' })
    expect(read().unread).toBe(true)
    expect(replica.rows('sessions')[0]).toBe(raw)
    expect(batches).toHaveBeenCalledWith({ type: 'update', rows: [{ kind: 'sessions', id: 's1' }] })
    replica.onKernelEvent({ type: 'posture', posture: 'stale', previous: 'live' })
    replica.onKernelEvent({ type: 'posture', posture: 'live', previous: 'stale' })
    expect(batches).toHaveBeenCalledTimes(1)
    expect(build().replica.sessionUserStatesLoaded?.()).toBe(false)
  })

  it('a certified warm attach has live parity and sends no second sparse-session delivery', () => {
    const records: EntityRecord[] = [
      ...['unread', 'read', 'foreign', 'quiet'].map((sessionId) => ({
        entity: 'session',
        entityId: sessionId,
        value: {
          sessionId,
          lastActiveAt: sessionId === 'quiet' ? undefined : '2026-10-01T12:00:00Z',
        },
        provenance: { seq: 1 },
      })),
      {
        entity: 'sessionUserState',
        entityId: 'alice-read',
        value: { userId: 'alice', sessionId: 'read', readAt: '2026-10-02T12:00:00Z' },
        provenance: { seq: 1 },
      },
      {
        entity: 'sessionUserState',
        entityId: 'bob-foreign',
        value: { userId: 'bob', sessionId: 'foreign', readAt: '2026-10-02T12:00:00Z' },
        provenance: { seq: 1 },
      },
    ]
    const views = (replica: ReturnType<typeof build>['replica']) =>
      sessionViews(replica.rows('sessions'), {
        userId: 'alice',
        userStatesLoaded: replica.sessionUserStatesLoaded?.(),
        userStates: replica.rows('sessionUserStates'),
        repos: [],
        machines: [],
      })
    const cursor: Cursor = { feedId: 'feed', epoch: 'epoch', seq: 10 }
    const legacy = new FakeCache()
    legacy.cursor = cursor
    legacy.records = records
    const old = build(legacy).replica
    expect(views(old).find((row) => row.sessionId === 'unread')?.unread).toBe(false)
    old.onKernelEvent({ type: 'posture', posture: 'live', previous: 'healing' })
    const expected = views(old)
    expect(expected.find((row) => row.sessionId === 'unread')?.unread).toBe(true)
    expect(expected.find((row) => row.sessionId === 'read')?.unread).toBe(false)
    expect(expected.find((row) => row.sessionId === 'foreign')?.unread).toBe(true)

    const certified = new FakeCache()
    certified.records = records
    certified.cursor = cursor
    certified.completeAt = cursor
    const warm = build(certified).replica
    const delivery = vi.fn()
    warm.subscribeAddressedBatch!(delivery)
    const attached = views(warm)
    expect(warm.sessionUserStatesLoaded?.()).toBe(true)
    expect(attached).toEqual(expected)
    warm.onKernelEvent({ type: 'posture', posture: 'live', previous: 'healing' })
    expect(views(warm)).toEqual(attached)
    for (const row of attached)
      expect(views(warm).find((after) => after.sessionId === row.sessionId)).toBe(row)
    expect(delivery).not.toHaveBeenCalled()

    // Planted fault: a certified slice missing Alice's read row cannot pass parity.
    const faulty = new FakeCache()
    faulty.records = records.filter((row) => row.entityId !== 'alice-read')
    faulty.cursor = cursor
    faulty.completeAt = cursor
    const incomplete = build(faulty).replica
    expect(() => expect(views(incomplete)).toEqual(expected)).toThrow()
    expect(views(incomplete).find((row) => row.sessionId === 'read')?.unread).toBe(true)
  })

  it.each([
    { feedId: 'other', epoch: 'epoch', seq: 10 },
    { feedId: 'feed', epoch: 'other', seq: 10 },
    { feedId: 'feed', epoch: 'epoch', seq: 11 },
  ])('an unmatched completeness triple remains unknown: %j', (marker) => {
    const cache = new FakeCache()
    cache.cursor = { feedId: 'feed', epoch: 'epoch', seq: 10 }
    cache.completeAt = marker
    expect(build(cache).replica.sessionUserStatesLoaded?.()).toBe(false)
  })

  it('maps and hydrates personal issue markers by their composite key and git observations by issue', async () => {
    const { cache, replica } = build()
    const userId = asUserId('user:alice')
    const entityId = asIssueId('issue:a')
    const key = issueUserStateRowId(userId, entityId)
    const markers = { userId, entityId, readAt: 'read', tuckedAt: null, pinned: true }
    const git = {
      id: entityId,
      updatedAt: 'probe',
      branch: 'feature',
      shared: false,
      ahead: 2,
      dirtyFiles: 0,
      merged: true,
    }
    cache.put('issueUserState', key, markers)
    cache.put('issueGitState', entityId, git)
    expect(kindForEntity('issueUserState')).toBe('issueUserStates')
    expect(entityForKind('issueGitStates')).toBe('issueGitState')
    expect(rowKey('issueUserStates', markers)).toBe(key)
    expect(rowKey('issueGitStates', git)).toBe(entityId)
    expect((await replica.hydrate()).issueUserStates).toEqual([markers])
    expect((await replica.hydrate()).issueGitStates).toEqual([git])
    const notices: string[][] = []
    replica.subscribeRowBatch?.((kinds) => notices.push([...kinds]))
    cache.drop('issueUserState', key)
    replica.onKernelEvent({ type: 'evicted', entity: 'issueUserState', entityId: key })
    expect(replica.rows('issueUserStates')).toEqual([])
    cache.put('issueUserState', key, markers)
    replica.onKernelEvent({
      type: 'upserted',
      record: cache.read('issueUserState', key)!,
      readmitted: true,
    })
    expect(replica.rows('issueUserStates')).toEqual([markers])
    cache.drop('issueGitState', entityId)
    replica.onKernelEvent({ type: 'removed', entity: 'issueGitState', entityId })
    expect(replica.rows('issueGitStates')).toEqual([])
    cache.put('issueGitState', entityId, git)
    replica.onKernelEvent({
      type: 'upserted',
      record: cache.read('issueGitState', entityId)!,
      readmitted: true,
    })
    expect(replica.rows('issueGitStates')).toEqual([git])
    cache.records = []
    replica.onKernelEvent({
      type: 'bootstrap-installed',
      cause: 'rescope',
      snapshotSeq: 4,
      entityCount: 0,
      bufferedFramesApplied: 0,
    })
    expect(replica.rows('issueUserStates')).toEqual([])
    expect(replica.rows('issueGitStates')).toEqual([])
    expect(notices.at(-1)).toEqual(expect.arrayContaining(['issueUserStates', 'issueGitStates']))
  })
  it('maps every engine kind to the singular entity the wire uses, and back', () => {
    for (const kind of [
      'sessions',
      'issueProjections',
      'conversations',
      'automations',
      'automationRuns',
    ] as const) {
      expect(kindForEntity(entityForKind(kind))).toBe(kind)
    }
    expect(entityForKind('automationRuns')).toBe('automationRun')
    expect(entityForKind('sessions')).toBe('session')
    // MEASURED, not assumed: replacing the table with a naive `entity + 's'`
    // leaves this round-trip GREEN — all five names happen to pluralise that
    // way. The assertion that actually kills that mutant is the leniency case
    // below, because `+ 's'` claims to know every entity in the world. Said
    // here so nobody reads this test as the one guarding the mapping.
  })

  it('renders the chat message records (POD-4764) and lets one go by its composite change id', () => {
    expect(kindForEntity('message')).toBe('messageRecords')
    expect(entityForKind('messageRecords')).toBe('message')
    const { cache, replica } = build()
    const rowId = 's1\nusr_me\nmsg_1'
    cache.put('message', rowId, {
      id: 'msg_1',
      sessionId: 's1',
      senderUserId: 'usr_me',
      status: 'typed',
    })
    expect(replica.rows('messageRecords')).toMatchObject([{ id: 'msg_1', status: 'typed' }])
    cache.drop('message', rowId)
    replica.onKernelEvent({ type: 'removed', entity: 'message', entityId: rowId })
    expect(replica.rows('messageRecords')).toEqual([])
  })

  it('reports an unrendered entity as not-mine rather than throwing (ADR 2 D4 leniency)', () => {
    expect(kindForEntity('somethingPhase3AddsLater')).toBeUndefined()
  })

  it('keys sessions on sessionId and everything else on id', () => {
    expect(rowKey('sessions', session('s1'))).toBe('s1')
    expect(rowKey('issueProjections', issue('i1'))).toBe('i1')
  })
})

describe('read model projection', () => {
  it('projects only its own kind, and in a deterministic order', () => {
    const { cache, replica } = build()
    cache.put('session', 's2', session('s2'))
    cache.put('issueProjection', 'i1', issue('i1'))
    cache.put('session', 's1', session('s1'))

    expect(replica.rows('sessions').map((r) => r.sessionId)).toEqual(['s1', 's2'])
    expect(replica.rows('issueProjections').map((r) => r.id)).toEqual(['i1'])
    expect(replica.rows('conversations')).toEqual([])
  })

  it('ignores an entity kind the read model does not render', () => {
    const { cache, replica } = build()
    cache.put('sessionBinding', 'x', { id: 'x' })
    cache.put('session', 's1', session('s1'))
    expect(replica.rows('sessions').map((r) => r.sessionId)).toEqual(['s1'])
  })

  it('returns a STABLE empty identity so pre-bootstrap snapshots do not churn', () => {
    const { replica } = build()
    expect(replica.rows('sessions')).toBe(replica.rows('issueProjections'))
  })

  it('reads as empty rather than throwing when the store is unreadable', () => {
    const { cache, replica } = build()
    cache.throwOnRead = true
    expect(() => replica.rows('sessions')).not.toThrow()
    expect(replica.rows('sessions')).toEqual([])
  })

  it('surfaces cursor and durability from the kernel cache', () => {
    const { cache, replica } = build()
    expect(replica.getCursor()).toBeNull()
    expect(replica.persistent).toBe(true)
    cache.cursor = { seq: 42 }
    cache.mode = 'degraded-memory'
    expect(replica.getCursor()).toBe(42)
    expect(replica.persistent).toBe(false)
  })

  it('hydrates from what is already durable — the cold-start paint read', async () => {
    const { cache, replica } = build()
    cache.put('session', 's1', session('s1'))
    cache.cursor = { seq: 7 }
    const snap = await replica.hydrate()
    expect(snap.sessions.map((r) => r.sessionId)).toEqual(['s1'])
    expect(snap.cursor).toBe(7)
  })
})

describe('incremental projection — per-drain work must not scale with the store', () => {
  // The regression this block guards was MEASURED, not hypothesised: every
  // inbound change cleared the per-kind memo and re-materialised every entity of
  // every kind through `readEntities()` on the next read — 628ms per change in a
  // live client (r² = 0.9997 over 228 envelopes), ~38x the 16.7ms feed task
  // budget. The contract now is that an event applies as a DELTA: the store is
  // materialised once, and a change re-reads its own row, never the world.
  const upserted = (entity: string, entityId: string): ReplicaEvent => ({
    type: 'upserted',
    record: { entity, entityId, value: {}, provenance: { seq: 1 } },
    readmitted: false,
  })

  it('applies an upsert as a delta, at its sorted position, without a rescan', () => {
    const { cache, replica } = build()
    // Ballast in ANOTHER kind: the cost the old path paid was the whole store,
    // so the guard only means something with a store much bigger than the slice.
    for (let i = 0; i < 500; i += 1) {
      cache.records.push({
        entity: 'issueEvent',
        entityId: `e${i}`,
        value: { id: `e${i}` },
        provenance: { seq: 1 },
      })
    }
    cache.put('session', 's1', session('s1'))
    cache.put('session', 's3', session('s3'))
    expect(replica.rows('sessions').map((r) => r.sessionId)).toEqual(['s1', 's3'])
    const issueEventsBefore = replica.rows('issueEvents')
    expect(cache.readEntitiesCalls).toBe(1)

    // Lands BETWEEN the held rows — the delta must respect `keyOf` order, not
    // append.
    cache.put('session', 's2', session('s2'))
    replica.onKernelEvent(upserted('session', 's2'))
    expect(replica.rows('sessions').map((r) => r.sessionId)).toEqual(['s1', 's2', 's3'])
    expect(cache.readEntitiesCalls).toBe(1)
    // The untouched kind keeps its identity — worklist's `sourceEqual` memoises
    // on exactly this reference.
    expect(replica.rows('issueEvents')).toBe(issueEventsBefore)
  })

  it('applies a removal as a delta; removing a row this view never held keeps the identity', () => {
    const { cache, replica } = build()
    cache.put('session', 's1', session('s1'))
    cache.put('session', 's2', session('s2'))
    const before = replica.rows('sessions')
    expect(cache.readEntitiesCalls).toBe(1)

    cache.drop('session', 's1')
    replica.onKernelEvent({ type: 'removed', entity: 'session', entityId: 's1' })
    expect(replica.rows('sessions').map((r) => r.sessionId)).toEqual(['s2'])
    expect(cache.readEntitiesCalls).toBe(1)

    // A remove for a row that was never projected changes nothing, so the
    // array identity survives — "no change" and "no event" must be
    // indistinguishable to an identity-keyed memo.
    const held = replica.rows('sessions')
    replica.onKernelEvent({ type: 'removed', entity: 'session', entityId: 'never-held' })
    expect(replica.rows('sessions')).toBe(held)
    expect(replica.rows('sessions')).not.toBe(before)
  })

  it('a bootstrap install still replaces the world: deltas cannot describe a swap', () => {
    const { cache, replica } = build()
    cache.put('session', 'old', session('old'))
    expect(replica.rows('sessions')).toHaveLength(1)

    cache.records = []
    cache.put('session', 'new-1', session('new-1'))
    cache.put('session', 'new-2', session('new-2'))
    replica.onKernelEvent({
      type: 'bootstrap-installed',
      cause: 'rescope',
      snapshotSeq: 9,
      entityCount: 2,
      bufferedFramesApplied: 0,
    })
    expect(replica.rows('sessions').map((r) => r.sessionId)).toEqual(['new-1', 'new-2'])
    // The swap re-scans ONCE for all kinds together, not once per kind.
    expect(cache.readEntitiesCalls).toBe(2)
  })

  it('stays under the feed task budget applying one change against a large store', () => {
    const { cache, replica } = build()
    const rows = 20_000
    for (let i = 0; i < rows; i += 1) {
      const id = `s${String(i).padStart(6, '0')}`
      cache.records.push({
        entity: 'session',
        entityId: id,
        value: { sessionId: id },
        provenance: { seq: 1 },
      })
    }
    expect(replica.rows('sessions')).toHaveLength(rows)

    // Median of repeated runs, so one GC pause cannot fail the build; the
    // structural assertion (no rescan) is above — this is the budget backstop
    // the live measurement was made against.
    const samples: number[] = []
    for (let run = 0; run < 25; run += 1) {
      const id = `s${String(run).padStart(6, '0')}`
      const value = { sessionId: id }
      const record = cache.records[run] as { value: unknown }
      record.value = value // in place: FakeCache.put would cost O(store) itself
      const startedAt = performance.now()
      replica.onKernelEvent(upserted('session', id))
      replica.rows('sessions')
      samples.push(performance.now() - startedAt)
    }
    samples.sort((a, b) => a - b)
    expect(samples[Math.floor(samples.length / 2)]).toBeLessThan(FEED_TASK_BUDGET_MS)
    expect(cache.readEntitiesCalls).toBe(1)
  })
})

describe('row subscriptions', () => {
  let cache: FakeCache
  let replica: ReturnType<typeof build>['replica']
  let sessionsFired: number
  let issuesFired: number

  beforeEach(() => {
    const built = build()
    cache = built.cache
    replica = built.replica
    sessionsFired = 0
    issuesFired = 0
    replica.subscribeRows('sessions', () => {
      sessionsFired += 1
    })
    replica.subscribeRows('issueProjections', () => {
      issuesFired += 1
    })
  })

  const upserted = (entity: string, entityId: string): ReplicaEvent => ({
    type: 'upserted',
    record: { entity, entityId, value: {}, provenance: { seq: 1 } },
    readmitted: false,
  })

  it('fires the touched kind and only the touched kind', () => {
    cache.put('session', 's1', session('s1'))
    replica.onKernelEvent(upserted('session', 's1'))
    expect(sessionsFired).toBe(1)
    expect(issuesFired).toBe(0)
  })

  it('re-projects after an event rather than serving the stale memo', () => {
    cache.put('session', 's1', session('s1'))
    replica.onKernelEvent(upserted('session', 's1'))
    expect(replica.rows('sessions')).toHaveLength(1)

    cache.put('session', 's2', session('s2'))
    replica.onKernelEvent(upserted('session', 's2'))
    expect(replica.rows('sessions').map((r) => r.sessionId)).toEqual(['s1', 's2'])
  })

  it('drops the row from the read model on BOTH removed and evicted', () => {
    cache.put('session', 's1', session('s1'))
    replica.onKernelEvent(upserted('session', 's1'))
    expect(replica.rows('sessions')).toHaveLength(1)

    cache.drop('session', 's1')
    replica.onKernelEvent({ type: 'evicted', entity: 'session', entityId: 's1' })
    expect(sessionsFired).toBe(2)
    expect(replica.rows('sessions')).toHaveLength(0)

    cache.put('issueProjection', 'i1', issue('i1'))
    replica.onKernelEvent(upserted('issueProjection', 'i1'))
    cache.drop('issueProjection', 'i1')
    replica.onKernelEvent({ type: 'removed', entity: 'issueProjection', entityId: 'i1' })
    expect(replica.rows('issueProjections')).toHaveLength(0)
  })

  it('a WATERMARK-ONLY stretch does not notify, while a data frame does', () => {
    // Basis matrix case 6: the cursor advances with no data and the rendered
    // slice must stay byte-identical. This assertion is only worth anything
    // because the SAME subscription is shown firing on the data frame below —
    // a silent listener proves nothing on its own.
    cache.put('session', 's1', session('s1'))
    replica.onKernelEvent(upserted('session', 's1'))
    const before = replica.rows('sessions')
    sessionsFired = 0

    for (let seq = 2; seq <= 201; seq += 1) {
      replica.onKernelEvent({
        type: 'cursor',
        cursor: { feedId: 'f', epoch: 'e', seq },
        watermarkOnly: true,
      })
    }
    expect(sessionsFired).toBe(0)
    expect(replica.rows('sessions')).toBe(before)

    replica.onKernelEvent(upserted('session', 's1'))
    expect(sessionsFired).toBe(1)
  })

  it('posture, heal and bootstrap-failed do not move the read model either', () => {
    replica.onKernelEvent({ type: 'posture', posture: 'stale', previous: 'live' })
    replica.onKernelEvent({ type: 'heal', rung: 1, cause: 'gap' })
    replica.onKernelEvent({
      type: 'bootstrap-failed',
      cause: 'cold-start',
      attempts: 1,
      error: 'x',
    })
    expect(sessionsFired).toBe(0)
    expect(issuesFired).toBe(0)
  })

  it('a bootstrap install notifies every kind — the whole slice was replaced', () => {
    replica.onKernelEvent({
      type: 'bootstrap-installed',
      cause: 'cold-start',
      snapshotSeq: 10,
      entityCount: 3,
      bufferedFramesApplied: 0,
    })
    expect(sessionsFired).toBe(1)
    expect(issuesFired).toBe(1)
  })

  it('batch coalesces to one notification per kind, against the FINAL state', () => {
    let observed: number | null = null
    replica.subscribeRows('sessions', () => {
      observed = replica.rows('sessions').length
    })
    sessionsFired = 0
    replica.batch(() => {
      cache.put('session', 's1', session('s1'))
      replica.onKernelEvent(upserted('session', 's1'))
      cache.put('session', 's2', session('s2'))
      replica.onKernelEvent(upserted('session', 's2'))
      expect(sessionsFired).toBe(0)
    })
    expect(sessionsFired).toBe(1)
    expect(observed).toBe(2)
  })

  it('nests: only the outermost batch drains', () => {
    replica.batch(() => {
      replica.batch(() => {
        cache.put('session', 's1', session('s1'))
        replica.onKernelEvent(upserted('session', 's1'))
      })
      expect(sessionsFired).toBe(0)
    })
    expect(sessionsFired).toBe(1)
  })

  it('unsubscribes', () => {
    const off = replica.subscribeRows('issueProjections', () => {
      issuesFired += 100
    })
    off()
    replica.onKernelEvent(upserted('issueProjection', 'i1'))
    expect(issuesFired).toBe(1)
  })

  it('one throwing listener does not stop the others', () => {
    replica.subscribeRows('sessions', () => {
      throw new Error('listener blew up')
    })
    let after = 0
    replica.subscribeRows('sessions', () => {
      after += 1
    })
    expect(() => replica.onKernelEvent(upserted('session', 's1'))).not.toThrow()
    expect(after).toBe(1)
  })
})

describe('the outbox seams are the SIDE CACHE, on every platform', () => {
  it('reads the side cache, because there is nothing else left to read', () => {
    // This used to be one half of a pair: an INJECTED `init.outbox` (mobile's
    // views over its SQLite outbox rows) against this side-cache fallback
    // (web). POD-2073 deleted the injected half — both platforms now run the
    // kernel `Outbox` over `OutboxStorePort`, which owns those records, and a
    // second `OutboxStorage` driver over them was the two-writer arrangement
    // this facade's header rules out.
    //
    // So the surviving case is no longer a "fallback": these three seams belong
    // to the compatibility `Outbox` and resolve to the side cache, always. A
    // future edit that reintroduces a store-backed injection here should read
    // the header before this test goes green again.
    const cache = new FakeCache()
    const side = createSideCache({ storage: memoryStorage(), enumerateKeys: () => [] })
    side
      .outboxStorage()
      .save([
        { mutationId: asMutationId('from-side-cache'), kind: 'rename', input: {}, queuedAt: 1 },
      ])
    const replica = createKernelReplica({ cache, side })
    expect(
      replica
        .outboxStorage()
        .load()
        .map((e) => e.mutationId),
    ).toEqual(['from-side-cache'])
  })
})

describe('the wire-v1 write path is REFUSED, loudly', () => {
  // The point of these four: a facade wired to a v1 hub must fail at the first
  // frame. A no-op would leave the engine painting a frozen slice while the hub
  // reported a healthy connection — an instrument that cannot say NO.
  it.each([
    ['applySnapshot', (r: ReturnType<typeof build>['replica']) => r.applySnapshot('sessions', [])],
    [
      'applyChanges',
      (r: ReturnType<typeof build>['replica']) => r.applyChanges('sessions', [], []),
    ],
    ['setCursor', (r: ReturnType<typeof build>['replica']) => r.setCursor(1)],
    ['collection', (r: ReturnType<typeof build>['replica']) => r.collection('sessions')],
  ])('%s throws and names the wiring error', (name, call) => {
    const { replica } = build()
    expect(() => call(replica)).toThrow(new RegExp(name))
    expect(() => call(replica)).toThrow(/kernel feed|kernel path/)
  })
})

describe('the side cache', () => {
  it('persists ui-state, notifies subscribers, and deletes on null', () => {
    const storage = memoryStorage()
    const side = createSideCache({ storage, enumerateKeys: () => [] })
    const ui = side.uiState()
    const cb = vi.fn()
    ui.subscribe(cb)

    ui.set('podium.view', 'sessions')
    expect(ui.get('podium.view')).toBe('sessions')
    expect(cb).toHaveBeenCalledTimes(1)

    // A write of the same value is not a change and must not notify.
    ui.set('podium.view', 'sessions')
    expect(cb).toHaveBeenCalledTimes(1)

    ui.set('podium.view', null)
    expect(ui.get('podium.view')).toBeNull()
    expect(cb).toHaveBeenCalledTimes(2)

    // Survives a reload of the same storage.
    expect(
      createSideCache({ storage, enumerateKeys: () => [] })
        .uiState()
        .get('podium.view'),
    ).toBeNull()
    ui.set('podium.dockTab', 'files')
    expect(
      createSideCache({ storage, enumerateKeys: () => [] })
        .uiState()
        .get('podium.dockTab'),
    ).toBe('files')
  })

  it('folds the raw legacy localStorage keys in once, and leaves the mirrored ones', () => {
    const storage = memoryStorage()
    storage.setItem('podium.view', 'issueProjections')
    storage.setItem('podium.theme.mode', 'dark')
    storage.setItem('podium:sidebar:width', '320')
    storage.setItem('podium.htmlmode:tab-1', 'raw')

    const side = createSideCache({
      storage,
      enumerateKeys: () => ['podium:sidebar:width', 'podium.htmlmode:tab-1'],
    })
    const ui = side.uiState()
    expect(ui.get('podium.view')).toBe('issueProjections')
    expect(ui.get('podium:sidebar:width')).toBe('320')
    expect(JSON.parse(ui.get('podium.htmlmode') ?? '{}')).toEqual({ 'tab-1': 'raw' })

    // Migrated keys are retired…
    expect(storage.getItem('podium.view')).toBeNull()
    // …except the theme, which index.html's anti-flash script reads before React.
    expect(storage.getItem('podium.theme.mode')).toBe('dark')
    expect(ui.get('podium.theme.mode')).toBe('dark')
  })

  it('bounds the transcript cache: newest items per conversation, LRU across them', () => {
    let clock = 0
    const storage = memoryStorage()
    const side = createSideCache({
      storage,
      enumerateKeys: () => [],
      now: () => (clock += 1),
    })
    const items = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `m${i}` })) as never[]

    side.putTranscriptWindow('c1', items(250))
    expect(side.transcriptWindow('c1')?.items).toHaveLength(200)
    expect((side.transcriptWindow('c1')?.items[0] as { id: string }).id).toBe('m50')

    for (let i = 2; i <= 51; i += 1) side.putTranscriptWindow(`c${i}`, items(1))
    // 51 conversations written, cap is 50, so the oldest write is gone and the
    // newest is kept.
    expect(side.transcriptWindow('c1')).toBeUndefined()
    expect(side.transcriptWindow('c51')).toBeDefined()

    const reloaded = createSideCache({ storage, enumerateKeys: () => [] })
    expect(reloaded.transcriptWindow('c1')).toBeUndefined()
    expect(reloaded.transcriptWindow('c51')).toBeDefined()
  })

  it('writes one transcript shard and lazily recovers untouched v1 windows', () => {
    const values = new Map<string, string>()
    const writes: { key: string; value: string }[] = []
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => {
        values.set(key, value)
        writes.push({ key, value })
      },
      removeItem: (key: string) => void values.delete(key),
    }
    const legacyKey = 'podium.kernel-replica.transcripts.v1'
    values.set(
      legacyKey,
      JSON.stringify({
        'conversation/one': { items: [{ id: 'old-1' }], savedAt: 1 },
        'conversation/two': { items: [{ id: 'old-2' }], savedAt: 2 },
      }),
    )

    const side = createSideCache({ storage, enumerateKeys: () => [], now: () => 3 })
    writes.length = 0
    side.putTranscriptWindow('conversation/one', [{ id: 'new-1' }] as never[])

    expect(writes.map((write) => write.key)).toEqual([
      'podium.kernel-replica.transcript-window.v2.conversation%2Fone',
      'podium.kernel-replica.transcripts-index.v2',
    ])
    expect(values.get(legacyKey)).toContain('old-2')
    expect(writes.every((write) => write.value.length < (values.get(legacyKey)?.length ?? 0))).toBe(
      true,
    )

    const reloaded = createSideCache({ storage, enumerateKeys: () => [] })
    expect((reloaded.transcriptWindow('conversation/one')?.items[0] as { id: string }).id).toBe(
      'new-1',
    )
    expect((reloaded.transcriptWindow('conversation/two')?.items[0] as { id: string }).id).toBe(
      'old-2',
    )

    writes.length = 0
    reloaded.putTranscriptWindow('conversation/one', [{ id: 'newer-1' }] as never[])
    expect(writes.map((write) => write.key)).toEqual([
      'podium.kernel-replica.transcript-window.v2.conversation%2Fone',
    ])
  })

  it('keeps the queued and awaiting-truth outbox stages in SEPARATE homes', () => {
    const side = createSideCache({ storage: memoryStorage(), enumerateKeys: () => [] })
    side
      .outboxStorage()
      .save([{ mutationId: asMutationId('m1'), kind: 'rename', input: {}, queuedAt: 1 }])
    expect(side.outboxAwaitingStorage().load()).toEqual([])
    expect(side.outboxStorage().load()).toHaveLength(1)
  })

  describe('queued offline writes survive the flag flip', () => {
    // The defect this covers: turning `kernel-replica` on moves the engine's
    // outbox to a new key, so a rename queued offline under the legacy path
    // would sit in a blob nothing reads again — user-authored work lost at the
    // moment somebody flips a flag, with no notice.
    const queued = (mutationId: string) => ({
      mutationId,
      kind: 'rename',
      input: { sessionId: 's1', name: 'offline' },
      queuedAt: 1,
    })

    it('folds in the PRE-collection array blob', () => {
      const storage = memoryStorage()
      storage.setItem('podium.outbox.v1', JSON.stringify([queued('m1')]))
      const side = createSideCache({ storage, enumerateKeys: () => [] })
      expect(
        side
          .outboxStorage()
          .load()
          .map((e) => e.mutationId),
      ).toEqual(['m1'])
    })

    it('folds in the COLLECTION blob, whose shape is an object of rows', () => {
      const storage = memoryStorage()
      storage.setItem(
        'podium.replica.outbox.v1',
        JSON.stringify({ m2: { ...queued('m2'), seq: 0, $key: 'm2' } }),
      )
      const side = createSideCache({ storage, enumerateKeys: () => [] })
      expect(
        side
          .outboxStorage()
          .load()
          .map((e) => e.mutationId),
      ).toEqual(['m2'])
    })

    it('retires the raw blob after the acting principal has a durable copy', () => {
      const storage = memoryStorage()
      const raw = JSON.stringify([queued('m1')])
      storage.setItem('podium.outbox.v1', raw)
      createSideCache({ storage, enumerateKeys: () => [] })
      expect(storage.getItem('podium.outbox.v1')).toBeNull()
    })

    it('is idempotent by mutationId — a second boot does not duplicate the queue', () => {
      const storage = memoryStorage()
      storage.setItem('podium.outbox.v1', JSON.stringify([queued('m1'), queued('m2')]))
      createSideCache({ storage, enumerateKeys: () => [] })
      const second = createSideCache({ storage, enumerateKeys: () => [] })
      expect(
        second
          .outboxStorage()
          .load()
          .map((e) => e.mutationId),
      ).toEqual(['m1', 'm2'])
    })

    it('never clobbers entries this path already queued', () => {
      const storage = memoryStorage()
      storage.setItem('podium.outbox.v1', JSON.stringify([queued('legacy-1')]))
      storage.setItem(
        'podium.kernel-replica.outbox.v1',
        JSON.stringify([queued('kernel-already-here')]),
      )
      const side = createSideCache({ storage, enumerateKeys: () => [] })
      expect(
        side
          .outboxStorage()
          .load()
          .map((e) => e.mutationId),
      ).toEqual(['kernel-already-here', 'legacy-1'])
    })

    it('ignores rows that are not entries, rather than queueing garbage', () => {
      const storage = memoryStorage()
      storage.setItem(
        'podium.replica.outbox.v1',
        JSON.stringify({
          good: queued('m1'),
          notAnEntry: { sessionId: 's1', name: 'a session row' },
          alsoNot: 42,
          nope: null,
        }),
      )
      const side = createSideCache({ storage, enumerateKeys: () => [] })
      expect(
        side
          .outboxStorage()
          .load()
          .map((e) => e.mutationId),
      ).toEqual(['m1'])
    })

    it('is REFUSED when the device cannot be attributed — someone else’s unsent work', () => {
      // POD-307's fail-closed rule reaching the queue: a pre-identity device's
      // queued writes are not this user's to replay. The composition root passes
      // the same verdict the entity rows get.
      const storage = memoryStorage()
      storage.setItem('podium.outbox.v1', JSON.stringify([queued('m1')]))
      const side = createSideCache({
        storage,
        enumerateKeys: () => [],
        adoptLegacyOutbox: false,
      })
      expect(side.outboxStorage().load()).toEqual([])
    })

    it('a refusal DECLINES rather than destroys — a later attributable boot still adopts', () => {
      // Declining to adopt is not the same as discarding. If the refusal marked
      // the fold done, the work would be stranded forever by one ambiguous boot.
      const storage = memoryStorage()
      storage.setItem('podium.outbox.v1', JSON.stringify([queued('m1')]))
      createSideCache({ storage, enumerateKeys: () => [], adoptLegacyOutbox: false })
      const later = createSideCache({ storage, enumerateKeys: () => [], adoptLegacyOutbox: true })
      expect(
        later
          .outboxStorage()
          .load()
          .map((e) => e.mutationId),
      ).toEqual(['m1'])
    })

    it('an unreadable legacy blob yields nothing and does not throw', () => {
      const storage = memoryStorage()
      storage.setItem('podium.outbox.v1', '{not json')
      expect(() => createSideCache({ storage, enumerateKeys: () => [] })).not.toThrow()
      expect(
        createSideCache({ storage, enumerateKeys: () => [] })
          .outboxStorage()
          .load(),
      ).toEqual([])
    })
  })

  describe('a denied outbox write is SURFACED, never swallowed', () => {
    /**
     * A storage that denies writes the way a real browser does at quota.
     *
     * The rest of this file runs over `memoryStorage()`, which never denies
     * anything — so the outbox's catch is unreachable there BY CONSTRUCTION and
     * a case written against it would have passed before the fix existed. This
     * double is what makes the quota path expressible at all.
     */
    function denyingStorage(deny: (key: string) => boolean) {
      const map = new Map<string, string>()
      return {
        getItem: (k: string) => map.get(k) ?? null,
        setItem: (k: string, v: string) => {
          if (deny(k)) {
            const error = new Error('QuotaExceededError')
            error.name = 'QuotaExceededError'
            throw error
          }
          map.set(k, v)
        },
        removeItem: (k: string) => {
          map.delete(k)
        },
      }
    }

    const entry = { mutationId: asMutationId('m1'), kind: 'rename', input: {}, queuedAt: 1 }

    it('RETHROWS when the queue cannot be persisted, and reports the degradation', () => {
      // ADR 6 D4.3: queued entries are durable on the same footing as entity
      // rows — losing them is a correctness bug, not degraded UX. A caller must
      // not be allowed to believe a queued write is safe when it is not.
      const degraded: unknown[] = []
      const side = createSideCache({
        storage: denyingStorage((k) => k.includes('outbox')),
        enumerateKeys: () => [],
        onDegraded: (error) => degraded.push(error),
      })
      expect(() => side.outboxStorage().save([entry])).toThrow(OutboxNotDurableError)
      expect(degraded).toHaveLength(1)
      expect((degraded[0] as OutboxNotDurableError).cause).toMatchObject({
        name: 'QuotaExceededError',
      })
    })

    it('NAMES the writes that are not durable, rather than saying they MAY be lost', () => {
      // POD-785 watched the ambiguous form fire in a real client: "queued offline
      // writes MAY be LOST on reload". It names no mutation and cannot be told
      // apart from a run that lost nothing, so a reader can do nothing with it.
      // The property under test is that the report is DETERMINATE — which writes
      // are on disk, which are not.
      const storage = denyingStorage(() => false)
      const side = createSideCache({ storage, enumerateKeys: () => [] })
      side.outboxStorage().save([entry, { ...entry, mutationId: asMutationId('m2') }])

      // Now the store refuses, and a third write is attempted over the two that
      // are already durable.
      const degraded: unknown[] = []
      const denying = {
        ...storage,
        setItem: (k: string, v: string) => {
          if (k.includes('outbox')) {
            const error = new Error('QuotaExceededError')
            error.name = 'QuotaExceededError'
            throw error
          }
          storage.setItem(k, v)
        },
      }
      const side2 = createSideCache({
        storage: denying,
        enumerateKeys: () => [],
        onDegraded: (error) => degraded.push(error),
      })
      expect(() =>
        side2
          .outboxStorage()
          .save([
            entry,
            { ...entry, mutationId: asMutationId('m2') },
            { ...entry, mutationId: asMutationId('m3') },
          ]),
      ).toThrow(OutboxNotDurableError)

      const failure = degraded[0] as OutboxNotDurableError
      expect(failure.notDurable).toEqual(['m3'])
      expect(failure.durable).toEqual(['m1', 'm2'])
      expect(failure.message).toContain('1 of 3')
      expect(failure.message).toContain('m3')
      expect(failure.message).not.toContain('may be LOST')
    })

    it('BOUNDS the loss: entries already on disk survive a refused rewrite', () => {
      // The blob is rewritten WHOLESALE, which invites the reading that a quota
      // failure takes the entire queue with it. Measured here rather than
      // assumed: setItem throws and leaves the previous value in place, so the
      // shortfall is exactly the entries the failed write was adding. This is
      // what licenses `notDurable` being a diff rather than "everything".
      const storage = denyingStorage(() => false)
      const side = createSideCache({ storage, enumerateKeys: () => [] })
      side.outboxStorage().save([entry, { ...entry, mutationId: asMutationId('m2') }])
      const denying = {
        ...storage,
        setItem: (k: string, v: string) => {
          if (k.includes('outbox')) throw new Error('QuotaExceededError')
          storage.setItem(k, v)
        },
      }
      const side2 = createSideCache({ storage: denying, enumerateKeys: () => [] })
      expect(() =>
        side2
          .outboxStorage()
          .save([
            entry,
            { ...entry, mutationId: asMutationId('m2') },
            { ...entry, mutationId: asMutationId('m3') },
          ]),
      ).toThrow()
      // The reload's view: the two that were durable are still there.
      expect(
        createSideCache({ storage, enumerateKeys: () => [] })
          .outboxStorage()
          .load()
          .map((e) => e.mutationId),
      ).toEqual(['m1', 'm2'])
    })

    it('an UNREADABLE store reports every entry as unaccounted for, not as durable', () => {
      // The read-back that makes the report determinate must not itself become a
      // way to under-report: a store that refuses reads yields NOTHING durable,
      // which is the honest reading, rather than an empty `notDurable` that would
      // say the write was fine.
      const degraded: unknown[] = []
      // Readable during construction (the legacy fold reads before anything
      // else), hostile from the first real write onward.
      let hostileNow = false
      const hostile = createSideCache({
        storage: {
          getItem: (k: string) => {
            if (hostileNow && k.includes('outbox')) throw new Error('SecurityError')
            return null
          },
          setItem: (k: string) => {
            if (hostileNow && k.includes('outbox')) throw new Error('QuotaExceededError')
          },
          removeItem: () => {},
        },
        enumerateKeys: () => [],
        onDegraded: (error) => degraded.push(error),
      })
      hostileNow = true
      expect(() => hostile.outboxStorage().save([entry])).toThrow(OutboxNotDurableError)
      const failure = degraded.at(-1) as OutboxNotDurableError
      expect(failure.notDurable).toEqual(['m1'])
      expect(failure.durable).toEqual([])
    })

    it('the awaiting-truth stage is held to the same standard', () => {
      const degraded: unknown[] = []
      const side = createSideCache({
        storage: denyingStorage((k) => k.includes('outbox')),
        enumerateKeys: () => [],
        onDegraded: (error) => degraded.push(error),
      })
      expect(() => side.outboxAwaitingStorage().save([entry])).toThrow(OutboxNotDurableError)
      expect(degraded).toHaveLength(1)
    })

    it('ui-state and transcripts stay BEST-EFFORT — a quota there must not break the UI', () => {
      // The counterfactual that keeps the rule above from being "throw on every
      // write": a lost sidebar width is not a correctness bug, and a preference
      // write that took the app down would be a worse defect than the one fixed.
      const side = createSideCache({
        storage: denyingStorage(() => true),
        enumerateKeys: () => [],
      })
      expect(() => side.uiState().set('podium.view', 'issueProjections')).not.toThrow()
      expect(() => side.putTranscriptWindow('c1', [])).not.toThrow()
    })
  })

  it('reads a poisoned blob as empty instead of wedging', () => {
    const storage = memoryStorage()
    storage.setItem('podium.kernel-replica.uistate.v1', '{not json')
    storage.setItem('podium.kernel-replica.outbox.v1', 'null')
    const side = createSideCache({ storage, enumerateKeys: () => [] })
    expect(side.uiState().get('podium.view')).toBeNull()
    expect(side.outboxStorage().load()).toEqual([])
  })
})

describe('addressed batches (POD-4444, additive/opt-in)', () => {
  const upserted = (entity: string, entityId: string): ReplicaEvent => ({
    type: 'upserted',
    record: { entity, entityId, value: {}, provenance: { seq: 1 } },
    readmitted: false,
  })

  it('one upsert yields one address with the committed row readable', () => {
    const { cache, replica } = build()
    const batches: unknown[] = []
    const off = replica.subscribeAddressedBatch!((batch) => batches.push(batch))
    try {
      cache.put('session', 's1', session('s1'))
      replica.onKernelEvent(upserted('session', 's1'))
      expect(batches).toEqual([{ type: 'update', rows: [{ kind: 'sessions', id: 's1' }] }])
      expect(replica.row!('sessions', 's1')).toEqual(session('s1'))
    } finally {
      off()
    }
  })

  it('a remove yields an address whose value is absent', () => {
    const { cache, replica } = build()
    cache.put('session', 's1', session('s1'))
    replica.onKernelEvent(upserted('session', 's1'))
    expect(replica.row!('sessions', 's1')).toEqual(session('s1'))
    const batches: unknown[] = []
    const off = replica.subscribeAddressedBatch!((batch) => batches.push(batch))
    try {
      cache.drop('session', 's1')
      replica.onKernelEvent({ type: 'removed', entity: 'session', entityId: 's1' })
      expect(batches).toEqual([{ type: 'update', rows: [{ kind: 'sessions', id: 's1' }] }])
      expect(replica.row!('sessions', 's1')).toBeUndefined()
    } finally {
      off()
    }
  })

  it('bootstrap and rescope emit replace events', () => {
    const { replica } = build()
    const batches: unknown[] = []
    const off = replica.subscribeAddressedBatch!((batch) => batches.push(batch))
    try {
      replica.onKernelEvent({
        type: 'bootstrap-installed',
        cause: 'cold-start',
        snapshotSeq: 1,
        entityCount: 0,
        bufferedFramesApplied: 0,
      })
      expect(batches).toEqual([{ type: 'replace', reason: 'bootstrap' }])
      replica.onKernelEvent({
        type: 'bootstrap-installed',
        cause: 'rescope',
        snapshotSeq: 2,
        entityCount: 0,
        bufferedFramesApplied: 0,
      })
      expect(batches[1]).toEqual({ type: 'replace', reason: 'rescope' })
    } finally {
      off()
    }
  })

  it('a batch of 50 upserts coalesces to one update with 50 rows', () => {
    const { cache, replica } = build()
    const batches: Array<{ type: string; rows?: Array<{ kind: string; id: string }> }> = []
    const off = replica.subscribeAddressedBatch!((batch) =>
      batches.push(batch as { type: string; rows?: Array<{ kind: string; id: string }> }),
    )
    try {
      replica.batch(() => {
        for (let n = 0; n < 50; n += 1) {
          const id = `s${n}`
          cache.put('session', id, session(id))
          replica.onKernelEvent(upserted('session', id))
        }
        expect(batches).toHaveLength(0)
      })
      expect(batches).toHaveLength(1)
      expect(batches[0]?.type).toBe('update')
      expect(batches[0]?.rows).toHaveLength(50)
    } finally {
      off()
    }
  })
})
