/**
 * THE SYNC REPOSITORY'S SUITES, ON ANY ENGINE [POD-6989, POD-6958 design 2.10].
 *
 * The golden pins (POD-3416) and the per-workspace feed tests (POD-7021) were written
 * against this package's in-memory SQLite fixture. They are the oracle for the
 * repository on every engine, so their bodies live here and take a
 * {@link SyncRepositoryFixture}: this package's test files run them on its bare
 * fixture (`../sync-repository-golden.test.ts`, `../tenant-feed.test.ts`), and the
 * server's store shard runs them on the store's own engine, SQLite on the store lane
 * and Postgres on `server-store-pg` (`apps/server/src/store/sync-repository.engines.test.ts`).
 *
 * THE ENGINES AGREE EXCEPT WHERE A TEST SAYS SO. Two differences are by design, and
 * each assertion that meets one names it:
 *
 *  - A provisioned store (the server's, on both engines) creates each workspace's
 *    `sync_feed` row before its first write (contract C4: Postgres locks that row
 *    first in every write). The bare fixture has no provisioning, so a workspace's
 *    first append or identity write creates the row. A test of the row's absence
 *    reads {@link SyncRepositoryFixture.provisioned}.
 *  - The statement texts: SQLite keeps its `INDEXED BY` hint, Postgres has none
 *    ({@link SyncRepositoryFixture.engine}).
 *
 * Raw SQL in these suites is written once and is valid on both engines: no
 * placeholders, literal values only.
 */

import { asMutationId, type MutationId, type SessionId } from '@podium/model'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ChangeLogWriteRow } from '../../../authority/change-lifecycle'
import type { SyncServerTables } from '../server-tables'
import type { SyncQueries } from '../store-queries'
import { SyncRepository } from '../sync-repository'

/** The workspace a suite's repository belongs to unless a test names another. */
export const SUITE_WORKSPACE_ID = 'local'

/** One database and the sync repositories over it. */
export interface SyncRepositoryFixture {
  /** The engine the database runs on. */
  readonly engine: 'sqlite' | 'pg'
  /**
   * Whether every workspace's `sync_feed` row exists before its first write, at head 0
   * and floor 1, as a store's provisioning makes it (contract C4). False for the bare
   * fixture, where the first append or identity write creates the row.
   */
  readonly provisioned: boolean
  /** What a repository is constructed with beside its queries. */
  readonly serverTables: SyncServerTables
  /**
   * What a write of one workspace inside another's transaction is refused with. The
   * bare fixture's runner joins any transaction and the statement's workspace fill
   * refuses it (`CrossWorkspaceStatementError`); a store's executor refuses the join
   * itself, before any statement.
   */
  readonly crossWorkspaceRefusal: abstract new (
    ...args: never[]
  ) => Error
  /** One workspace's queries over the database ({@link SUITE_WORKSPACE_ID} when omitted). */
  queries(workspaceId?: string): SyncQueries
  /**
   * A repository of one workspace ({@link SUITE_WORKSPACE_ID} when omitted), its inbox
   * writes draining their change capture in their transaction as a store's do.
   */
  repository(workspaceId?: string): Promise<SyncRepository>
  /** The rows of one read straight off the database, not through the repository. */
  stored(text: string): Promise<Record<string, unknown>[]>
  /** One write straight to the database, outside any repository, in its own transaction. */
  seed(text: string): Promise<void>
  /** One write straight to the database, inside the transaction open around the call. */
  runInTransaction(text: string): Promise<void>
  /** The SQL of every statement the database runs during `fn`, whitespace folded. */
  record(fn: () => Promise<unknown>): Promise<string[]>
  close(): Promise<void>
}

/** Opens a fresh fixture: one per test. */
export type OpenSyncRepositoryFixture = () => Promise<SyncRepositoryFixture>

const session = (id: string): SessionId => id as SessionId

const change = (
  entity: string,
  entityId: string,
  op: 'upsert' | 'remove',
  payload: string | null,
): ChangeLogWriteRow => ({ entity, entityId, op, payload }) as ChangeLogWriteRow

/** A fresh fixture per test, closed after it. */
function eachFixture(open: OpenSyncRepositoryFixture): () => SyncRepositoryFixture {
  let current: SyncRepositoryFixture | undefined
  beforeEach(async () => {
    current = await open()
  })
  afterEach(async () => {
    await current?.close()
    current = undefined
  })
  return () => {
    if (current === undefined) throw new Error('no fixture outside a test')
    return current
  }
}

// ---------------------------------------------------------------------------
// The golden pins
// ---------------------------------------------------------------------------

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
 * `recordAppliedMutation`, `pruneAppliedMutationsBatch`, `queuedMessageCounts`,
 * `deleteQueuedMessage`, `bumpQueuedAttempts`, `deleteQueuedMessagesForSession`,
 * and `listParkedUpstreamMutations` reached from one file each.
 *
 * SO EVERY METHOD IS PINNED HERE, and the arms chosen are the ones a conversion
 * can silently move: the value a column DEFAULT supplies (spec rule 43), the
 * shape of a projection (rule 39), the ordering inside one append batch, and the
 * empty-table answers, which are where an aggregate's `null` and an absent row
 * stop looking alike.
 *
 * `stored` reads straight off the database, so an assertion about what was STORED
 * cannot be satisfied by the repository agreeing with itself.
 */
