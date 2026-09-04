/**
 * GOLDEN PINS FOR THE SYNC REPOSITORY, written for its drizzle conversion
 * (POD-3416, spec §6 rules 27a/27b/34a).
 *
 * WHY A NEW FILE RATHER THAN TRUSTING THE LANE. The 811 tests this package
 * already runs exercise this repository through the Ledger and the outbox, and
 * they were green against the conversion on the first run. That is exactly the
 * shape the epic keeps being caught by: a suite that drives the COMMON value
 * cannot tell the two worlds apart. A census of the 21 public methods against
 * the existing suites found `resetQueuedAttempts` with no test at all, and
 * `recordAppliedMutation`, `pruneAppliedMutations`, `queuedMessageCounts`,
 * `deleteQueuedMessage`, `bumpQueuedAttempts`, `deleteQueuedMessagesForSession`,
 * `listParkedUpstreamMutations` and `latestChangeStatesGeneration` reached from
 * one file each.
 *
 * SO EVERY METHOD IS PINNED HERE, and the arms chosen are the ones a conversion
 * can silently move: the value a column DEFAULT supplies (spec rule 43), the
 * shape of a projection (rule 39), the ordering inside one append batch, and the
 * empty-table answers, which are where an aggregate's `null` and an absent row
 * stop looking alike.
 */

import type { SessionId } from '@podium/model'
import { asMutationId } from '@podium/model'
import type { SqlDatabase } from '@podium/runtime/sqlite'
import { beforeEach, describe, expect, it } from 'vitest'
import type { ChangeLogWriteRow } from '../../authority/change-lifecycle'
import { SyncRepository } from './sync-repository'
import { createTestSyncDatabase, createTestSyncQueries, testSyncServerTables } from './test-support'

const session = (id: string): SessionId => id as SessionId

let db: SqlDatabase
let repo: SyncRepository

beforeEach(() => {
  db = createTestSyncDatabase()
  repo = new SyncRepository(createTestSyncQueries(db), testSyncServerTables)
})

/** Read straight off the fixture connection, so an assertion about what was
 *  STORED cannot be satisfied by the repository agreeing with itself. */
const stored = (sql: string, ...params: (string | number)[]): unknown[] =>
  db.prepare(sql).all(...params)

const change = (
  entity: string,
  entityId: string,
  op: 'upsert' | 'remove',
  payload: string | null,
): ChangeLogWriteRow => ({ entity, entityId, op, payload }) as ChangeLogWriteRow

/**
 * A repository over a connection that RECORDS the statements it is handed.
 *
 * Two of the properties below cannot be asserted on a returned value, and
 * finding that out is the reason this exists rather than a nicer-looking test:
 * a rule-39 widening was mutated into `changesSince` and every assertion in this
 * file stayed green, because the mapper builds an explicit object and the extra
 * column is read, returned and thrown away. That is rule 39's own argument for
 * why no test catches it — so the assertion has to be on the STATEMENT.
 */
const recordingRepo = (): { repo: SyncRepository; sql: () => string[] } => {
  const recorded: string[] = []
  const connection = createTestSyncDatabase()
  const realPrepare = connection.prepare.bind(connection)
  ;(connection as unknown as { prepare: (s: string) => unknown }).prepare = (s: string) => {
    recorded.push(s.replace(/\s+/g, ' ').trim())
    return realPrepare(s)
  }
  return {
    repo: new SyncRepository(createTestSyncQueries(connection), testSyncServerTables),
    sql: () => recorded,
  }
}

