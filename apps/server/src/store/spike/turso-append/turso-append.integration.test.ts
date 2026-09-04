/**
 * The change-log append contract, asserted against a real libsql server [POD-3250].
 *
 * WHAT THIS FILE IS FOR. `run-proofs.ts` measures; this asserts. Everything here
 * runs against a local `sqld` the test starts itself — the same server
 * `turso dev` runs — so CI can keep the contract honest without credentials.
 * The hosted database agreed with every assertion below when the results were
 * taken (`docs/internal/pod-3250-turso-append-proof.md`); where the two engines
 * differ, the document says so and the difference is a number, not a verdict.
 *
 * WHY NOT A FAKE DRIVER. Every assertion here is about the engine and the
 * transport: whether `lastInsertRowid` arriving over hrana names this
 * statement's rows, whether `sqlite_sequence` rolls back with the transaction,
 * whether the high-water mark survives the process. A fake would satisfy all
 * three by construction.
 *
 * SKIPPED, NOT FAILED, WITHOUT `sqld`. The binary ships with the Turso CLI and
 * is not on `PATH` on every machine. A suite that went red on a missing
 * development tool would be noise; a suite that reports the skip is a suite
 * someone can act on. Set `PODIUM_SQLD_PATH` to point at it.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { type LocalServer, sqldBinary, startLocalServer } from './backend'
import { openSlice, type Slice, upsertRows } from './fixture'
import { acquireLock, readLock } from './locks'
import {
  appendChangesBatched,
  appendChangesLiteral,
  appendChangesNested,
  changesSince,
  latestChangeStates,
  maxChangeSeq,
  minChangeSeq,
} from './sync-append'

/**
 * Whether the server binary is here at all, decided BEFORE the suite is
 * declared so the skip is a skip and not a red beforeAll.
 *
 * Resolved synchronously and by file existence rather than by trying to start
 * one: an availability check that spawns a server would double the suite's
 * setup cost and would report a busy port as a missing binary.
 */
const SQLD = sqldBinary()

let server: LocalServer | undefined

beforeAll(async () => {
  if (SQLD !== undefined) server = await startLocalServer()
}, 60_000)

afterAll(async () => {
  await server?.dispose()
})

/** The server, or the error that says which assumption broke. */
function backend(): LocalServer {
  if (server === undefined) throw new Error('sqld did not start; this suite should have skipped')
  return server
}

async function withSlice<T>(body: (slice: Slice) => Promise<T>): Promise<T> {
  const slice = await openSlice(backend().config)
  try {
    return await body(slice)
  } finally {
    await slice.close()
  }
}

// The skip reason is PRINTED rather than silent: a suite that vanishes without
// saying why reads as a suite that passed.
if (SQLD === undefined) {
  console.warn(
    '[POD-3250] skipping the Turso append proof: no sqld binary found. ' +
      'Install the Turso CLI or set PODIUM_SQLD_PATH.',
  )
}

