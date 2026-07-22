import { transaction } from '@podium/runtime/sqlite'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CHANGE_MAX_AGE_MS, CHANGE_PRUNE_EVERY } from './change-log'
import { type EntityChangeSpec, Ledger, prepareLedgerBoot } from './ledger'
import { SyncRepository } from './sync-repository'
import { createTestSyncDatabase, createTestSyncRepository } from './test-support'

// The write-seam change log [spec:SP-3fe2] (#253): commit() must append exactly
// the declared-and-real changes atomically with the entity write, reconcile()
// must diff full truth including removes, and both must preserve the oplog's
// dedup/projection/retention/cursor semantics byte-for-byte.

const passthrough = <T>(fn: () => T): T => fn()

function makeLedger(repo = createTestSyncRepository(), now: () => number = Date.now) {
  return new Ledger({ repo, now, transact: passthrough })
}

const issueSpec = (id: string, v: number): EntityChangeSpec => ({
  entity: 'issue',
  id,
  op: 'upsert',
  value: { id, title: `t${v}` },
})
const removeSpec = (id: string): EntityChangeSpec => ({ entity: 'issue', id, op: 'remove' })

/** commit() a batch of specs with a throwaway write. */
function commit(ledger: Ledger, specs: EntityChangeSpec[]) {
  return ledger.commit({ write: () => 'ok', changes: () => specs })
}