describe('the change log', () => {
  it('assigns contiguous seqs ACROSS the 100-row chunk boundary', () => {
    // The chunking is the reason `lastInsertRowid` is read at all: each chunk is
    // one statement, and the seqs of the rows before the last are DERIVED from
    // it. A conversion that lost the run result would still return an array.
    const rows = Array.from({ length: 250 }, (_, i) => change('issue', `i${i}`, 'upsert', '{}'))
    expect(repo.appendChanges(rows, 7)).toEqual(Array.from({ length: 250 }, (_, i) => i + 1))
    expect(stored('SELECT COUNT(*) AS n FROM changes')).toEqual([{ n: 250 }])
  })

  it('stores the provenance triple as NULL, which is what the omission stored', () => {
    // Spec rule 43 in the direction that is SAFE here and must stay safe: three
    // nullable columns with no DEFAULT clause, which the original INSERT omitted
    // and the builder binds an explicit null for.
    repo.appendChanges([change('issue', 'i1', 'upsert', '{"a":1}')], 11)
    expect(
      stored(
        'SELECT seq, entity, entity_id, op, payload, event_time, origin_id, causation_id, mutation_id FROM changes',
      ),
    ).toEqual([
      {
        seq: 1,
        entity: 'issue',
        entity_id: 'i1',
        op: 'upsert',
        payload: '{"a":1}',
        event_time: 11,
        origin_id: null,
        causation_id: null,
        mutation_id: null,
      },
    ])
  })

  it('reads back exactly the five columns changesSince projects', () => {
    repo.appendChanges([change('issue', 'i1', 'upsert', '{"a":1}')], 11)
    const [row] = repo.changesSince(0)
    // The KEY SET, not just the values: a widened projection (rule 39) shows up
    // here and nowhere else, because every other assertion reads named fields.
    expect(Object.keys(row as object).sort()).toEqual([
      'entity',
      'entityId',
      'op',
      'payload',
      'seq',
    ])
    expect(row).toEqual({
      seq: 1,
      entity: 'issue',
      entityId: 'i1',
      op: 'upsert',
      payload: '{"a":1}',
    })
  })

  it('honours the cursor, the seq order and the limit', () => {
    repo.appendChanges(
      [
        change('issue', 'i1', 'upsert', '1'),
        change('issue', 'i2', 'upsert', '2'),
        change('issue', 'i3', 'upsert', '3'),
      ],
      1,
    )
    expect(repo.changesSince(1).map((r) => r.seq)).toEqual([2, 3])
    expect(repo.changesSince(0, 2).map((r) => r.seq)).toEqual([1, 2])
    expect(repo.changesSince(99)).toEqual([])
  })

  it('leaves NOTHING behind when a later chunk of one append fails', () => {
    // THE SPAN `appendChanges` OPENS FOR ITSELF, which is a different property
    // from the caller's span in `store-queries.test.ts` and is not reached by it:
    // a repository whose `transact` merely called through would still roll back
    // inside a caller's transaction, and would leave the first 100 rows behind
    // when nobody had opened one. The batch is 100 rows per statement, so a bad
    // row at 150 fails the SECOND chunk after the first has already been written.
    const rows = Array.from({ length: 200 }, (_, i) => change('issue', `i${i}`, 'upsert', '{}'))
    rows[150] = { entity: null, entityId: 'bad', op: 'upsert', payload: '{}' } as never
    expect(() => repo.appendChanges(rows, 1)).toThrow()
    expect(stored('SELECT COUNT(*) AS n FROM changes')).toEqual([{ n: 0 }])
    expect(stored('SELECT COUNT(*) AS n FROM change_latest')).toEqual([{ n: 0 }])
  })

  it('carries a `remove` through with a null payload', () => {
    repo.appendChanges([change('issue', 'i1', 'remove', null)], 3)
    expect(repo.changesSince(0)).toEqual([
      { seq: 1, entity: 'issue', entityId: 'i1', op: 'remove', payload: null },
    ])
  })
})