export function describeSyncRepositoryGolden(open: OpenSyncRepositoryFixture): void {
  const fixture = eachFixture(open)
  let repo: SyncRepository
  beforeEach(async () => {
    repo = await fixture().repository()
  })
  const stored = (text: string) => fixture().stored(text)

  describe('the change log', () => {
    it('assigns contiguous seqs ACROSS the 100-row chunk boundary', async () => {
      // The chunking is the reason `lastInsertRowid` is read at all: each chunk is
      // one statement, and the seqs of the rows before the last are DERIVED from
      // it. A conversion that lost the run result would still return an array.
      const rows = Array.from({ length: 250 }, (_, i) =>
        change('issueProjection', `i${i}`, 'upsert', '{}'),
      )
      expect(await repo.appendChanges(rows, 7)).toEqual(
        Array.from({ length: 250 }, (_, i) => i + 1),
      )
      expect(await stored('SELECT COUNT(*) AS n FROM changes')).toEqual([{ n: 250 }])
    })

    it('stores the provenance triple as NULL, which is what the omission stored', async () => {
      // Spec rule 43 in the direction that is SAFE here and must stay safe: three
      // nullable columns with no DEFAULT clause, which the original INSERT omitted
      // and the builder binds an explicit null for.
      await repo.appendChanges([change('issueProjection', 'i1', 'upsert', '{"a":1}')], 11)
      expect(
        await stored(
          'SELECT seq, entity, entity_id, op, payload, event_time, origin_id, causation_id, mutation_id FROM changes',
        ),
      ).toEqual([
        {
          seq: 1,
          entity: 'issueProjection',
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

    it('reads back the five base keys, and no provenance key for a NULL column', async () => {
      await repo.appendChanges([change('issueProjection', 'i1', 'upsert', '{"a":1}')], 11)
      const [row] = await repo.changesSince(0)
      // The KEY SET, not just the values: a NULL provenance column comes back as
      // an ABSENT key (POD-6272), never as `null` and never as `undefined` under
      // a present key, so a reader cannot tell the read from a row that never had one.
      expect(Object.keys(row as object).sort()).toEqual([
        'entity',
        'entityId',
        'op',
        'payload',
        'seq',
      ])
      expect(row).toEqual({
        seq: 1,
        entity: 'issueProjection',
        entityId: 'i1',
        op: 'upsert',
        payload: '{"a":1}',
      })
    })

    it('stores the provenance triple and reads it back on both range reads (POD-6272)', async () => {
      await repo.appendChanges(
        [
          {
            ...change('issueProjection', 'i1', 'upsert', '{"a":1}'),
            originId: 'peer-1',
            causationId: 'c-1',
            mutationId: asMutationId('m-1'),
          },
          {
            ...change('issueProjection', 'i2', 'upsert', '{"b":1}'),
            mutationId: asMutationId('m-2'),
          },
          change('issueProjection', 'i3', 'remove', null),
        ],
        11,
      )
      expect(
        await stored('SELECT seq, origin_id, causation_id, mutation_id FROM changes ORDER BY seq'),
      ).toEqual([
        { seq: 1, origin_id: 'peer-1', causation_id: 'c-1', mutation_id: 'm-1' },
        { seq: 2, origin_id: null, causation_id: null, mutation_id: 'm-2' },
        { seq: 3, origin_id: null, causation_id: null, mutation_id: null },
      ])
      const expected = [
        {
          seq: 1,
          entity: 'issueProjection',
          entityId: 'i1',
          op: 'upsert',
          payload: '{"a":1}',
          originId: 'peer-1',
          causationId: 'c-1',
          mutationId: 'm-1',
        },
        {
          seq: 2,
          entity: 'issueProjection',
          entityId: 'i2',
          op: 'upsert',
          payload: '{"b":1}',
          mutationId: 'm-2',
        },
        { seq: 3, entity: 'issueProjection', entityId: 'i3', op: 'remove', payload: null },
      ]
      expect(await repo.changesSince(0)).toEqual(expected)
      expect(await repo.changesInRange(0, 3, 10)).toEqual(expected)
    })

    it('binds provenance across the 100-row chunk boundary', async () => {
      // Eight parameters a row now: 100 rows is 800, under SQLite's 999.
      const rows = Array.from({ length: 150 }, (_, i) => ({
        ...change('issueProjection', `i${i}`, 'upsert', '{}'),
        mutationId: asMutationId(`m-${i}`),
      }))
      await repo.appendChanges(rows, 7)
      expect(
        await stored(
          'SELECT seq, mutation_id FROM changes WHERE seq IN (100, 101, 150) ORDER BY seq',
        ),
      ).toEqual([
        { seq: 100, mutation_id: 'm-99' },
        { seq: 101, mutation_id: 'm-100' },
        { seq: 150, mutation_id: 'm-149' },
      ])
    })

    it('honours the cursor, the seq order and the limit', async () => {
      await repo.appendChanges(
        [
          change('issueProjection', 'i1', 'upsert', '1'),
          change('issueProjection', 'i2', 'upsert', '2'),
          change('issueProjection', 'i3', 'upsert', '3'),
        ],
        1,
      )
      expect((await repo.changesSince(1)).map((r) => r.seq)).toEqual([2, 3])
      expect((await repo.changesSince(0, 2)).map((r) => r.seq)).toEqual([1, 2])
      expect(await repo.changesSince(99)).toEqual([])
      expect((await repo.changesInRange(0, 2, 10)).map((r) => r.seq)).toEqual([1, 2])
      expect((await repo.changesInRange(1, 3, 1)).map((r) => r.seq)).toEqual([2])
      expect(await repo.changesInRange(2, 2, 10)).toEqual([])
      // POD-7585: the same range by name only, for a replay of the access moves.
      expect(await repo.changeRefsInRange(0, 3, 2)).toEqual([
        { seq: 1, entity: 'issueProjection', entityId: 'i1' },
        { seq: 2, entity: 'issueProjection', entityId: 'i2' },
      ])
      expect(await repo.changeRefsInRange(2, 3, 10)).toEqual([
        { seq: 3, entity: 'issueProjection', entityId: 'i3' },
      ])
      expect(await repo.changeRefsInRange(3, 3, 10)).toEqual([])
    })

    it('leaves NOTHING behind when a later chunk of one append fails', async () => {
      // THE SPAN `appendChanges` OPENS FOR ITSELF, which is a different property
      // from the caller's span in `store-queries.test.ts` and is not reached by it:
      // a repository whose `transact` merely called through would still roll back
      // inside a caller's transaction, and would leave the first 100 rows behind
      // when nobody had opened one. The batch is 100 rows per statement, so a bad
      // row at 150 fails the SECOND chunk after the first has already been written.
      const rows = Array.from({ length: 200 }, (_, i) =>
        change('issueProjection', `i${i}`, 'upsert', '{}'),
      )
      rows[150] = { entity: null, entityId: 'bad', op: 'upsert', payload: '{}' } as never
      await expect(repo.appendChanges(rows, 1)).rejects.toThrow()
      expect(await stored('SELECT COUNT(*) AS n FROM changes')).toEqual([{ n: 0 }])
    })

    it('carries a `remove` through with a null payload', async () => {
      await repo.appendChanges([change('issueProjection', 'i1', 'remove', null)], 3)
      expect(await repo.changesSince(0)).toEqual([
        { seq: 1, entity: 'issueProjection', entityId: 'i1', op: 'remove', payload: null },
      ])
    })
  })

  describe('the statements themselves', () => {
    it('projects exactly the columns each read needs, and no more [rule 39]', async () => {
      // THE WIDENING RULE 39 FORBIDS IS INVISIBLE DOWNSTREAM, so it is pinned here
      // on the emitted SELECT list. The counts are the ones the hand-written
      // statements named: eight of nine on `changes` (POD-6272 added provenance),
      // sixteen of eighteen on `queued_messages`, three of six on `upstream_outbox`
      // (`queue_order` orders both and is no part of either answer, POD-7075).
      const sql = await fixture().record(async () => {
        await repo.changesSince(0)
        await repo.listQueuedMessages(session('s1'))
        await repo.listParkedUpstreamMutations()
      })
      const selects = sql.filter((s) => s.startsWith('select'))
      const projection = (from: string): string[] => {
        const statement = selects.find((s) => s.includes(`from "${from}"`)) ?? ''
        return (statement.slice(0, statement.indexOf(' from ')).match(/"[a-z_]+"/g) ?? []).map(
          (c) => c.replaceAll('"', ''),
        )
      }
      expect(projection('changes')).toEqual([
        'seq',
        'entity',
        'entity_id',
        'op',
        'payload',
        'origin_id',
        'causation_id',
        'mutation_id',
      ])
      expect(projection('queued_messages')).toEqual([
        'id',
        'text',
        'queued_at',
        'attempts',
        'delivery_owner',
        'input_origin',
        'principal_kind',
        'principal_ref',
        'delegation_ref',
        'actor_kind',
        'actor_id',
        'on_behalf_of',
        'source_message_id',
        'delivery',
        'attachments_json',
        'retract_requested_at',
      ])
      expect(projection('upstream_outbox')).toEqual(['mutation_id', 'proc', 'queued_at'])
    })

    it('orders both FIFO reads by their queue_order column alone, on both engines', async () => {
      // ONE RULE FOR BOTH ENGINES (POD-7075). The reads used to order by the clock
      // and break a tie by SQLite's rowid or, on Postgres, by the random primary
      // key. The order is now a column the enqueue numbers; neither the clock nor
      // any engine row order may come back as a tiebreak.
      const sql = await fixture().record(async () => {
        await repo.listQueuedMessages(session('s1'))
        await repo.listParkedUpstreamMutations()
      })
      const ordered = sql.filter((s) => s.startsWith('select') && s.includes('order by'))
      expect(ordered).toHaveLength(2)
      expect(ordered.find((s) => s.includes('"queued_messages"'))).toMatch(
        /order by "queued_messages"\."queue_order" asc$/,
      )
      expect(ordered.find((s) => s.includes('"upstream_outbox"'))).toMatch(
        /order by "upstream_outbox"\."queue_order" asc$/,
      )
    })

    it('reads the age threshold through the changes_event_time index', async () => {
      // The one `sql` fragment in a FROM clause, and the only thing that keeps the
      // prune's age scan off a table scan on SQLite. Dropping it changes no answer,
      // so no value assertion can see it. Postgres takes no hint: its planner picks
      // the index itself, which the Postgres query-plan audit proves (POD-6992).
      const sql = await fixture().record(async () => {
        await repo.planChangePrune({ keepRows: 1, maxAgeMs: 1, now: 100 })
      })
      const hinted = sql.some((s) => s.includes('indexed by "changes_event_time"'))
      expect(hinted).toBe(fixture().engine === 'sqlite')
    })
  })

  describe('the head and tail of the sequence', () => {
    it('answers 0 and null on a log that has never been written', async () => {
      // The two empty cases are DIFFERENT mechanisms and they are the ones a
      // conversion can swap: `maxChangeSeq` has no feed ROW to read (or a
      // provisioned one at head 0), while `minChangeSeq` reads a floor above the head.
      expect(await repo.maxChangeSeq()).toBe(0)
      expect(await repo.minChangeSeq()).toBeNull()
    })

    it('keeps the high-water mark after the rows behind it are pruned', async () => {
      await repo.appendChanges(
        Array.from({ length: 5 }, (_, i) => change('issueProjection', `i${i}`, 'upsert', '{}')),
        1,
      )
      expect(await repo.pruneChangeBatch({ thresholdSeq: 3 })).toBe(3)
      expect(await repo.maxChangeSeq()).toBe(5)
      expect(await repo.minChangeSeq()).toBe(4)
    })
  })

  describe('retention', () => {
    const append = async (n: number, eventTime: number): Promise<void> => {
      await repo.appendChanges(
        Array.from({ length: n }, (_, i) =>
          change('issueProjection', `${eventTime}-${i}`, 'upsert', '{}'),
        ),
        eventTime,
      )
    }

    it('takes the ROW budget when it deletes more', async () => {
      await append(10, 1_000)
      expect(await repo.planChangePrune({ keepRows: 4, maxAgeMs: 10_000, now: 5_000 })).toEqual({
        thresholdSeq: 6,
      })
    })

    it('never plans the head row, even when every row has aged out', async () => {
      // POD-7593: an emptied log advertises floor head + 1, which clients refuse.
      await append(3, 1_000)
      expect(await repo.planChangePrune({ keepRows: 0, maxAgeMs: 1, now: 5_000 })).toEqual({
        thresholdSeq: 2,
      })
    })

    it('takes the AGE budget when it deletes more', async () => {
      // The arm that reads through the `changes_event_time` index — the one whose
      // SQLite FROM clause is the conversion's one `sql` fragment.
      await append(3, 1_000)
      await append(3, 9_000)
      expect(await repo.planChangePrune({ keepRows: 100, maxAgeMs: 1_000, now: 5_000 })).toEqual({
        thresholdSeq: 3,
      })
    })

    it('deletes nothing at or below a zero threshold', async () => {
      await append(3, 1_000)
      expect(await repo.pruneChangeBatch({ thresholdSeq: 0 })).toBe(0)
      expect(await repo.maxChangeSeq()).toBe(3)
    })

    it('bounds one delete unit by its batch size and refuses a bad one', async () => {
      await append(10, 1_000)
      expect(await repo.pruneChangeBatch({ thresholdSeq: 10 }, 4)).toBe(4)
      expect(await repo.minChangeSeq()).toBe(5)
      await expect(repo.pruneChangeBatch({ thresholdSeq: 10 }, 0)).rejects.toThrow(RangeError)
    })
  })

  describe('the applied-mutation receipts', () => {
    const id = asMutationId('mut-1')

    it('is undefined before the first record and the stored result after', async () => {
      expect(await repo.getAppliedMutation(id)).toBeUndefined()
      await repo.recordAppliedMutation(id, 'sendText', '{"ok":true}', 100)
      expect(await repo.getAppliedMutation(id)).toBe('{"ok":true}')
    })

    it('a legacy lookup excludes receipts at or after the cutoff and prefers the scoped receipt', async () => {
      const scoped = asMutationId('scoped-1')
      await repo.recordAppliedMutation(id, 'sendText', 'legacy', 100)
      expect(await repo.getAppliedMutation(scoped, { mutationId: id, before: 101 })).toBe('legacy')
      expect(await repo.getAppliedMutation(scoped, { mutationId: id, before: 100 })).toBeUndefined()
      expect(await repo.getAppliedMutation(scoped, { mutationId: id, before: 99 })).toBeUndefined()
      await repo.recordAppliedMutation(scoped, 'sendText', 'scoped', 200)
      expect(await repo.getAppliedMutation(scoped, { mutationId: id, before: 101 })).toBe('scoped')
      expect(await repo.getAppliedMutation(id)).toBe('legacy')
    })

    it('IGNORES a replay rather than overwriting the first result', async () => {
      // The `INSERT OR IGNORE` -> `onConflictDoNothing()` arm. The happy path never
      // walks it, and an upsert-shaped conversion would pass every other assertion
      // in this file.
      await repo.recordAppliedMutation(id, 'sendText', 'first', 100)
      await repo.recordAppliedMutation(id, 'sendText', 'second', 200)
      expect(await repo.getAppliedMutation(id)).toBe('first')
      expect(await stored('SELECT COUNT(*) AS n FROM applied_mutations')).toEqual([{ n: 1 }])
    })

    it('prunes strictly by age and leaves the receipts inside the horizon', async () => {
      await repo.recordAppliedMutation(asMutationId('old'), 'p', 'r', 100)
      await repo.recordAppliedMutation(asMutationId('edge'), 'p', 'r', 500)
      await repo.recordAppliedMutation(asMutationId('new'), 'p', 'r', 900)
      expect(await repo.pruneAppliedMutationsBatch(500, 100)).toBe(1)
      expect(
        await stored('SELECT mutation_id FROM applied_mutations ORDER BY mutation_id'),
      ).toEqual([{ mutation_id: 'edge' }, { mutation_id: 'new' }])
    })

    it('prunes one batch of the oldest receipts and stops at the batch size (POD-7035)', async () => {
      for (const [id, at] of [
        ['c', 300],
        ['a', 100],
        ['d', 400],
        ['b', 200],
      ] as const) {
        await repo.recordAppliedMutation(asMutationId(id), 'p', 'r', at)
      }
      expect(await repo.pruneAppliedMutationsBatch(1_000, 2)).toBe(2)
      expect(
        await stored('SELECT mutation_id FROM applied_mutations ORDER BY mutation_id'),
      ).toEqual([{ mutation_id: 'c' }, { mutation_id: 'd' }])
      expect(await repo.pruneAppliedMutationsBatch(1_000, 2)).toBe(2)
      expect(await repo.pruneAppliedMutationsBatch(1_000, 2)).toBe(0)
    })

    it("expires one session's queued rows through a time and leaves later rows and other sessions (POD-7035)", async () => {
      const enqueueAt = async (id: string, sessionId: string, queuedAt: number) =>
        await repo.enqueueMessage({ id, sessionId: session(sessionId), text: id, queuedAt })
      await enqueueAt('q1', 's1', 100)
      await enqueueAt('q2', 's1', 200)
      await enqueueAt('q3', 's1', 300)
      await enqueueAt('q4', 's2', 100)
      expect(await repo.expireQueuedMessagesOfSession(session('s1'), 200)).toBe(2)
      expect(await stored('SELECT id FROM queued_messages ORDER BY id')).toEqual([
        { id: 'q3' },
        { id: 'q4' },
      ])
    })
  })

  describe('the session inbox', () => {
    const enqueue = async (id: string, sessionId: string, queuedAt: number): Promise<boolean> =>
      await repo.enqueueMessage({ id, sessionId: session(sessionId), text: `t-${id}`, queuedAt })

    it('supplies the column DEFAULTS the original INSERT omitted or filled', async () => {
      // SPEC RULE 43'S SITE. `attempts` is the one column the hand-written INSERT
      // omitted, and it is NOT NULL with DEFAULT 0 — so a conversion that bound an
      // explicit null would throw, and one that bound the wrong value would store
      // it silently. Read off the connection, not through the mapper.
      expect(await enqueue('m1', 's1', 10)).toBe(true)
      expect(
        await stored(
          'SELECT attempts, delivery_owner, input_origin, principal_kind, principal_ref, delegation_ref, actor_kind, actor_id, on_behalf_of, source_message_id FROM queued_messages',
        ),
      ).toEqual([
        {
          attempts: 0,
          delivery_owner: null,
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

    it('round-trips every supplied attribution field', async () => {
      await repo.enqueueMessage({
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
        delivery: 'interrupt',
        attachmentsJson: '[{"id":"a1"}]',
      })
      expect(await repo.listQueuedMessages(session('s1'))).toEqual([
        {
          id: 'm1',
          text: 'hello',
          queuedAt: 10,
          attempts: 0,
          deliveryOwner: null,
          inputOrigin: 'human',
          principalKind: 'agent',
          principalRef: 'agent-7',
          delegationRef: 'del-1',
          actorKind: 'user',
          actorId: 'user-3',
          onBehalfOf: 'user-9',
          sourceMessageId: 'msg-2',
          delivery: 'interrupt',
          attachmentsJson: '[{"id":"a1"}]',
          retractRequestedAt: null,
        },
      ])
    })

    it('defaults a row to when-ready with no files (POD-4795)', async () => {
      await enqueue('m1', 's1', 10)
      expect(await repo.listQueuedMessages(session('s1'))).toEqual([
        expect.objectContaining({ id: 'm1', delivery: 'when-ready', attachmentsJson: null }),
      ])
    })

    it('reports a replayed enqueue as false and stores one row', async () => {
      expect(await enqueue('m1', 's1', 10)).toBe(true)
      expect(await enqueue('m1', 's1', 99)).toBe(false)
      expect(await stored('SELECT queued_at FROM queued_messages')).toEqual([{ queued_at: 10 }])
    })

    it('lists one session in the order it was queued, whatever the clock says', async () => {
      // The queue order, not the clock: a clock can step back, and the inbox
      // stamps `queued_at` itself. Another session's rows take no number of s1's.
      await enqueue('m2', 's1', 20)
      await enqueue('m1', 's1', 10)
      await enqueue('other', 's2', 1)
      await enqueue('m3', 's1', 20)
      expect((await repo.listQueuedMessages(session('s1'))).map((m) => m.id)).toEqual([
        'm2',
        'm1',
        'm3',
      ])
    })

    it('delivers N messages queued within one millisecond in queue order', async () => {
      // THE GOLDEN CASE, THE SAME ON BOTH ENGINES (POD-7075). The ids sort against
      // the queue order, so a tiebreak by id (Postgres before) fails, and so would
      // any engine row order that is not the order of the writes.
      const ids = Array.from({ length: 12 }, (_, i) => `m-${String(99 - i)}`)
      for (const id of ids) await enqueue(id, 's1', 1_000)
      expect((await repo.listQueuedMessages(session('s1'))).map((m) => m.id)).toEqual(ids)
    })

    it('gives concurrent enqueues of one session distinct orders, after every row already there', async () => {
      // Under the workspace's write slot two writers are serialised, so no two
      // enqueues read the same maximum. Issued at once, the rows land in some
      // order, but each one after the row queued before them, and never in a tie.
      await enqueue('first', 's1', 1_000)
      const ids = Array.from({ length: 8 }, (_, i) => `c-${i}`)
      await Promise.all(ids.map((id) => enqueue(id, 's1', 1_000)))
      const orders = (await stored(
        "SELECT id, queue_order FROM queued_messages WHERE session_id = 's1' ORDER BY queue_order",
      )) as { id: string; queue_order: number }[]
      expect(orders.map((r) => Number(r.queue_order))).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9])
      expect(orders[0]?.id).toBe('first')
      expect(orders.map((r) => r.id).sort()).toEqual(['first', ...ids].sort())
    })

    it('numbers after the rows that stay when the head is delivered', async () => {
      await enqueue('m1', 's1', 1)
      await enqueue('m2', 's1', 1)
      await repo.deleteQueuedMessage('m1')
      await enqueue('m3', 's1', 1)
      expect((await repo.listQueuedMessages(session('s1'))).map((m) => m.id)).toEqual(['m2', 'm3'])
    })

    it('counts per session', async () => {
      await enqueue('m1', 's1', 1)
      await enqueue('m2', 's1', 2)
      await enqueue('m3', 's2', 3)
      expect(await repo.queuedMessageCounts()).toEqual(
        new Map([
          [session('s1'), 2],
          [session('s2'), 1],
        ]),
      )
    })

    it('bumps, resets and deletes one message without touching its neighbour', async () => {
      await enqueue('m1', 's1', 1)
      await enqueue('m2', 's1', 2)
      await repo.bumpQueuedAttempts('m1')
      await repo.bumpQueuedAttempts('m1')
      expect((await repo.listQueuedMessages(session('s1'))).map((m) => m.attempts)).toEqual([2, 0])
      await repo.resetQueuedAttempts('m1')
      expect((await repo.listQueuedMessages(session('s1'))).map((m) => m.attempts)).toEqual([0, 0])
      await repo.deleteQueuedMessage('m1')
      expect((await repo.listQueuedMessages(session('s1'))).map((m) => m.id)).toEqual(['m2'])
    })

    it('reserves, then releases a reservation back to the prior attempts, only on a reserved row (POD-4622)', async () => {
      await enqueue('m1', 's1', 1)
      await enqueue('m2', 's1', 2)
      const custody = async () =>
        (await repo.listQueuedMessages(session('s1'))).map((m) => [m.deliveryOwner, m.attempts])
      await repo.reserveQueuedDelivery('m1')
      expect(await custody()).toEqual([
        ['daemon', 1],
        [null, 0],
      ])
      await repo.releaseQueuedDelivery('m1', 0)
      expect(await custody()).toEqual([
        [null, 0],
        [null, 0],
      ])
      // Not reserved: the release writes nothing, whatever count it carries.
      await repo.bumpQueuedAttempts('m2')
      await repo.releaseQueuedDelivery('m2', 7)
      expect(await custody()).toEqual([
        [null, 0],
        [null, 1],
      ])
      // A reservation keeps a count above 1: the scalar maximum, not a reset.
      await repo.bumpQueuedAttempts('m2')
      await repo.reserveQueuedDelivery('m2')
      expect(await custody()).toEqual([
        [null, 0],
        ['daemon', 2],
      ])
    })

    it('deletes an unreserved row once, and never a reserved one (POD-4776)', async () => {
      await enqueue('m1', 's1', 1)
      await enqueue('m2', 's1', 2)
      await repo.reserveQueuedDelivery('m2')
      expect(await repo.deleteUnreservedQueuedMessage('m1')).toBe(true)
      expect(await repo.deleteUnreservedQueuedMessage('m1')).toBe(false)
      expect(await repo.deleteUnreservedQueuedMessage('m2')).toBe(false)
      expect((await repo.listQueuedMessages(session('s1'))).map((m) => m.id)).toEqual(['m2'])
    })

    it('drops one session queue and leaves the others', async () => {
      await enqueue('m1', 's1', 1)
      await enqueue('m2', 's2', 2)
      await repo.deleteQueuedMessagesForSession(session('s1'))
      expect(await repo.listQueuedMessages(session('s1'))).toEqual([])
      expect((await repo.listQueuedMessages(session('s2'))).map((m) => m.id)).toEqual(['m2'])
    })
  })

  describe('the parked upstream outbox', () => {
    it('reports the parked rows oldest first and reads none of the payload', async () => {
      await fixture().seed(
        // Rows of the repository's own workspace: the column has no default (POD-7024).
        // Their order is the number the queue-order migration gave them (POD-7075).
        `INSERT INTO upstream_outbox (workspace_id, mutation_id, proc, input, queued_at, queue_order) VALUES ('${repo.workspaceId}', 'b', 'issues.update', '{"secret":1}', 20, 2), ('${repo.workspaceId}', 'a', 'issues.create', '{"secret":2}', 10, 1)`,
      )
      const parked = await repo.listParkedUpstreamMutations()
      expect(parked).toEqual([
        { mutationId: 'a', proc: 'issues.create', queuedAt: 10 },
        { mutationId: 'b', proc: 'issues.update', queuedAt: 20 },
      ])
      // Three of the table's six columns, named [rule 39] — `input` is the parked
      // payload this report deliberately does not read.
      expect(Object.keys(parked[0] as object).sort()).toEqual(['mutationId', 'proc', 'queuedAt'])
    })

    it('is empty when nothing was ever parked', async () => {
      expect(await repo.listParkedUpstreamMutations()).toEqual([])
    })
  })

  describe('the access moves (POD-7552)', () => {
    it('keeps the latest move of each human, in one statement per hundred humans', async () => {
      expect(await repo.accessMovedAfter('u-1', 0)).toBe(false)
      await repo.recordAccessMoves(new Map([['u-1', 7]]))
      await repo.recordAccessMoves(
        new Map([
          ['u-1', 4],
          ['u-2', 9],
        ]),
      )
      expect(
        // A migrated store also holds the row naming where recording started.
        await stored(
          "SELECT workspace_id, human_id, seq FROM sync_access_moves WHERE human_id <> '' ORDER BY human_id",
        ),
      ).toEqual([
        { workspace_id: SUITE_WORKSPACE_ID, human_id: 'u-1', seq: 7 },
        { workspace_id: SUITE_WORKSPACE_ID, human_id: 'u-2', seq: 9 },
      ])
      expect(await repo.accessMovedAfter('u-1', 6)).toBe(true)
      expect(await repo.accessMovedAfter('u-1', 7)).toBe(false)
      expect(await repo.accessMovedAfter('u-3', 0)).toBe(false)
      const many = new Map(Array.from({ length: 150 }, (_, i) => [`m-${i}`, 20 + i] as const))
      const statements = await fixture().record(() => repo.recordAccessMoves(many))
      expect(statements.filter((text) => /sync_access_moves/i.test(text))).toHaveLength(2)
      expect(await repo.accessMovedAfter('m-149', 168)).toBe(true)
      await repo.recordAccessMoves(new Map())
    })

    it('answers a cursor below where recording started as moved: it cannot tell', async () => {
      // What the migration writes, at a head of 5.
      await fixture().seed("DELETE FROM sync_access_moves WHERE human_id = ''")
      await fixture().seed(
        `INSERT INTO sync_access_moves (workspace_id, human_id, seq) VALUES ('${SUITE_WORKSPACE_ID}', '', 5)`,
      )
      expect(await repo.accessMovedAfter('u-1', 4)).toBe(true)
      expect(await repo.accessMovedAfter('u-1', 5)).toBe(false)
      await repo.recordAccessMoves(new Map([['u-1', 8]]))
      expect(await repo.accessMovedAfter('u-1', 7)).toBe(true)
      expect(await repo.accessMovedAfter('u-1', 8)).toBe(false)
    })

    // POD-7585: the recorded-through mark, raised only by statements that write anyway.
    it('keeps the recorded-through mark in the moves upsert, and never lowers it', async () => {
      await fixture().seed("DELETE FROM sync_access_moves WHERE human_id = ''")
      // Before any pass raised it, a replay starts where recording started.
      expect(await repo.readRecordedThrough()).toBe(0)
      await fixture().seed(
        `INSERT INTO sync_access_moves (workspace_id, human_id, seq) VALUES ('${SUITE_WORKSPACE_ID}', '', 5)`,
      )
      expect(await repo.readRecordedThrough()).toBe(5)
      const statements = await fixture().record(() =>
        repo.recordAccessMoves(new Map([['u-1', 8]]), 9),
      )
      expect(statements.filter((text) => /sync_access_moves/i.test(text))).toHaveLength(1)
      expect(await repo.readRecordedThrough()).toBe(9)
      // The mark is not a human: nobody's access moved at it.
      expect(await repo.accessMovedAfter('u-1', 8)).toBe(false)
      await repo.recordAccessMoves(new Map(), 7)
      expect(await repo.readRecordedThrough()).toBe(9)
      await repo.recordAccessMoves(new Map(), 12)
      expect(await repo.readRecordedThrough()).toBe(12)
    })

    it('raises where recording started, and the mark with it, when a tail cannot be replayed', async () => {
      const statements = await fixture().record(() => repo.raiseRecordingStart(20))
      expect(statements.filter((text) => /sync_access_moves/i.test(text))).toHaveLength(1)
      expect(await repo.readRecordedThrough()).toBe(20)
      expect(await repo.accessMovedAfter('u-1', 19)).toBe(true)
      expect(await repo.accessMovedAfter('u-1', 20)).toBe(false)
      await repo.raiseRecordingStart(3)
      expect(await repo.accessMovedAfter('u-1', 19)).toBe(true)
    })
  })

  describe('the feed identity', () => {
    it('is null before it is minted, or the provisioned identity', async () => {
      const identity = await repo.readFeedIdentity()
      // A provisioned store minted the identity with the row (contract C4).
      if (fixture().provisioned) {
        expect(identity).toEqual({ feedId: expect.any(String), epoch: expect.any(String) })
      } else {
        expect(identity).toBeNull()
      }
    })

    it('REPLACES on a bump rather than appending a second generation', async () => {
      await repo.writeFeedIdentity({ feedId: 'feed-1', epoch: 'epoch-1' }, 100)
      await repo.writeFeedIdentity({ feedId: 'feed-1', epoch: 'epoch-2' }, 200)
      expect(await repo.readFeedIdentity()).toEqual({ feedId: 'feed-1', epoch: 'epoch-2' })
      expect(await stored('SELECT workspace_id, minted_at FROM sync_feed')).toEqual([
        { workspace_id: SUITE_WORKSPACE_ID, minted_at: 200 },
      ])
    })
  })

  describe('the change capture', () => {
    // A store's feed already holds generations for its kinds; these pins name their own.
    const KINDS = "kind IN ('machine', 'machineAccess')"
    it('retires the rows above a mark: each kind up one generation, in this workspace only', async () => {
      // Captured rows may exist inside a write, never across its commit.
      // Inspect the retained prefix here, then drain it before committing.
      await fixture()
        .queries()
        .createOrJoinTransaction(async () => {
          await fixture().seed(`DELETE FROM sync_kind WHERE ${KINDS}`)
          await fixture().seed(
            `INSERT INTO sync_kind (workspace_id, kind, generation) VALUES ('${SUITE_WORKSPACE_ID}', 'machine', 4), ('other', 'machine', 9)`,
          )
          await fixture().seed(`INSERT INTO sync_capture (id, kind, source, op, old_key, new_key) VALUES
        (1, 'issueProjection', 0, 'u', '["i"]', '["i"]'),
        (2, 'machine', 0, 'u', '["m"]', '["m"]'),
        (3, 'machineAccess', 0, 'u', '["m"]', '["m"]'),
        (4, 'machine', 1, 'i', NULL, '["m2"]')`)
          expect(await repo.retireCapture(1)).toEqual(['machine', 'machineAccess'])
          // Twice-captured `machine` moves once; a kind with no row starts at 1; the
          // row below the mark and the other workspace's generation are untouched.
          expect(
            await stored(
              `SELECT workspace_id, kind, generation FROM sync_kind WHERE ${KINDS} ORDER BY workspace_id, kind`,
            ),
          ).toEqual([
            { workspace_id: SUITE_WORKSPACE_ID, kind: 'machine', generation: 5 },
            { workspace_id: SUITE_WORKSPACE_ID, kind: 'machineAccess', generation: 1 },
            { workspace_id: 'other', kind: 'machine', generation: 9 },
          ])
          expect(await stored('SELECT id FROM sync_capture')).toEqual([{ id: 1 }])
          expect(await repo.readKindGenerations()).toContainEqual({
            kind: 'machine',
            generation: 5,
          })
          await repo.drainCapture()
        })
    })

    it('changes nothing when nothing was captured above the mark', async () => {
      const before = await stored('SELECT * FROM sync_kind ORDER BY workspace_id, kind')
      expect(await repo.retireCapture()).toEqual([])
      expect(await stored('SELECT * FROM sync_kind ORDER BY workspace_id, kind')).toEqual(before)
    })
  })
}

// ---------------------------------------------------------------------------
// One feed per workspace
// ---------------------------------------------------------------------------

const rows = (n: number): ChangeLogWriteRow[] =>
  Array.from({ length: n }, (_, i) => ({
    entity: 'issueProjection',
    entityId: `i${i}`,
    op: 'upsert',
    payload: '{}',
  }))

/**
 * ONE FEED PER WORKSPACE (ADR 13, POD-6959 design 2.7, POD-7021).
 *
 * Two workspaces over one database, with the same entity ids, mutation ids and
 * session ids: what one writes never reaches the other's feed, head, floor,
 * kind generations, mutation receipts or inbox, and a repository of one
 * workspace cannot run inside the other's transaction.
 */
export function describeTenantFeed(open: OpenSyncRepositoryFixture): void {
  const fixture = eachFixture(open)
  const tenant = (id: string) => fixture().repository(id)

  it('isolates identities, generations, heads and both range reads with overlapping keys', async () => {
    const a = await tenant('a'),
      b = await tenant('b')
    await a.writeFeedIdentity({ feedId: 'feed-a', epoch: 'epoch-a' }, 1)
    await b.writeFeedIdentity({ feedId: 'feed-b', epoch: 'epoch-b' }, 2)
    await fixture().seed(
      "INSERT INTO sync_kind VALUES ('a', 'issueProjection', 7), ('b', 'issueProjection', 9)",
    )
    // An identity minted before any append starts the feed at head 1 (ADR 2 D12);
    // a provisioned feed keeps its head 0 through the identity write.
    const first = fixture().provisioned ? 1 : 2
    expect(await a.appendChanges(rows(2), 1)).toEqual([first, first + 1])
    expect(await b.appendChanges(rows(1), 2)).toEqual([first])
    expect(await a.readKindGenerations()).toEqual([{ kind: 'issueProjection', generation: 7 }])
    expect(await b.readKindGenerations()).toEqual([{ kind: 'issueProjection', generation: 9 }])
    expect(await b.readFeedIdentity()).toEqual({ feedId: 'feed-b', epoch: 'epoch-b' })
    expect((await a.changesSince(0)).map((r) => r.seq)).toEqual([first, first + 1])
    expect((await b.changesInRange(0, 2, 10)).map((r) => r.seq)).toEqual([first])
    expect(await b.readFeedState()).toEqual({ headSeq: first, floorSeq: 1 })
  })

  it('keeps each workspace its own access moves (POD-7552)', async () => {
    const a = await tenant('a'),
      b = await tenant('b')
    await b.recordAccessMoves(new Map([['u-1', 30]]))
    expect(await a.accessMovedAfter('u-1', 0)).toBe(false)
    await a.recordAccessMoves(new Map([['u-1', 2]]))
    expect(await b.accessMovedAfter('u-1', 29)).toBe(true)
    expect(await a.accessMovedAfter('u-1', 2)).toBe(false)
    // POD-7585: and its own recorded-through mark.
    await b.recordAccessMoves(new Map(), 40)
    expect(await a.readRecordedThrough()).toBeLessThan(40)
    expect(await b.readRecordedThrough()).toBe(40)
  })

  it('prunes only its tenant, persists the empty floor and never reuses a committed number', async () => {
    const a = await tenant('a'),
      b = await tenant('b')
    await a.appendChanges(rows(4), 1)
    await b.appendChanges(rows(4), 100)
    // Every row has aged out, and the plan still keeps the head row (POD-7593).
    const plan = await a.planChangePrune({ keepRows: 1, maxAgeMs: 10, now: 100 })
    expect(plan.thresholdSeq).toBe(3)
    expect(await a.pruneChangeBatch(plan, 2)).toBe(2)
    expect(await a.readFeedState()).toEqual({ headSeq: 4, floorSeq: 3 })
    // A log emptied by an older planner: the floor is head + 1, in one read.
    expect(await a.pruneChangeBatch({ thresholdSeq: 4 }, 2)).toBe(2)
    expect(await a.readFeedState()).toEqual({ headSeq: 4, floorSeq: 5 })
    expect(await a.minChangeSeq()).toBeNull()
    expect(await a.minAvailableSeq()).toBe(5)
    expect(await (await tenant('a')).appendChanges(rows(1), 101)).toEqual([5])
    expect(await b.readFeedState()).toEqual({ headSeq: 4, floorSeq: 1 })
    expect(await b.changesSince(0)).toHaveLength(4)
    expect(await b.planChangePrune({ keepRows: 10, maxAgeMs: 10, now: 100 })).toEqual({
      thresholdSeq: 0,
    })
  })

  it('rolls reservations, source writes and all chunks back with the enclosing write', async () => {
    const a = await tenant('a')
    await fixture().seed('CREATE TABLE source (id TEXT PRIMARY KEY)')
    await expect(
      fixture()
        .queries('a')
        .createOrJoinTransaction(async () => {
          await fixture().runInTransaction("INSERT INTO source VALUES ('changed')")
          await a.appendChanges(rows(250), 1)
          expect(await a.maxChangeSeq()).toBe(250)
          throw new Error('abort source write')
        }),
    ).rejects.toThrow('abort source write')
    expect(await fixture().stored('SELECT * FROM source')).toEqual([])
    expect(await a.readFeedState()).toEqual({ headSeq: 0, floorSeq: 1 })
    expect(await a.changesSince(0)).toEqual([])
    expect(await a.appendChanges(rows(1), 2)).toEqual([1])
  })

  it('rolls back an insert failure after an earlier chunk succeeded', async () => {
    const a = await tenant('a')
    const invalid = rows(101)
    invalid[100] = { ...invalid[100]!, entityId: null as unknown as string }
    await expect(a.appendChanges(invalid, 1)).rejects.toThrow()
    expect(await a.changesSince(0)).toEqual([])
    expect(await a.appendChanges(rows(2), 2)).toEqual([1, 2])
  })

  it('raises only an empty head, per tenant, so no start-up load is stamped at 0', async () => {
    // The fresh-install row the tenant-feed migration writes: head 0, floor 1 (a
    // provisioned store has written the same row already).
    await fixture().seed(
      "INSERT INTO sync_feed (workspace_id, feed_id, epoch, minted_at, head_seq, floor_seq) VALUES ('a', 'fa', 'ea', 0, 0, 1), ('b', 'fb', 'eb', 0, 0, 1) ON CONFLICT DO NOTHING",
    )
    const a = await tenant('a'),
      b = await tenant('b')
    await a.raiseEmptyHead()
    // The floor stays 1: the empty range (0, 1] is what a cursor at 0 reads.
    expect(await a.readFeedState()).toEqual({ headSeq: 1, floorSeq: 1 })
    expect(await b.readFeedState()).toEqual({ headSeq: 0, floorSeq: 1 })
    expect(await a.appendChanges(rows(1), 1)).toEqual([2])
    await a.raiseEmptyHead()
    expect(await a.readFeedState()).toEqual({ headSeq: 2, floorSeq: 1 })
    // A feed whose identity is minted before any append is created at head 1; a
    // provisioned feed already exists at head 0 and keeps its counters.
    const c = await tenant('c')
    await c.writeFeedIdentity({ feedId: 'fc', epoch: 'ec' }, 1)
    expect(await c.readFeedState()).toEqual({
      headSeq: fixture().provisioned ? 0 : 1,
      floorSeq: 1,
    })
  })

  it('identity bumps preserve counters and empty appends reserve nothing', async () => {
    const a = await tenant('a')
    expect(await a.appendChanges([], 0)).toEqual([])
    if (!fixture().provisioned) expect(await a.readFeedIdentity()).toBeNull()
    await a.appendChanges(rows(2), 1)
    await a.writeFeedIdentity({ feedId: 'feed-a', epoch: 'epoch-next' }, 2)
    expect(await a.readFeedState()).toEqual({ headSeq: 2, floorSeq: 1 })
    expect(await a.appendChanges(rows(1), 3)).toEqual([3])
  })

  it("never shows a write of one workspace in another's feed, head or floor", async () => {
    const a = await tenant('ws_a'),
      b = await tenant('ws_b')
    // The same entity ids in both workspaces.
    await b.appendChanges(rows(2), 1)
    const bBefore = await b.readFeedState()
    const bChanges = await b.changesSince(0)
    expect(await a.appendChanges(rows(3), 2)).toEqual([1, 2, 3])
    expect(await a.appendChanges(rows(2), 3)).toEqual([4, 5])
    expect(await b.readFeedState()).toEqual(bBefore)
    expect(await b.changesSince(0)).toEqual(bChanges)
    expect(await b.changesInRange(0, 10, 10)).toEqual(bChanges)
    expect(await b.maxChangeSeq()).toBe(2)
    // A's seqs 3 to 5 do not exist in B's log; 1 and 2 are B's own rows.
    expect([...(await b.changesWithPrior([1, 2, 3, 4, 5])).keys()].sort()).toEqual([1, 2])
    // A prune in A leaves B's floor and rows alone.
    const plan = await a.planChangePrune({ keepRows: 0, maxAgeMs: 0, now: 100 })
    expect(await a.pruneChangeBatch(plan, 10)).toBe(4)
    expect(await a.readFeedState()).toEqual({ headSeq: 5, floorSeq: 5 })
    expect(await b.readFeedState()).toEqual(bBefore)
    expect(await b.changesSince(0)).toEqual(bChanges)
  })

  it('moves kind generations per workspace', async () => {
    const a = await tenant('ws_a'),
      b = await tenant('ws_b')
    await a.writeFeedIdentity({ feedId: 'fa', epoch: 'ea' }, 1)
    await b.writeFeedIdentity({ feedId: 'fb', epoch: 'eb' }, 1)
    await fixture().seed(
      "INSERT INTO sync_kind VALUES ('ws_a', 'session', 4), ('ws_b', 'session', 4), ('ws_b', 'message', 2)",
    )
    // A bump of one workspace's kind moves only that workspace's generation.
    await fixture().seed(
      "UPDATE sync_kind SET generation = generation + 1 WHERE workspace_id = 'ws_a' AND kind = 'session'",
    )
    expect(await a.readKindGenerations()).toEqual([{ kind: 'session', generation: 5 }])
    expect((await b.readKindGenerations()).sort((x, y) => x.kind.localeCompare(y.kind))).toEqual([
      { kind: 'message', generation: 2 },
      { kind: 'session', generation: 4 },
    ])
    // A data migration's bump (design 2.7) moves the kind once in every workspace
    // with a feed. Only the two workspaces of this test: a provisioned store has
    // its own workspace's feed row too.
    await fixture().seed(
      "INSERT INTO sync_kind (workspace_id, kind, generation) SELECT workspace_id, 'message', 1 FROM sync_feed WHERE workspace_id IN ('ws_a', 'ws_b') " +
        'ON CONFLICT (workspace_id, kind) DO UPDATE SET generation = sync_kind.generation + 1',
    )
    const generation = async (repo: SyncRepository, kind: string) =>
      (await repo.readKindGenerations()).find((row) => row.kind === kind)?.generation
    expect([await generation(a, 'message'), await generation(b, 'message')]).toEqual([1, 3])
    expect([await generation(a, 'session'), await generation(b, 'session')]).toEqual([5, 4])
  })

  it('keeps mutation receipts and the session inbox per workspace', async () => {
    const a = await tenant('ws_a'),
      b = await tenant('ws_b')
    const mutation = 'mut-1' as MutationId
    await a.recordAppliedMutation(mutation, 'issue.create', '{"ok":"a"}', 10)
    expect(await a.getAppliedMutation(mutation)).toBe('{"ok":"a"}')
    expect(await b.getAppliedMutation(mutation)).toBeUndefined()
    expect(
      await b.getAppliedMutation(mutation, { mutationId: mutation, before: 100 }),
    ).toBeUndefined()
    expect(await b.pruneAppliedMutationsBatch(1_000, 100)).toBe(0)
    expect(await a.getAppliedMutation(mutation)).toBe('{"ok":"a"}')

    const session = 'sess-1' as SessionId
    expect(await a.enqueueMessage({ id: 'q-a', sessionId: session, text: 'a', queuedAt: 1 })).toBe(
      true,
    )
    expect(await b.listQueuedMessages(session)).toEqual([])
    expect(await b.queuedMessageCounts()).toEqual(new Map())
    expect(await b.queuedMessageCounts([session])).toEqual(new Map())
    // B's writes by A's ids reach nothing of A's.
    await b.reserveQueuedDelivery('q-a')
    await b.deleteQueuedMessage('q-a')
    await b.deleteQueuedMessagesForSession(session)
    expect(await b.deleteUnreservedQueuedMessage('q-a')).toBe(false)
    const [row] = await a.listQueuedMessages(session)
    expect(row).toMatchObject({ id: 'q-a', deliveryOwner: null, attempts: 0 })
    expect(await a.queuedMessageCounts(session)).toEqual(new Map([[session, 1]]))
    expect(await b.listParkedUpstreamMutations()).toEqual([])
  })

  it("refuses a statement of one workspace inside another's transaction", async () => {
    const a = await tenant('ws_a'),
      b = await tenant('ws_b')
    await expect(
      fixture()
        .queries('ws_a')
        .createOrJoinTransaction(async () => {
          await a.appendChanges(rows(1), 1)
          await b.appendChanges(rows(1), 1)
        }),
    ).rejects.toBeInstanceOf(fixture().crossWorkspaceRefusal)
    // The whole transaction rolled back: A's append did not commit either.
    expect(await a.readFeedState()).toEqual({ headSeq: 0, floorSeq: 1 })
    expect(await b.readFeedState()).toEqual({ headSeq: 0, floorSeq: 1 })
  })

  it("refuses to build a repository over another workspace's queries", () => {
    expect(
      () => new SyncRepository(fixture().queries('ws_a'), fixture().serverTables, 'ws_b'),
    ).toThrow('built over the queries of workspace ws_a')
  })
}