describe('Ledger', () => {
  it('appends declared changes, dedups no-op upserts, and returns the write result', () => {
    const ledger = makeLedger()
    const first = ledger.commit({
      write: () => 42,
      changes: () => [issueSpec('a', 1), issueSpec('b', 1)],
    })
    expect(first.result).toBe(42)
    expect(first.changes.map((c) => [c.id, c.op])).toEqual([
      ['a', 'upsert'],
      ['b', 'upsert'],
    ])
    // Byte-identical re-declaration -> fully deduped, result still returned.
    const dup = commit(ledger, [issueSpec('a', 1), issueSpec('b', 1)])
    expect(dup.result).toBe('ok')
    expect(dup.changes).toEqual([])
    // One field change + one explicit remove -> exactly two rows.
    const second = commit(ledger, [issueSpec('a', 2), removeSpec('b')])
    expect(second.changes.map((c) => [c.id, c.op])).toEqual([
      ['a', 'upsert'],
      ['b', 'remove'],
    ])
    expect(second.changes[0]).toMatchObject({ entity: 'issue', value: { id: 'a', title: 't2' } })
    expect(ledger.cursor()).toBe(4)
    // Removing an id the log never recorded (or already removed) is a no-op.
    expect(commit(ledger, [removeSpec('b')]).changes).toEqual([])
    expect(commit(ledger, [removeSpec('ghost')]).changes).toEqual([])
    // Re-appearance after a remove is a fresh upsert.
    expect(commit(ledger, [issueSpec('b', 9)]).changes.map((c) => c.op)).toEqual(['upsert'])
  })

  it('never infers removes: undeclared entities are untouched by commit()', () => {
    const ledger = makeLedger()
    commit(ledger, [issueSpec('a', 1), issueSpec('b', 1)])
    // A commit touching only `a` must not read b's absence as deletion
    // (the oplog's `partial: true` semantics, now the ONLY commit mode).
    const third = commit(ledger, [issueSpec('a', 2)])
    expect(third.changes.map((c) => [c.id, c.op])).toEqual([['a', 'upsert']])
    // b is still in the baseline: reconciling the full truth without it removes it.
    const rec = ledger.reconcile('issue', [{ id: 'a', value: { id: 'a', title: 't2' } }])
    expect(rec.map((c) => [c.id, c.op])).toEqual([['b', 'remove']])
  })

  it('stages intra-batch sequences against the batch overlay, not just the baseline', () => {
    const ledger = makeLedger()
    // First-sight upsert followed by remove in ONE batch: both must land, so
    // the log's fold ends at "absent" (baseline-only dedup would drop the remove).
    const both = commit(ledger, [issueSpec('x', 1), removeSpec('x')])
    expect(both.changes.map((c) => c.op)).toEqual(['upsert', 'remove'])
    expect(ledger.reconcile('issue', []).map((c) => c.op)).toEqual([]) // x already absent
  })

  it('reconcile() diffs full truth against the baseline including removes', () => {
    const repo = createTestSyncRepository()
    const ledger = new Ledger({ repo, now: Date.now, transact: passthrough })
    commit(ledger, [issueSpec('a', 1), issueSpec('b', 1)])
    const rec = ledger.reconcile('issue', [{ id: 'a', value: { id: 'a', title: 't2' } }])
    expect(rec.map((c) => [c.id, c.op])).toEqual([
      ['a', 'upsert'],
      ['b', 'remove'],
    ])
    // Unchanged truth reconciles to nothing.
    expect(ledger.reconcile('issue', [{ id: 'a', value: { id: 'a', title: 't2' } }])).toEqual([])
  })

  it('capture() appends explicitly owned non-row changes without a full-list diff', () => {
    const ledger = makeLedger()

    expect(ledger.capture([issueSpec('a', 1)])).toEqual([
      expect.objectContaining({ entity: 'issue', id: 'a', op: 'upsert', seq: 1 }),
    ])
    expect(ledger.capture([issueSpec('a', 1)])).toEqual([])
    expect(ledger.capture([issueSpec('a', 2), removeSpec('a')]).map((c) => c.op)).toEqual([
      'upsert',
      'remove',
    ])
    expect(ledger.cursor()).toBe(3)
  })

  it('serves changesSince within the retained range and rejects everything else', () => {
    const ledger = makeLedger()
    expect(ledger.changesSince(null)).toBeNull() // bootstrap -> snapshot
    expect(ledger.changesSince(0)).toEqual([]) // empty log, cursor at head
    commit(ledger, [issueSpec('a', 1)])
    commit(ledger, [issueSpec('a', 2)])
    expect(ledger.changesSince(0)?.map((c) => c.seq)).toEqual([1, 2])
    expect(ledger.changesSince(1)?.map((c) => c.seq)).toEqual([2])
    expect(ledger.changesSince(2)).toEqual([]) // caught up
    expect(ledger.changesSince(3)).toBeNull() // future cursor (server DB reset)
  })

  it('falls back to snapshot when the cursor predates the retained log', () => {
    const repo = createTestSyncRepository()
    const ledger = new Ledger({ repo, now: Date.now, transact: passthrough })
    commit(ledger, [issueSpec('a', 1)])
    commit(ledger, [issueSpec('a', 2)])
    commit(ledger, [issueSpec('a', 3)])
    repo.pruneChangeBatch(
      repo.planChangePrune({ keepRows: 1, maxAgeMs: 60_000, now: Date.now() }),
      500,
    )
    expect(ledger.changesSince(0)).toBeNull() // seq 1-2 pruned away -> gap
    expect(ledger.changesSince(2)?.map((c) => c.seq)).toEqual([3]) // still contiguous
  })

  it('falls back to snapshot on a corrupt upsert row (null payload)', () => {
    const repo = createTestSyncRepository()
    const ledger = new Ledger({ repo, now: Date.now, transact: passthrough })
    commit(ledger, [issueSpec('a', 1)])
    repo.appendChanges(
      [{ entity: 'issue', entityId: 'b', op: 'upsert', payload: null }],
      Date.now(),
    )
    expect(ledger.changesSince(0)).toBeNull() // hole -> snapshot, not a crash
  })

  it('prunes a bloated log before construction (boot self-heal)', async () => {
    const repo = createTestSyncRepository()
    const t0 = 1_000_000
    repo.appendChanges([{ entity: 'issue', entityId: 'a', op: 'upsert', payload: '{}' }], t0)
    const young = t0 + CHANGE_MAX_AGE_MS + 60_000
    repo.appendChanges([{ entity: 'issue', entityId: 'b', op: 'upsert', payload: '{}' }], young)
    // Boot with "now" past row 1's age budget but within row 2's: readiness
    // waits for the full sliced prune before the constructor folds the baseline.
    await prepareLedgerBoot({ repo, now: () => young + 1 })
    const ledger = new Ledger({ repo, now: () => young + 1, transact: passthrough })
    expect(repo.minChangeSeq()).toBe(2)
    expect(repo.maxChangeSeq()).toBe(2)
    // The surviving row still seeds the dedup baseline: re-committing it is a no-op.
    expect(
      commit(ledger, [{ entity: 'issue', id: 'b', op: 'upsert', value: JSON.parse('{}') }]).changes,
    ).toEqual([])
  })

  it('does not fold the baseline between the first boot-prune slice and readiness', async () => {
    const inner = createTestSyncRepository()
    const calls: string[] = []
    let monotonicMs = 0
    let batches = 0
    const repo = new Proxy(inner, {
      get(target, prop, receiver) {
        if (prop === 'planChangePrune') {
          return () => {
            calls.push('plan')
            return { thresholdSeq: 201 }
          }
        }
        if (prop === 'pruneChangeBatch') {
          return () => {
            calls.push('delete')
            monotonicMs += 13
            return batches++ === 0 ? 100 : 1
          }
        }
        if (prop === 'latestChangeStates') {
          return () => {
            calls.push('fold')
            return []
          }
        }
        const value = Reflect.get(target, prop, receiver)
        return typeof value === 'function' ? value.bind(target) : value
      },
    })

    const ready = prepareLedgerBoot({
      repo,
      now: Date.now,
      monotonicNow: () => monotonicMs,
    }).then(() => new Ledger({ repo, now: Date.now, transact: passthrough }))

    // Planning and one bounded delete happen synchronously; the 13ms slice then
    // yields. Folding must remain behind the readiness promise.
    expect(calls).toEqual(['plan', 'delete'])
    await ready
    expect(calls).toEqual(['plan', 'delete', 'delete', 'fold'])
  })

  it('[POD-925] append cadence no longer prunes — janitor owns ongoing retention', () => {
    const repo = createTestSyncRepository()
    const t0 = 1_000_000
    const young = t0 + CHANGE_MAX_AGE_MS + 60_000
    let now = t0
    const ledger = new Ledger({ repo, now: () => now, transact: passthrough })
    commit(ledger, [issueSpec('a', 0)]) // batch 1, aged
    now = young
    for (let i = 1; i < CHANGE_PRUNE_EVERY - 1; i++) commit(ledger, [issueSpec('a', i)])
    expect(repo.minChangeSeq()).toBe(1)
    commit(ledger, [issueSpec('a', CHANGE_PRUNE_EVERY)]) // was the old cadence trigger
    // Head row remains — only prepareLedgerBoot / janitor prune may delete it.
    expect(repo.minChangeSeq()).toBe(1)
    expect(repo.maxChangeSeq()).toBe(CHANGE_PRUNE_EVERY)
    expect(commit(ledger, [issueSpec('a', CHANGE_PRUNE_EVERY)]).changes).toEqual([])
  })

  it('[POD-925] overlapping append batches never schedule ledger retention flights', async () => {
    const inner = createTestSyncRepository()
    const planChangePrune = vi.fn(() => ({ thresholdSeq: 1 }))
    const repo = new Proxy(inner, {
      get(target, prop, receiver) {
        if (prop === 'planChangePrune') return planChangePrune
        const value = Reflect.get(target, prop, receiver)
        return typeof value === 'function' ? value.bind(target) : value
      },
    })
    const onPruneMetrics = vi.fn()
    const ledger = new Ledger({
      repo,
      now: Date.now,
      transact: passthrough,
      onPruneMetrics,
    })

    for (let i = 0; i < CHANGE_PRUNE_EVERY * 3; i++) {
      commit(ledger, [issueSpec(`single-flight-${i}`, i)])
    }
    await new Promise((r) => setTimeout(r, 30))
    expect(planChangePrune).not.toHaveBeenCalled()
    expect(onPruneMetrics).not.toHaveBeenCalled()
    ledger.dispose()
  })

  it('conversation commits ignore volatile-only churn but ship full payloads on stable changes', () => {
    const conv = (over: Record<string, unknown> = {}): EntityChangeSpec => ({
      entity: 'conversation',
      id: 'c1',
      op: 'upsert',
      value: {
        id: 'c1',
        title: 'hi',
        updatedAt: 'T1',
        messageCount: 1,
        statusHint: 'busy',
        ...over,
      },
    })
    const ledger = makeLedger()
    expect(commit(ledger, [conv()]).changes).toHaveLength(1) // first sight
    // Scan-driven activity bumps (updatedAt / messageCount / statusHint) changed
    // no stable field -> nothing recorded (the 81MB/day churn fix).
    expect(
      commit(ledger, [conv({ updatedAt: 'T2', messageCount: 5, statusHint: 'idle' })]).changes,
    ).toEqual([])
    // A stable-field change records — and the durable payload is the FULL current
    // wire value, volatile fields included.
    const changed = commit(ledger, [
      conv({ title: 'renamed', updatedAt: 'T3', messageCount: 9, statusHint: 'idle' }),
    ]).changes
    expect(changed).toHaveLength(1)
    expect(changed[0]).toMatchObject({
      op: 'upsert',
      value: { title: 'renamed', updatedAt: 'T3', messageCount: 9, statusHint: 'idle' },
    })
    // Explicit remove still records; reconcile-driven disappearance too.
    expect(
      commit(ledger, [{ entity: 'conversation', id: 'c1', op: 'remove' }]).changes.map((c) => c.op),
    ).toEqual(['remove'])
    // And re-appearance after a remove is a fresh upsert.
    expect(commit(ledger, [conv()]).changes.map((c) => c.op)).toEqual(['upsert'])
    expect(ledger.reconcile('conversation', []).map((c) => c.op)).toEqual(['remove'])
  })

  it('issue commits ignore session-heartbeat churn but ship full payloads on stable changes', () => {
    const issue = (over: Record<string, unknown> = {}): EntityChangeSpec => ({
      entity: 'issue',
      id: 'i1',
      op: 'upsert',
      value: {
        id: 'i1',
        title: 'fix the thing',
        stage: 'in_progress',
        unread: false,
        sessions: [{ sessionId: 's1', agentState: { phase: 'idle' }, readAt: 'T1' }],
        sessionSummary: { total: 1, byPhase: { idle: 1 } },
        ...over,
      },
    })
    const ledger = makeLedger()
    expect(commit(ledger, [issue()]).changes).toHaveLength(1) // first sight
    // Session heartbeats (phase flip / read receipt / roll-up) changed no stable
    // field -> nothing recorded (the POD-210 ledger churn fix).
    expect(
      commit(ledger, [
        issue({
          unread: true,
          sessions: [{ sessionId: 's1', agentState: { phase: 'working' }, readAt: 'T2' }],
          sessionSummary: { total: 1, byPhase: { working: 1 } },
        }),
      ]).changes,
    ).toEqual([])
    // A stable-field change records — full wire payload, sessions included.
    const changed = commit(ledger, [issue({ stage: 'review', unread: true })]).changes
    expect(changed).toHaveLength(1)
    expect(changed[0]).toMatchObject({
      op: 'upsert',
      value: { stage: 'review', unread: true },
    })
    // Removal and reconcile-driven disappearance still record.
    expect(
      commit(ledger, [{ entity: 'issue', id: 'i1', op: 'remove' }]).changes.map((c) => c.op),
    ).toEqual(['remove'])
  })

  it('the issue projection baseline survives a restart', () => {
    const repo = createTestSyncRepository()
    const before = new Ledger({ repo, now: Date.now, transact: passthrough })
    commit(before, [
      {
        entity: 'issue',
        id: 'i1',
        op: 'upsert',
        value: { id: 'i1', title: 't', sessions: [{ sessionId: 's1', phase: 'idle' }] },
      },
    ])
    const after = new Ledger({ repo, now: Date.now, transact: passthrough })
    expect(
      commit(after, [
        {
          entity: 'issue',
          id: 'i1',
          op: 'upsert',
          value: { id: 'i1', title: 't', sessions: [{ sessionId: 's1', phase: 'working' }] },
        },
      ]).changes,
    ).toEqual([]) // heartbeat-only drift across the restart must not re-record
  })

  it('the conversation projection baseline survives a restart', () => {
    const repo = createTestSyncRepository()
    const before = new Ledger({ repo, now: Date.now, transact: passthrough })
    commit(before, [
      {
        entity: 'conversation',
        id: 'c1',
        op: 'upsert',
        value: { id: 'c1', title: 'hi', updatedAt: 'T1', messageCount: 1 },
      },
    ])
    const after = new Ledger({ repo, now: Date.now, transact: passthrough })
    // Volatile-only drift across the restart must not re-record.
    expect(
      commit(after, [
        {
          entity: 'conversation',
          id: 'c1',
          op: 'upsert',
          value: { id: 'c1', title: 'hi', updatedAt: 'T9', messageCount: 42 },
        },
      ]).changes,
    ).toEqual([])
    // Sessions/issues are unaffected by the projection: byte-level dedup as before.
    expect(
      commit(after, [
        { entity: 'session', id: 's1', op: 'upsert', value: { id: 's1', updatedAt: 'T1' } },
      ]).changes,
    ).toHaveLength(1)
    expect(
      commit(after, [
        { entity: 'session', id: 's1', op: 'upsert', value: { id: 's1', updatedAt: 'T2' } },
      ]).changes,
    ).toHaveLength(1)
  })

  it('rebuilds its dedup baseline from the log across a restart', () => {
    const repo = createTestSyncRepository()
    const before = new Ledger({ repo, now: Date.now, transact: passthrough })
    commit(before, [issueSpec('a', 1), issueSpec('b', 1)])
    const cursor = before.cursor()

    // "Restart": a fresh instance over the same repo. Reconciling the
    // post-restart truth (a edited, b gone) must emit exactly that difference —
    // not re-upsert the unchanged world, and not silently rebase past the gap.
    const after = new Ledger({ repo, now: Date.now, transact: passthrough })
    const changes = after.reconcile('issue', [{ id: 'a', value: { id: 'a', title: 't2' } }])
    expect(changes.map((c) => [c.id, c.op])).toEqual([
      ['a', 'upsert'],
      ['b', 'remove'],
    ])
    // An unchanged truth emits nothing — via reconcile AND via commit dedup.
    expect(after.reconcile('issue', [{ id: 'a', value: { id: 'a', title: 't2' } }])).toEqual([])
    expect(commit(after, [issueSpec('a', 2)]).changes).toEqual([])
    expect(after.changesSince(cursor)?.map((c) => [c.id, c.op])).toEqual([
      ['a', 'upsert'],
      ['b', 'remove'],
    ])
  })

  it('onAppended fires for commit and reconcile, never for empty batches, and unsubscribes', () => {
    const ledger = makeLedger()
    const seen: string[][] = []
    const off = ledger.onAppended((changes) => seen.push(changes.map((c) => `${c.id}:${c.op}`)))
    commit(ledger, [issueSpec('a', 1)])
    commit(ledger, [issueSpec('a', 1)]) // fully deduped -> no event
    ledger.reconcile('issue', [])
    expect(seen).toEqual([['a:upsert'], ['a:remove']])
    off()
    commit(ledger, [issueSpec('a', 2)])
    expect(seen).toHaveLength(2)
  })
})