describe('the statements themselves', () => {
  it('projects exactly the columns each read needs, and no more [rule 39]', () => {
    // THE WIDENING RULE 39 FORBIDS IS INVISIBLE DOWNSTREAM, so it is pinned here
    // on the emitted SELECT list. The counts are the ones the hand-written
    // statements named: five of nine on `changes`, four of four on
    // `change_latest`, eleven of thirteen on `queued_messages`, three of five on
    // `upstream_outbox`.
    const { repo, sql } = recordingRepo()
    repo.changesSince(0)
    repo.latestChangeStates()
    repo.listQueuedMessages(session('s1'))
    repo.listParkedUpstreamMutations()
    const selects = sql().filter((s) => s.startsWith('select'))
    const projection = (from: string): string[] => {
      const statement = selects.find((s) => s.includes(`from "${from}"`)) ?? ''
      return (statement.slice(0, statement.indexOf(' from ')).match(/"[a-z_]+"/g) ?? []).map((c) =>
        c.replaceAll('"', ''),
      )
    }
    expect(projection('changes')).toEqual(['seq', 'entity', 'entity_id', 'op', 'payload'])
    expect(projection('change_latest')).toEqual(['seq', 'entity', 'entity_id', 'payload'])
    expect(projection('queued_messages')).toEqual([
      'id',
      'text',
      'attempts',
      'input_origin',
      'principal_kind',
      'principal_ref',
      'delegation_ref',
      'actor_kind',
      'actor_id',
      'on_behalf_of',
      'source_message_id',
    ])
    expect(projection('upstream_outbox')).toEqual(['mutation_id', 'proc', 'queued_at'])
  })

  it('keeps the rowid tiebreak on both FIFO reads', () => {
    // `queued_at` and `queued_at` again is a real tie, and the engine's own
    // answer for it is not a promise — it is whatever the index the planner
    // picked happens to yield. The original statements said `ORDER BY … , rowid
    // ASC` and the conversion must keep saying it. Asserted on the statement
    // because a fixture cannot produce a tie the engine orders differently.
    const { repo, sql } = recordingRepo()
    repo.listQueuedMessages(session('s1'))
    repo.listParkedUpstreamMutations()
    const ordered = sql().filter((s) => s.includes('order by'))
    expect(ordered).toHaveLength(2)
    for (const statement of ordered) expect(statement).toMatch(/, rowid asc$/)
  })

  it('reads the age threshold through the changes_event_time index', () => {
    // The one `sql` fragment in a FROM clause, and the only thing that keeps the
    // prune's age scan off a table scan. Dropping it changes no answer, so no
    // value assertion can see it.
    const { repo, sql } = recordingRepo()
    repo.planChangePrune({ keepRows: 1, maxAgeMs: 1, now: 100 })
    expect(sql().some((s) => s.includes('indexed by "changes_event_time"'))).toBe(true)
  })
})

describe('the head and tail of the sequence', () => {
  it('answers 0 and null on a log that has never been written', () => {
    // The two empty cases are DIFFERENT mechanisms and they are the ones a
    // conversion can swap: `maxChangeSeq` has no `sqlite_sequence` ROW to read,
    // while `minChangeSeq` gets one row carrying NULL out of the aggregate.
    expect(repo.maxChangeSeq()).toBe(0)
    expect(repo.minChangeSeq()).toBeNull()
  })

  it('keeps the high-water mark after the rows behind it are pruned', () => {
    repo.appendChanges(
      Array.from({ length: 5 }, (_, i) => change('issue', `i${i}`, 'upsert', '{}')),
      1,
    )
    expect(repo.pruneChangeBatch({ thresholdSeq: 3 })).toBe(3)
    expect(repo.maxChangeSeq()).toBe(5)
    expect(repo.minChangeSeq()).toBe(4)
  })
})