describe.skipIf(SQLD === undefined)('change-log append over libsql', () => {
  it('assigns contiguous seqs across every chunk boundary', async () => {
    await withSlice(async (slice) => {
      // 250 rows is three chunks, so two boundaries are crossed. A single-chunk
      // append would never exercise the derivation this asserts.
      const rows = upsertRows(250)
      const seqs = await slice.withSession((s) => appendChangesLiteral(s, slice.db, slice.tables, rows, 1_000))
      expect(seqs).toHaveLength(250)
      expect(seqs).toEqual(Array.from({ length: 250 }, (_, i) => i + 1))
    })
  }, 60_000)

  it('gives the batched form the same seqs as the literal one', async () => {
    // The two shapes exist to be traded off on round trips, so a divergence in
    // what they assign would make the measurement meaningless.
    const literal = await withSlice((slice) =>
      slice.withSession((s) => appendChangesLiteral(s, slice.db, slice.tables, upsertRows(250), 1_000)),
    )
    const batched = await withSlice((slice) =>
      slice.withSession((s) => appendChangesBatched(s, slice.db, slice.tables, upsertRows(250), 1_000)),
    )
    expect(batched).toEqual(literal)
  }, 60_000)

  it('continues contiguously from the head on a later append', async () => {
    await withSlice(async (slice) => {
      await slice.withSession((s) => appendChangesLiteral(s, slice.db, slice.tables, upsertRows(120, 'a'), 1_000))
      const head = await slice.withSession((s) => maxChangeSeq(s, slice.tables))
      const seqs = await slice.withSession((s) =>
        appendChangesLiteral(s, slice.db, slice.tables, upsertRows(30, 'b'), 2_000),
      )
      expect(head).toBe(120)
      expect(seqs[0]).toBe(121)
      expect(seqs).toEqual(Array.from({ length: 30 }, (_, i) => 121 + i))
    })
  }, 60_000)

  it('derives each range from the statement that wrote it, not from the database', async () => {
    // Two clients appending alternately. If `lastInsertRowid` over hrana were
    // the DATABASE's last insert rather than this statement's, the ranges would
    // still look contiguous — they would simply address the other client's rows.
    // So the assertion is on the rows the seqs resolve to, not on the numbers.
    const config = backend().config
    const a = await openSlice(config)
    const b = await openSlice(config, { reset: false })
    try {
      const seqsA = await a.withSession((s) =>
        appendChangesLiteral(s, a.db, a.tables, upsertRows(100, 'c'), 1_000),
      )
      const seqsB = await b.withSession((s) =>
        appendChangesLiteral(s, b.db, b.tables, upsertRows(50, 'd'), 1_000),
      )
      const seqsA2 = await a.withSession((s) =>
        appendChangesLiteral(s, a.db, a.tables, upsertRows(100, 'e'), 1_000),
      )

      const rows = await a.withSession((s) => changesSince(s, a.db, a.tables, 0))
      const at = new Map(rows.map((r) => [r.seq, r.entityId]))
      expect(seqsA.map((seq, i) => at.get(seq) === `c${i}`)).not.toContain(false)
      expect(seqsB.map((seq, i) => at.get(seq) === `d${i}`)).not.toContain(false)
      expect(seqsA2.map((seq, i) => at.get(seq) === `e${i}`)).not.toContain(false)

      const all = [...seqsA, ...seqsB, ...seqsA2]
      expect(new Set(all).size).toBe(all.length)
      expect(rows.map((r) => r.seq)).toEqual(Array.from({ length: 250 }, (_, i) => i + 1))
    } finally {
      await a.close()
      await b.close()
    }
  }, 60_000)

  it('rolls the whole append back when a chunk throws, INCLUDING the counter', async () => {
    await withSlice(async (slice) => {
      await expect(
        slice.withSession((s) =>
          appendChangesLiteral(s, slice.db, slice.tables, upsertRows(250, 'f'), 1_000, {
            afterChunk: (i) => {
              if (i === 1) throw new Error('deliberate failure after the second chunk')
            },
          }),
        ),
      ).rejects.toThrow('deliberate failure')

      expect(await slice.withSession((s) => changesSince(s, slice.db, slice.tables, 0))).toEqual([])
      expect(await slice.withSession((s) => latestChangeStates(s, slice.db, slice.tables))).toEqual([])
      expect(await slice.withSession((s) => minChangeSeq(s, slice.tables))).toBeNull()

      // The counter is the half a "no rows left behind" assertion would miss:
      // if `sqlite_sequence` did not roll back, the next append would start
      // after a gap the failed one had burned.
      expect(await slice.withSession((s) => maxChangeSeq(s, slice.tables))).toBe(0)
      const next = await slice.withSession((s) =>
        appendChangesLiteral(s, slice.db, slice.tables, upsertRows(5, 'g'), 2_000),
      )
      expect(next).toEqual([1, 2, 3, 4, 5])
    })
  }, 60_000)

  it('REUSES a seq it already handed out when the enclosing span rolls back', async () => {
    // POD-3260's class, pinned on the remote client rather than reasoned about.
    //
    // This test asserts the DANGEROUS behaviour, which is unusual and deliberate.
    // The test above it asserts that a failed append rolls its counter back and
    // calls that correct — and it IS correct there, because that append owns its
    // transaction, so a rollback revokes seqs nobody could have published.
    //
    // Here the append SUCCEEDS and returns its seqs — the moment the real code
    // would publish them — and the ENCLOSING span rolls back afterwards. The
    // counter goes back with it, and the next unrelated change is handed numbers
    // a replica has already been told about. That replica treats the genuine
    // change as one it has seen, so the stale row SUPPRESSES the correct one.
    // Worse than a gap: a gap heals and this does not.
    //
    // Nothing in the append can fix it; the rule is that seqs must not escape a
    // span that can still roll back. What this test does is make sure the proof
    // would SEE it, so a regression cannot hide behind "that cannot happen".
    await withSlice(async (slice) => {
      const session = await slice.driver.open('write')
      let first: number[] = []
      let second: number[] = []
      try {
        await session.begin('write')
        await session.enterSavepoint('sp_outer')
        first = await appendChangesNested(
          session,
          slice.db, slice.tables,
          upsertRows(5, 'v'),
          1_000,
          'sp_publish',
        )
        await session.rollbackToSavepoint('sp_outer')
        second = await appendChangesNested(session, slice.db, slice.tables, upsertRows(5, 'w'), 2_000, 'sp_next')
        await session.commit()
      } finally {
        await session.close()
      }

      expect(first).toEqual([1, 2, 3, 4, 5])
      // The same numbers, for entirely different rows.
      expect(second).toEqual(first)

      const rows = await slice.withSession((s) => changesSince(s, slice.db, slice.tables, 0))
      expect(rows.map((r) => r.entityId)).toEqual(['w0', 'w1', 'w2', 'w3', 'w4'])
      // A replica told "seq 1 is v0" would now be served w0 at seq 1.
      expect(rows.find((r) => r.seq === first[0])?.entityId).toBe('w0')
    })
  }, 60_000)

  it('rolls a FAILED nested append back to its savepoint, leaving the outer span intact', async () => {
    // The nested shape's own failure path, which the test above does not reach
    // because its append succeeds. Without it, a nested append that threw
    // mid-way would leave its earlier chunks applied inside the enclosing
    // transaction — the chunk-by-chunk commit this whole proof rules out,
    // wearing a savepoint as a disguise.
    await withSlice(async (slice) => {
      const session = await slice.driver.open('write')
      try {
        await session.begin('write')
        // A committed neighbour in the same outer span: the failed append must
        // not take this with it.
        const kept = await appendChangesNested(
          session,
          slice.db, slice.tables,
          upsertRows(2, 'k'),
          1_000,
          'sp_kept',
        )
        expect(kept).toEqual([1, 2])

        await expect(
          appendChangesNested(session, slice.db, slice.tables, upsertRows(5, 'd'), 2_000, 'sp_doomed', {
            // Thrown AFTER the chunk has inserted and its `change_latest` rows
            // have been written — the only window in which a partially applied
            // nested append could survive into the outer span.
            afterChunk: () => {
              throw new Error('deliberate failure inside the nested append')
            },
          }),
        ).rejects.toThrow('deliberate failure')

        await session.commit()
      } finally {
        await session.close()
      }

      // The neighbour survived; the doomed append left nothing.
      const rows = await slice.withSession((s) => changesSince(s, slice.db, slice.tables, 0))
      expect(rows.map((r) => r.entityId)).toEqual(['k0', 'k1'])
    })
  }, 60_000)

  it('writes the installed world inside the append, in log order', async () => {
    await withSlice(async (slice) => {
      // The same entity upserted and then removed within one batch: grouping the
      // two ops into bulk statements would apply them in op order and leave the
      // removed entity installed.
      const seqs = await slice.withSession((s) =>
        appendChangesLiteral(
          s,
          slice.db, slice.tables,
          [
            { entity: 'issue', entityId: 'x', op: 'upsert', payload: '{"v":1}' },
            { entity: 'issue', entityId: 'y', op: 'upsert', payload: '{"v":2}' },
            { entity: 'issue', entityId: 'x', op: 'remove', payload: null },
          ],
          1_000,
        ),
      )
      expect(seqs).toEqual([1, 2, 3])
      const world = await slice.withSession((s) => latestChangeStates(s, slice.db, slice.tables))
      expect(world.map((r) => r.entityId)).toEqual(['y'])
    })
  }, 60_000)

  it('treats a payload-less upsert as "not installed"', async () => {
    await withSlice(async (slice) => {
      await slice.withSession((s) =>
        appendChangesLiteral(
          s,
          slice.db, slice.tables,
          [
            { entity: 'issue', entityId: 'z', op: 'upsert', payload: '{"v":1}' },
            { entity: 'issue', entityId: 'z', op: 'upsert', payload: null },
          ],
          1_000,
        ),
      )
      // Both rows are in the log; the world holds neither, because storing a
      // NULL payload would break the NOT NULL column and keeping the previous
      // state would show what the folded log no longer shows.
      expect(await slice.withSession((s) => changesSince(s, slice.db, slice.tables, 0))).toHaveLength(2)
      expect(await slice.withSession((s) => latestChangeStates(s, slice.db, slice.tables))).toEqual([])
    })
  }, 60_000)

  it('reads the head from sqlite_sequence, so it survives head-pruning', async () => {
    await withSlice(async (slice) => {
      await slice.withSession((s) => appendChangesLiteral(s, slice.db, slice.tables, upsertRows(200), 1_000))

      // PRUNE EVERYTHING, and that is the case that separates the two readings
      // rather than a partial prune. Head-pruning deletes the OLDEST rows, so
      // after dropping seq <= 150 the retained maximum is still 200 and
      // `MAX(seq) FROM changes` agrees with `sqlite_sequence` by accident — a
      // mutation swapping one for the other survives such a test. Once every
      // row is gone (POD-678's "every row aged out"), `MAX` is NULL and only
      // the high-water mark still knows where the log had got to.
      await slice.counted.client.execute(`DELETE FROM ${slice.prefix}changes`)

      expect(await slice.withSession((s) => minChangeSeq(s, slice.tables))).toBeNull()
      expect(await slice.withSession((s) => maxChangeSeq(s, slice.tables))).toBe(200)

      // The consequence, stated as the thing that would actually break: a
      // reused seq. If the head read fell back to 0 here, this append would
      // hand three changes positions that 200 earlier changes already held,
      // and every replica holding the old ones would silently diverge.
      const next = await slice.withSession((s) =>
        appendChangesLiteral(s, slice.db, slice.tables, upsertRows(3, 'p'), 2_000),
      )
      expect(next).toEqual([201, 202, 203])
    })
  }, 60_000)

  it('keeps the head after a PARTIAL prune too, where MAX has not yet fallen', async () => {
    await withSlice(async (slice) => {
      await slice.withSession((s) => appendChangesLiteral(s, slice.db, slice.tables, upsertRows(200), 1_000))
      await slice.counted.client.execute(`DELETE FROM ${slice.prefix}changes WHERE seq <= 150`)
      expect(await slice.withSession((s) => minChangeSeq(s, slice.tables))).toBe(151)
      expect(await slice.withSession((s) => maxChangeSeq(s, slice.tables))).toBe(200)
    })
  }, 60_000)

  it('continues contiguously after the server process restarts', async () => {
    let local = await startLocalServer()
    try {
      const first = await openSlice(local.config)
      let head = 0
      try {
        await first.withSession((s) => appendChangesLiteral(s, first.db, first.tables, upsertRows(120), 1_000))
        head = await first.withSession((s) => maxChangeSeq(s, first.tables))
      } finally {
        await first.close()
      }
      expect(head).toBe(120)

      await local.stop()
      local = await startLocalServer({ dbPath: local.dbPath })

      const second = await openSlice(local.config, { reset: false })
      try {
        // The high-water mark had to survive in the file. If it did not, the
        // next append would REUSE seqs — silent divergence, not a visible gap.
        expect(await second.withSession((s) => maxChangeSeq(s, second.tables))).toBe(120)
        const seqs = await second.withSession((s) =>
          appendChangesLiteral(s, second.db, second.tables, upsertRows(10, 'q'), 2_000),
        )
        expect(seqs).toEqual(Array.from({ length: 10 }, (_, i) => 121 + i))
      } finally {
        await second.close()
      }
    } finally {
      await local.dispose()
    }
  }, 120_000)

  it('keeps a failed batch inside an open transaction from applying its prefix', async () => {
    // The port requires `executeBatch` to be atomic even inside a transaction,
    // and this is the assertion that makes the savepoint it costs load-bearing:
    // the RAW libsql batch is NOT atomic there — measured, the first statement
    // of a failing batch stays applied — so a driver that skipped the savepoint
    // would let a caught batch error commit its prefix.
    await withSlice(async (slice) => {
      const session = await slice.driver.open('write')
      try {
        await session.begin('write')
        await expect(
          session.executeBatch([
            {
              sql: `INSERT INTO ${slice.prefix}changes (entity, entity_id, op, payload, event_time) VALUES (?, ?, ?, ?, ?)`,
              params: ['issue', 'ok', 'upsert', '{}', 1],
              method: 'run',
              intent: 'write',
            },
            {
              sql: `INSERT INTO ${slice.prefix}changes (entity_id, op, event_time) VALUES (?, ?, ?)`,
              params: ['bad', 'upsert', 1],
              method: 'run',
              intent: 'write',
            },
          ]),
        ).rejects.toThrow()

        const remaining = await session.execute({
          sql: `SELECT COUNT(*) AS n FROM ${slice.prefix}changes`,
          params: [],
          method: 'get',
          intent: 'read',
        })
        expect(Number((remaining.rows[0] as Record<string, unknown>).n)).toBe(0)
        await session.rollback()
      } finally {
        await session.close()
      }
    })
  }, 60_000)

  it('grants a free lease, refuses a held one, and takes over an expired one', async () => {
    await withSlice(async (slice) => {
      const base = {
        repoId: 'repo',
        name: 'test:heavy',
        holderLabel: 'holder',
        acquiredAt: '2026-01-01T00:00:00Z',
      }
      const first = await slice.withSession((s) =>
        acquireLock(
          s,
          slice.db, slice.tables,
          { ...base, holderSessionId: 'session-a', expiresAt: '2026-01-01T00:10:00Z' },
          '2026-01-01T00:00:00Z',
        ),
      )
      expect(first).toEqual({ acquired: true, holder: 'session-a' })

      // Still inside A's lease: B is told who holds it, not handed it.
      const refused = await slice.withSession((s) =>
        acquireLock(
          s,
          slice.db, slice.tables,
          { ...base, holderSessionId: 'session-b', expiresAt: '2026-01-01T00:20:00Z' },
          '2026-01-01T00:05:00Z',
        ),
      )
      expect(refused).toEqual({ acquired: false, holder: 'session-a' })
      expect(await slice.withSession((s) => readLock(s, slice.db, slice.tables, 'repo', 'test:heavy'))).toBe(
        'session-a',
      )

      // Past A's expiry: the lease is free and B takes it over in place.
      const takeover = await slice.withSession((s) =>
        acquireLock(
          s,
          slice.db, slice.tables,
          { ...base, holderSessionId: 'session-b', expiresAt: '2026-01-01T00:30:00Z' },
          '2026-01-01T00:15:00Z',
        ),
      )
      expect(takeover).toEqual({ acquired: true, holder: 'session-b' })
      expect(await slice.withSession((s) => readLock(s, slice.db, slice.tables, 'repo', 'test:heavy'))).toBe(
        'session-b',
      )
    })
  }, 60_000)

  it('costs a round trip for the decision the append never has to make', async () => {
    await withSlice(async (slice) => {
      const request = {
        repoId: 'repo',
        name: 'lane',
        holderSessionId: 'session-a',
        holderLabel: 'A',
        acquiredAt: '2026-01-01T00:00:00Z',
        expiresAt: '2099-01-01T00:00:00Z',
      }
      slice.counted.roundTrips.reset()
      await slice.withSession((s) => acquireLock(s, slice.db, slice.tables, request, '2026-01-01T00:00:00Z'))
      const granted = slice.counted.roundTrips.reset()

      await slice.withSession((s) =>
        acquireLock(s, slice.db, slice.tables, { ...request, holderSessionId: 'b' }, '2026-01-01T00:00:00Z'),
      )
      const refused = slice.counted.roundTrips.reset()

      // The read has to come back before the caller can decide, so the write
      // lock is held across a full network round trip doing nothing. A refusal
      // is cheaper than a grant by exactly the write it does not do.
      expect(granted).toBe(3)
      expect(refused).toBe(2)
    })
  }, 60_000)

  it('costs one round trip for the bootstrap read whatever its size', async () => {
    await withSlice(async (slice) => {
      await slice.withSession((s) => appendChangesLiteral(s, slice.db, slice.tables, upsertRows(250), 1_000))
      slice.counted.roundTrips.reset()
      const world = await slice.withSession((s) => latestChangeStates(s, slice.db, slice.tables))
      expect(world).toHaveLength(250)
      // The number [B0.6]'s prefetch design is entitled to assume.
      expect(slice.counted.roundTrips.count()).toBe(1)
    })
  }, 60_000)

  it('costs two driver calls per chunk when batched, against one per row when not', async () => {
    await withSlice(async (slice) => {
      slice.counted.roundTrips.reset()
      await slice.withSession((s) => appendChangesLiteral(s, slice.db, slice.tables, upsertRows(100, 'r'), 1_000))
      const literal = slice.counted.roundTrips.reset()

      await slice.withSession((s) => appendChangesBatched(s, slice.db, slice.tables, upsertRows(100, 's'), 1_000))
      const batched = slice.counted.roundTrips.reset()

      // 100 `change_latest` statements plus the insert plus the commit; the
      // exact totals are recorded in the results document, and what is asserted
      // here is the SHAPE — the literal port scales with the row count and the
      // batched one does not.
      expect(literal).toBeGreaterThan(100)
      expect(batched).toBeLessThan(10)
    })
  }, 60_000)
})