// commit() atomicity over a REAL sqlite database: the entity write and the
// change append share ONE transaction span. The injected transact is the
// nesting-safe runtime `transaction()` helper — the exact wiring composition
// will use — because appendChanges itself runs inside transaction() and only
// the helper's savepoint nesting lets the two compose (a hand-rolled raw
// `BEGIN IMMEDIATE` around it would make the inner BEGIN throw).
describe('Ledger commit atomicity (sqlite)', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  function makeSqliteFixture() {
    const db = createTestSyncDatabase()
    db.exec('CREATE TABLE issues (id TEXT PRIMARY KEY, title TEXT)')
    const repo = new SyncRepository(db)
    const transact = <T>(fn: () => T): T => transaction(db, fn)
    const insertIssue = (id: string, title: string) =>
      db.prepare('INSERT INTO issues (id, title) VALUES (?, ?)').run(id, title)
    const issueRows = () =>
      (db.prepare('SELECT id, title FROM issues ORDER BY id').all() as {
        id: string
        title: string
      }[]) ?? []
    return { db, repo, transact, insertIssue, issueRows }
  }

  it('write() throwing rolls back: no entity row, no change rows, baseline untouched', () => {
    const f = makeSqliteFixture()
    const ledger = new Ledger({ repo: f.repo, now: Date.now, transact: f.transact })
    expect(() =>
      ledger.commit({
        write: () => {
          f.insertIssue('a', 't1')
          throw new Error('write boom')
        },
        changes: () => [issueSpec('a', 1)],
      }),
    ).toThrow('write boom')
    expect(f.issueRows()).toEqual([])
    expect(f.repo.maxChangeSeq()).toBe(0)
    // Baseline untouched: the same upsert still counts as first sight.
    const ok = ledger.commit({
      write: () => f.insertIssue('a', 't1'),
      changes: () => [issueSpec('a', 1)],
    })
    expect(ok.changes.map((c) => c.op)).toEqual(['upsert'])
    expect(f.issueRows()).toEqual([{ id: 'a', title: 't1' }])
  })

  it('changes() throwing rolls back the entity write too', () => {
    const f = makeSqliteFixture()
    const ledger = new Ledger({ repo: f.repo, now: Date.now, transact: f.transact })
    expect(() =>
      ledger.commit({
        write: () => f.insertIssue('a', 't1'),
        changes: () => {
          throw new Error('spec boom')
        },
      }),
    ).toThrow('spec boom')
    expect(f.issueRows()).toEqual([])
    expect(f.repo.maxChangeSeq()).toBe(0)
  })

  it('append throwing rolls back the entity write and leaves the baseline untouched', () => {
    const f = makeSqliteFixture()
    let failNext = true
    const repo = new Proxy(f.repo, {
      get(target, prop, receiver) {
        if (prop === 'appendChanges' && failNext) {
          return () => {
            failNext = false
            throw new Error('append boom')
          }
        }
        const value = Reflect.get(target, prop, receiver)
        return typeof value === 'function' ? value.bind(target) : value
      },
    })
    const ledger = new Ledger({ repo, now: Date.now, transact: f.transact })
    expect(() =>
      ledger.commit({
        write: () => f.insertIssue('a', 't1'),
        changes: () => [issueSpec('a', 1)],
      }),
    ).toThrow('append boom')
    expect(f.issueRows()).toEqual([]) // entity write rolled back with the append
    expect(f.repo.maxChangeSeq()).toBe(0)
    // Baseline untouched: retrying appends the change as first sight.
    const retry = ledger.commit({
      write: () => f.insertIssue('a', 't1'),
      changes: () => [issueSpec('a', 1)],
    })
    expect(retry.changes.map((c) => c.op)).toEqual(['upsert'])
    expect(f.issueRows()).toEqual([{ id: 'a', title: 't1' }])
  })

  it('a throwing onAppended listener cannot break the committer', () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    const f = makeSqliteFixture()
    const ledger = new Ledger({ repo: f.repo, now: Date.now, transact: f.transact })
    const seen: number[] = []
    ledger.onAppended(() => {
      throw new Error('listener boom')
    })
    ledger.onAppended((changes) => seen.push(changes.length)) // later listeners still run
    const out = ledger.commit({
      write: () => f.insertIssue('a', 't1'),
      changes: () => [issueSpec('a', 1)],
    })
    expect(out.changes).toHaveLength(1)
    expect(f.issueRows()).toEqual([{ id: 'a', title: 't1' }])
    expect(seen).toEqual([1])
    expect(errors).toHaveBeenCalledOnce()
  })

  it('returns the appended changes with contiguous seqs matching the durable log', () => {
    const f = makeSqliteFixture()
    const ledger = new Ledger({ repo: f.repo, now: Date.now, transact: f.transact })
    commit(ledger, [issueSpec('z', 1)]) // seq 1
    const out = ledger.commit({
      write: () => {
        f.insertIssue('a', 't1')
        f.insertIssue('b', 't1')
      },
      changes: () => [issueSpec('a', 1), issueSpec('b', 1), removeSpec('z')],
    })
    expect(out.changes.map((c) => [c.seq, c.id, c.op])).toEqual([
      [2, 'a', 'upsert'],
      [3, 'b', 'upsert'],
      [4, 'z', 'remove'],
    ])
    expect(ledger.cursor()).toBe(4)
    expect(ledger.changesSince(1)?.map((c) => c.seq)).toEqual([2, 3, 4])
  })
})