describe('retention', () => {
  const append = (n: number, eventTime: number): void => {
    repo.appendChanges(
      Array.from({ length: n }, (_, i) => change('issue', `${eventTime}-${i}`, 'upsert', '{}')),
      eventTime,
    )
  }

  it('takes the ROW budget when it deletes more', () => {
    append(10, 1_000)
    expect(repo.planChangePrune({ keepRows: 4, maxAgeMs: 10_000, now: 5_000 })).toEqual({
      thresholdSeq: 6,
    })
  })

  it('takes the AGE budget when it deletes more', () => {
    // The arm that reads through the `changes_event_time` index — the one whose
    // FROM clause is the conversion's one `sql` fragment.
    append(3, 1_000)
    append(3, 9_000)
    expect(repo.planChangePrune({ keepRows: 100, maxAgeMs: 1_000, now: 5_000 })).toEqual({
      thresholdSeq: 3,
    })
  })

  it('deletes nothing at or below a zero threshold', () => {
    append(3, 1_000)
    expect(repo.pruneChangeBatch({ thresholdSeq: 0 })).toBe(0)
    expect(repo.maxChangeSeq()).toBe(3)
  })

  it('bounds one delete unit by its batch size and refuses a bad one', () => {
    append(10, 1_000)
    expect(repo.pruneChangeBatch({ thresholdSeq: 10 }, 4)).toBe(4)
    expect(repo.minChangeSeq()).toBe(5)
    expect(() => repo.pruneChangeBatch({ thresholdSeq: 10 }, 0)).toThrow(RangeError)
  })

  it('touches `changes` ONLY — the installed world survives a full prune', () => {
    append(3, 1_000)
    expect(repo.pruneChangeBatch({ thresholdSeq: 3 })).toBe(3)
    expect(repo.latestChangeStates()).toHaveLength(3)
  })
})

describe('the installed world', () => {
  it('keeps LOG order inside one batch, so a later remove wins over an earlier upsert', () => {
    // The reason `applyLatestChangeStates` is row-by-row rather than two bulk
    // statements: grouped by op, the upsert would be applied last and the entity
    // would stay installed.
    repo.appendChanges(
      [change('issue', 'i1', 'upsert', '{"v":1}'), change('issue', 'i1', 'remove', null)],
      1,
    )
    expect(repo.latestChangeStates()).toEqual([])
  })

  it('takes the LAST upsert of one entity in a batch', () => {
    repo.appendChanges(
      [change('issue', 'i1', 'upsert', '{"v":1}'), change('issue', 'i1', 'upsert', '{"v":2}')],
      1,
    )
    expect(repo.latestChangeStates()).toEqual([
      { seq: 2, entity: 'issue', entityId: 'i1', op: 'upsert', payload: '{"v":2}' },
    ])
  })

  it('treats a payload-less upsert as "not installed"', () => {
    repo.appendChanges([change('issue', 'i1', 'upsert', '{}')], 1)
    repo.appendChanges([change('issue', 'i1', 'upsert', null)], 2)
    expect(repo.latestChangeStates()).toEqual([])
    expect(stored('SELECT COUNT(*) AS n FROM change_latest')).toEqual([{ n: 0 }])
  })

  it('returns the world in seq order', () => {
    repo.appendChanges(
      [change('issue', 'i1', 'upsert', '1'), change('issue', 'i2', 'upsert', '2')],
      1,
    )
    repo.appendChanges([change('issue', 'i1', 'upsert', '3')], 2)
    expect(repo.latestChangeStates().map((r) => [r.entityId, r.seq])).toEqual([
      ['i2', 2],
      ['i1', 3],
    ])
  })

  it('bumps the generation on append and NOT on prune', () => {
    const before = repo.latestChangeStatesGeneration()
    repo.appendChanges([change('issue', 'i1', 'upsert', '{}')], 1)
    const afterAppend = repo.latestChangeStatesGeneration()
    expect(afterAppend).toBeGreaterThan(before)
    repo.pruneChangeBatch({ thresholdSeq: 1 })
    expect(repo.latestChangeStatesGeneration()).toBe(afterAppend)
  })
})

