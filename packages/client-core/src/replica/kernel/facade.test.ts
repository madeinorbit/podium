import type { EntityRecord, ReplicaEvent } from '@podium/sync/replica'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { memoryStorage } from '../replica'
import { createKernelReplica, type KernelCacheRead } from './facade'
import { entityForKind, kindForEntity, rowKey } from './kinds'
import { createSideCache } from './side-cache'

/** A cache the test drives directly. The kernel Replica writes through the real
 *  one; this facade only ever READS, so a read-only double is the whole port. */
class FakeCache implements KernelCacheRead {
  records: EntityRecord[] = []
  cursor: { seq: number } | null = null
  mode: 'durable' | 'degraded-memory' | 'unavailable' = 'durable'
  throwOnRead = false

  readCursor() {
    return this.cursor
  }
  readEntities(): readonly EntityRecord[] {
    if (this.throwOnRead) throw new Error('store unreadable')
    return this.records
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

function build() {
  const cache = new FakeCache()
  const side = createSideCache({ storage: memoryStorage(), enumerateKeys: () => [] })
  return { cache, replica: createKernelReplica({ cache, side }), side }
}

const session = (sessionId: string) => ({ sessionId, name: sessionId }) as never
const issue = (id: string) => ({ id, title: id }) as never

describe('kind mapping', () => {
  it('maps every engine kind to the singular entity the wire uses, and back', () => {
    for (const kind of [
      'sessions',
      'issues',
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

  it('reports an unrendered entity as not-mine rather than throwing (ADR 2 D4 leniency)', () => {
    expect(kindForEntity('somethingPhase3AddsLater')).toBeUndefined()
  })

  it('keys sessions on sessionId and everything else on id', () => {
    expect(rowKey('sessions', session('s1'))).toBe('s1')
    expect(rowKey('issues', issue('i1'))).toBe('i1')
  })
})

describe('read model projection', () => {
  it('projects only its own kind, and in a deterministic order', () => {
    const { cache, replica } = build()
    cache.put('session', 's2', session('s2'))
    cache.put('issue', 'i1', issue('i1'))
    cache.put('session', 's1', session('s1'))

    expect(replica.rows('sessions').map((r) => r.sessionId)).toEqual(['s1', 's2'])
    expect(replica.rows('issues').map((r) => r.id)).toEqual(['i1'])
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
    expect(replica.rows('sessions')).toBe(replica.rows('issues'))
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
    replica.subscribeRows('issues', () => {
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

    cache.put('issue', 'i1', issue('i1'))
    replica.onKernelEvent(upserted('issue', 'i1'))
    cache.drop('issue', 'i1')
    replica.onKernelEvent({ type: 'removed', entity: 'issue', entityId: 'i1' })
    expect(replica.rows('issues')).toHaveLength(0)
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
    const off = replica.subscribeRows('issues', () => {
      issuesFired += 100
    })
    off()
    replica.onKernelEvent(upserted('issue', 'i1'))
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
    storage.setItem('podium.view', 'issues')
    storage.setItem('podium.theme.preset', 'superade')
    storage.setItem('podium:sidebar:width', '320')
    storage.setItem('podium.htmlmode:tab-1', 'raw')

    const side = createSideCache({
      storage,
      enumerateKeys: () => ['podium:sidebar:width', 'podium.htmlmode:tab-1'],
    })
    const ui = side.uiState()
    expect(ui.get('podium.view')).toBe('issues')
    expect(ui.get('podium:sidebar:width')).toBe('320')
    expect(JSON.parse(ui.get('podium.htmlmode') ?? '{}')).toEqual({ 'tab-1': 'raw' })

    // Migrated keys are retired…
    expect(storage.getItem('podium.view')).toBeNull()
    // …except the theme, which index.html's anti-flash script reads before React.
    expect(storage.getItem('podium.theme.preset')).toBe('superade')
    expect(ui.get('podium.theme.preset')).toBe('superade')
  })

  it('bounds the transcript cache: newest items per conversation, LRU across them', () => {
    let clock = 0
    const side = createSideCache({
      storage: memoryStorage(),
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
  })

  it('keeps the queued and awaiting-truth outbox stages in SEPARATE homes', () => {
    const side = createSideCache({ storage: memoryStorage(), enumerateKeys: () => [] })
    side.outboxStorage().save([{ mutationId: 'm1', kind: 'rename', input: {}, queuedAt: 1 }])
    expect(side.outboxAwaitingStorage().load()).toEqual([])
    expect(side.outboxStorage().load()).toHaveLength(1)
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