function makeLedgerForReviewTests(opts: { pruneThrows?: boolean } = {}) {
  const inner = createTestSyncRepository()
  const repo = opts.pruneThrows
    ? new Proxy(inner, {
        get(target, prop, receiver) {
          if (prop === 'planChangePrune') {
            return () => {
              throw new Error('prune boom')
            }
          }
          const v = Reflect.get(target, prop, receiver)
          return typeof v === 'function' ? v.bind(target) : v
        },
      })
    : inner
  const ledger = new Ledger({ repo, now: Date.now, transact: passthrough })
  return { ledger, repo }
}

describe('Codex review-round hardening (#253)', () => {
  it('rejects an async write(): nothing appended, baseline untouched', () => {
    const { ledger, repo } = makeLedgerForReviewTests()
    expect(() =>
      ledger.commit({
        write: () => Promise.resolve('late'),
        changes: () => [{ entity: 'issue', id: 'i1', op: 'upsert', value: { id: 'i1' } }],
      }),
    ).toThrow(/thenable/)
    expect(repo.maxChangeSeq()).toBe(0)
    const after = ledger.commit({
      write: () => 'ok',
      changes: () => [{ entity: 'issue', id: 'i1', op: 'upsert', value: { id: 'i1' } }],
    })
    expect(after.changes).toHaveLength(1) // baseline never saw the rejected batch
  })

  it('changesSince pages past the repository read limit instead of silently truncating', () => {
    const { ledger, repo } = makeLedgerForReviewTests()
    const batch = (start: number, n: number) =>
      Array.from({ length: n }, (_, i) => ({
        entity: 'issue' as const,
        entityId: `i${start + i}`,
        op: 'upsert' as const,
        payload: JSON.stringify({ id: `i${start + i}` }),
      }))
    // 10_050 rows > the 10_000-row repo read limit, appended in chunks.
    for (let start = 0; start < 10_050; start += 2_010) {
      repo.appendChanges(batch(start, 2_010), Date.now())
    }
    const changes = ledger.changesSince(0)
    expect(changes).not.toBeNull()
    expect(changes).toHaveLength(10_050)
    expect(changes?.at(-1)?.seq).toBe(ledger.cursor())
  })

  it('returns null (snapshot fallback) on a malformed JSON payload', () => {
    const { ledger, repo } = makeLedgerForReviewTests()
    repo.appendChanges(
      [{ entity: 'issue', entityId: 'ix', op: 'upsert', payload: '{not json' }],
      Date.now(),
    )
    expect(ledger.changesSince(0)).toBeNull()
  })

  it('a prune failure degrades to a logged error: commit still returns changes and notifies', () => {
    const { ledger } = makeLedgerForReviewTests({ pruneThrows: true })
    const seen: number[] = []
    ledger.onAppended((c) => seen.push(c.length))
    // Cross the retention cadence (64 batches) with a throwing prune.
    let lastLen = 0
    for (let i = 0; i < 70; i++) {
      const { changes } = ledger.commit({
        write: () => i,
        changes: () => [
          { entity: 'issue', id: `p${i}`, op: 'upsert', value: { id: `p${i}`, v: i } },
        ],
      })
      lastLen = changes.length
    }
    expect(lastLen).toBe(1)
    expect(seen).toHaveLength(70)
  })
})