describe('the applied-mutation receipts', () => {
  const id = asMutationId('mut-1')

  it('is undefined before the first record and the stored result after', () => {
    expect(repo.getAppliedMutation(id)).toBeUndefined()
    repo.recordAppliedMutation(id, 'sendText', '{"ok":true}', 100)
    expect(repo.getAppliedMutation(id)).toBe('{"ok":true}')
  })

  it('IGNORES a replay rather than overwriting the first result', () => {
    // The `INSERT OR IGNORE` -> `onConflictDoNothing()` arm. The happy path never
    // walks it, and an upsert-shaped conversion would pass every other assertion
    // in this file.
    repo.recordAppliedMutation(id, 'sendText', 'first', 100)
    repo.recordAppliedMutation(id, 'sendText', 'second', 200)
    expect(repo.getAppliedMutation(id)).toBe('first')
    expect(stored('SELECT COUNT(*) AS n FROM applied_mutations')).toEqual([{ n: 1 }])
  })

  it('prunes strictly by age and leaves the receipts inside the horizon', () => {
    repo.recordAppliedMutation(asMutationId('old'), 'p', 'r', 100)
    repo.recordAppliedMutation(asMutationId('edge'), 'p', 'r', 500)
    repo.recordAppliedMutation(asMutationId('new'), 'p', 'r', 900)
    repo.pruneAppliedMutations({ maxAgeMs: 500, now: 1_000 })
    expect(stored('SELECT mutation_id FROM applied_mutations ORDER BY mutation_id')).toEqual([
      { mutation_id: 'edge' },
      { mutation_id: 'new' },
    ])
  })
})

describe('the session inbox', () => {
  const enqueue = (id: string, sessionId: string, queuedAt: number): boolean =>
    repo.enqueueMessage({ id, sessionId: session(sessionId), text: `t-${id}`, queuedAt })

  it('supplies the column DEFAULTS the original INSERT omitted or filled', () => {
    // SPEC RULE 43'S SITE. `attempts` is the one column the hand-written INSERT
    // omitted, and it is NOT NULL with DEFAULT 0 — so a conversion that bound an
    // explicit null would throw, and one that bound the wrong value would store
    // it silently. Read off the connection, not through the mapper.
    expect(enqueue('m1', 's1', 10)).toBe(true)
    expect(
      stored(
        'SELECT attempts, input_origin, principal_kind, principal_ref, delegation_ref, actor_kind, actor_id, on_behalf_of, source_message_id FROM queued_messages',
      ),
    ).toEqual([
      {
        attempts: 0,
        input_origin: 'unknown',
        principal_kind: 'system',
        principal_ref: 'legacy-session-inbox',
        delegation_ref: null,
        actor_kind: 'system',
        actor_id: 'legacy-session-inbox',
        on_behalf_of: null,
        source_message_id: null,
      },
    ])
  })

  it('round-trips every supplied attribution field', () => {
    repo.enqueueMessage({
      id: 'm1',
      sessionId: session('s1'),
      text: 'hello',
      queuedAt: 10,
      inputOrigin: 'human',
      principalKind: 'agent',
      principalRef: 'agent-7',
      delegationRef: 'del-1',
      actorKind: 'user',
      actorId: 'user-3',
      onBehalfOf: 'user-9',
      sourceMessageId: 'msg-2',
    })
    expect(repo.listQueuedMessages(session('s1'))).toEqual([
      {
        id: 'm1',
        text: 'hello',
        attempts: 0,
        inputOrigin: 'human',
        principalKind: 'agent',
        principalRef: 'agent-7',
        delegationRef: 'del-1',
        actorKind: 'user',
        actorId: 'user-3',
        onBehalfOf: 'user-9',
        sourceMessageId: 'msg-2',
      },
    ])
  })

  it('reports a replayed enqueue as false and stores one row', () => {
    expect(enqueue('m1', 's1', 10)).toBe(true)
    expect(enqueue('m1', 's1', 99)).toBe(false)
    expect(stored('SELECT queued_at FROM queued_messages')).toEqual([{ queued_at: 10 }])
  })

  it('lists one session FIFO, by queued_at then rowid', () => {
    enqueue('m2', 's1', 20)
    enqueue('m1', 's1', 10)
    // Same clock as m2: the tie is broken by insertion order, which is the
    // `rowid` half of the ORDER BY and the half a conversion drops silently.
    enqueue('m3', 's1', 20)
    enqueue('other', 's2', 1)
    expect(repo.listQueuedMessages(session('s1')).map((m) => m.id)).toEqual(['m1', 'm2', 'm3'])
  })

  it('counts per session', () => {
    enqueue('m1', 's1', 1)
    enqueue('m2', 's1', 2)
    enqueue('m3', 's2', 3)
    expect(repo.queuedMessageCounts()).toEqual(
      new Map([
        [session('s1'), 2],
        [session('s2'), 1],
      ]),
    )
  })

  it('bumps, resets and deletes one message without touching its neighbour', () => {
    enqueue('m1', 's1', 1)
    enqueue('m2', 's1', 2)
    repo.bumpQueuedAttempts('m1')
    repo.bumpQueuedAttempts('m1')
    expect(repo.listQueuedMessages(session('s1')).map((m) => m.attempts)).toEqual([2, 0])
    repo.resetQueuedAttempts('m1')
    expect(repo.listQueuedMessages(session('s1')).map((m) => m.attempts)).toEqual([0, 0])
    repo.deleteQueuedMessage('m1')
    expect(repo.listQueuedMessages(session('s1')).map((m) => m.id)).toEqual(['m2'])
  })

  it('drops one session queue and leaves the others', () => {
    enqueue('m1', 's1', 1)
    enqueue('m2', 's2', 2)
    repo.deleteQueuedMessagesForSession(session('s1'))
    expect(repo.listQueuedMessages(session('s1'))).toEqual([])
    expect(repo.listQueuedMessages(session('s2')).map((m) => m.id)).toEqual(['m2'])
  })
})

describe('the parked upstream outbox', () => {
  it('reports the parked rows oldest first and reads none of the payload', () => {
    db.prepare(
      'INSERT INTO upstream_outbox (mutation_id, proc, input, queued_at) VALUES (?, ?, ?, ?)',
    ).run('b', 'issues.update', '{"secret":1}', 20)
    db.prepare(
      'INSERT INTO upstream_outbox (mutation_id, proc, input, queued_at) VALUES (?, ?, ?, ?)',
    ).run('a', 'issues.create', '{"secret":2}', 10)
    const parked = repo.listParkedUpstreamMutations()
    expect(parked).toEqual([
      { mutationId: 'a', proc: 'issues.create', queuedAt: 10 },
      { mutationId: 'b', proc: 'issues.update', queuedAt: 20 },
    ])
    // Three of the table's five columns, named [rule 39] — `input` is the parked
    // payload this report deliberately does not read.
    expect(Object.keys(parked[0] as object).sort()).toEqual(['mutationId', 'proc', 'queuedAt'])
  })

  it('is empty when nothing was ever parked', () => {
    expect(repo.listParkedUpstreamMutations()).toEqual([])
  })
})

describe('the feed identity', () => {
  it('is null before it is minted', () => {
    expect(repo.readFeedIdentity()).toBeNull()
  })

  it('REPLACES on a bump rather than appending a second generation', () => {
    repo.writeFeedIdentity({ feedId: 'feed-1', epoch: 'epoch-1' }, 100)
    repo.writeFeedIdentity({ feedId: 'feed-1', epoch: 'epoch-2' }, 200)
    expect(repo.readFeedIdentity()).toEqual({ feedId: 'feed-1', epoch: 'epoch-2' })
    expect(stored('SELECT singleton, minted_at FROM feed_identity')).toEqual([
      { singleton: 1, minted_at: 200 },
    ])
  })
})
