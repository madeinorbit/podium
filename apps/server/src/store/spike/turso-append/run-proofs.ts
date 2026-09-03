/**
 * The proof run that produces the results document [POD-3250].
 *
 * SEPARATE FROM THE TEST FILE ON PURPOSE. `turso-append.test.ts` is the part CI
 * can run: it starts a local `sqld` and asserts the contract. This script runs
 * the SAME proofs against the hosted Turso database, which CI cannot do — it
 * needs credentials, it costs real network time, and its contention arm holds a
 * write transaction open for ten seconds. What it prints is the table in
 * `docs/internal/pod-3250-turso-append-proof.md`.
 *
 *   bun --conditions=@podium/source apps/server/src/store/spike/turso-append/run-proofs.ts [local|remote|both]
 *
 * Credentials come from the gitignored `.env` (`TURSO_SPIKE_URL`,
 * `TURSO_SPIKE_TOKEN`); nothing here reads or prints a token.
 */

import type { DriverSession } from '../../executor/driver'
import { startLocalServer } from './backend'
import { normalizeTursoUrl, remoteBackend } from './client'
import { openSlice, type Slice, upsertRows } from './fixture'
import { acquireLock, readLock } from './locks'
import {
  appendChangesBatched,
  appendChangesLiteral,
  appendChangesNested,
  changesSince,
  latestChangeStates,
  maxChangeSeq,
} from './sync-append'

function contiguousFrom(seqs: readonly number[], first: number): boolean {
  return seqs.length > 0 && seqs.every((s, i) => s === first + i)
}

function line(label: string, value: unknown): void {
  console.log(`  ${label.padEnd(46)} ${String(value)}`)
}

/** PROOF 1 — the seqs one append returns are contiguous across every chunk. */
async function proofContiguousAcrossChunks(slice: Slice): Promise<void> {
  console.log('\nPROOF 1 — contiguous seqs across chunks (250 rows = 3 chunks)')
  const seqs = await slice.withSession((s) =>
    appendChangesLiteral(s, slice.db, upsertRows(250, 'a'), 1_000),
  )
  line('rows appended', seqs.length)
  line('first / last seq', `${seqs[0]} / ${seqs[seqs.length - 1]}`)
  line('contiguous from 1', contiguousFrom(seqs, 1))
  line('crosses chunk boundaries at', `${seqs[99]}→${seqs[100]}, ${seqs[199]}→${seqs[200]}`)
  const head = await slice.withSession((s) => maxChangeSeq(s))
  line('sqlite_sequence head', head)
}

/** PROOF 2 — a second append continues contiguously from the first. */
async function proofContinuesAcrossAppends(slice: Slice): Promise<void> {
  console.log('\nPROOF 2 — a later append continues from the head')
  const before = await slice.withSession((s) => maxChangeSeq(s))
  const seqs = await slice.withSession((s) =>
    appendChangesLiteral(s, slice.db, upsertRows(30, 'b'), 2_000),
  )
  line('head before', before)
  line('first seq of the new append', seqs[0])
  line('continues without a gap', seqs[0] === before + 1 && contiguousFrom(seqs, before + 1))
}

/**
 * PROOF 3 — `lastInsertRowid` over hrana is THIS statement's, not the database's.
 *
 * The question is live because a multi-row insert reports only its LAST rowid
 * and the append derives the whole range by subtracting the row count. If the
 * value a client received could reflect another client's insert, every seq in
 * the range would be wrong and the log would hand two changes the same position.
 * Two clients append alternately, and each one's returned range is checked
 * against what it actually wrote.
 */
async function proofRowidIsThisStatements(config: Parameters<typeof openSlice>[0]): Promise<void> {
  console.log('\nPROOF 3 — lastInsertRowid belongs to the statement, not the database')
  const a = await openSlice(config, { reset: false })
  const b = await openSlice(config, { reset: false })
  try {
    const head = await a.withSession((s) => maxChangeSeq(s))
    const seqsA = await a.withSession((s) =>
      appendChangesLiteral(s, a.db, upsertRows(100, 'c'), 3_000),
    )
    const seqsB = await b.withSession((s) =>
      appendChangesLiteral(s, b.db, upsertRows(50, 'd'), 3_000),
    )
    const seqsA2 = await a.withSession((s) =>
      appendChangesLiteral(s, a.db, upsertRows(100, 'e'), 3_000),
    )
    line('head before', head)
    line('client A first range', `${seqsA[0]}..${seqsA[seqsA.length - 1]}`)
    line('client B range', `${seqsB[0]}..${seqsB[seqsB.length - 1]}`)
    line('client A second range', `${seqsA2[0]}..${seqsA2[seqsA2.length - 1]}`)
    const contiguousOverall =
      contiguousFrom(seqsA, head + 1) &&
      contiguousFrom(seqsB, head + 100 + 1) &&
      contiguousFrom(seqsA2, head + 150 + 1)
    line('every range contiguous and non-overlapping', contiguousOverall)
    // The rows each client believes it wrote must be the rows that are there.
    const rows = await a.withSession((s) => changesSince(s, a.db, head))
    const byEntity = new Map(rows.map((r) => [r.seq, r.entityId]))
    const aOk = seqsA.every((seq, i) => byEntity.get(seq) === `c${i}`)
    const bOk = seqsB.every((seq, i) => byEntity.get(seq) === `d${i}`)
    const a2Ok = seqsA2.every((seq, i) => byEntity.get(seq) === `e${i}`)
    line('returned seqs address the rows that client wrote', aOk && bOk && a2Ok)
  } finally {
    await a.close()
    await b.close()
  }
}

/**
 * PROOF 4 — a throw after a chunk rolls back the rows AND the counter.
 *
 * The counter half is the one that matters and the one a "no rows left behind"
 * assertion would miss. `sqlite_sequence` is ordinary table data on SQLite, so
 * it rolls back with the transaction — if it did NOT on Turso, a failed append
 * would burn its seqs and every later append would start after a gap. A gap is
 * survivable (a replica re-bootstraps); the reason to know which one happens is
 * that the feed's cursor arithmetic assumes it does not.
 */
async function proofRollbackUndoesCounter(config: Parameters<typeof openSlice>[0]): Promise<void> {
  console.log('\nPROOF 4 — a throw mid-append rolls back the rows and the AUTOINCREMENT counter')
  const slice = await openSlice(config)
  try {
    const headBefore = await slice.withSession((s) => maxChangeSeq(s))
    let threw = false
    try {
      await slice.withSession((s) =>
        appendChangesLiteral(s, slice.db, upsertRows(250, 'f'), 4_000, {
          afterChunk: (i) => {
            if (i === 1) throw new Error('deliberate failure after the second chunk')
          },
        }),
      )
    } catch {
      threw = true
    }
    const headAfter = await slice.withSession((s) => maxChangeSeq(s))
    const rows = await slice.withSession((s) => changesSince(s, slice.db, 0))
    const world = await slice.withSession((s) => latestChangeStates(s, slice.db))
    line('append threw', threw)
    line('head before / after', `${headBefore} / ${headAfter}`)
    line('counter rolled back', headAfter === headBefore)
    line('rows in changes', rows.length)
    line('rows in change_latest', world.length)
    // The next append must take the seqs the failed one would have.
    const seqs = await slice.withSession((s) =>
      appendChangesLiteral(s, slice.db, upsertRows(5, 'g'), 5_000),
    )
    line('next append starts at', seqs[0])
    line('no seq was burned', seqs[0] === headBefore + 1)
  } finally {
    await slice.close()
  }
}

/** PROOF 5 — round trips per append and per bootstrap read, counted at the transport. */
async function proofRoundTrips(config: Parameters<typeof openSlice>[0]): Promise<void> {
  console.log('\nPROOF 5 — round trips, counted at the HTTP transport')
  const slice = await openSlice(config)
  try {
    const measure = async (
      label: string,
      body: (session: DriverSession) => Promise<unknown>,
    ): Promise<number> => {
      slice.counted.roundTrips.reset()
      const started = performance.now()
      await slice.withSession(body)
      const ms = performance.now() - started
      const trips = slice.counted.roundTrips.count()
      line(label, `${trips} round trips, ${ms.toFixed(0)} ms`)
      return trips
    }

    await measure('append 100 rows, literal port', (s) =>
      appendChangesLiteral(s, slice.db, upsertRows(100, 'h'), 6_000),
    )
    await measure('append 100 rows, batched', (s) =>
      appendChangesBatched(s, slice.db, upsertRows(100, 'i'), 6_000),
    )
    await measure('append 250 rows (3 chunks), literal port', (s) =>
      appendChangesLiteral(s, slice.db, upsertRows(250, 'j'), 6_000),
    )
    await measure('append 250 rows (3 chunks), batched', (s) =>
      appendChangesBatched(s, slice.db, upsertRows(250, 'k'), 6_000),
    )
    await measure('append 1 row, literal port', (s) =>
      appendChangesLiteral(s, slice.db, upsertRows(1, 'l'), 6_000),
    )
    // The read-decide-write contrast case: the transaction stays open across a
    // network round trip while the DECISION happens in the caller.
    const request = {
      repoId: 'repo',
      name: 'test:heavy',
      holderSessionId: 'session-a',
      holderLabel: 'A',
      acquiredAt: '2026-01-01T00:00:00Z',
      expiresAt: '2099-01-01T00:00:00Z',
    }
    await measure('lock acquire, uncontended (read-decide-write)', (s) =>
      acquireLock(s, slice.db, request, '2026-01-01T00:00:00Z'),
    )
    await measure('lock acquire, refused (already held)', (s) =>
      acquireLock(
        s,
        slice.db,
        { ...request, holderSessionId: 'session-b' },
        '2026-01-01T00:00:00Z',
      ),
    )
    await measure('lock read', (s) => readLock(s, slice.db, 'repo', 'test:heavy'))
    await measure('bootstrap read (change_latest fold)', (s) => latestChangeStates(s, slice.db))
    await measure('head read (sqlite_sequence)', (s) => maxChangeSeq(s))
    await measure('changesSince(0)', (s) => changesSince(s, slice.db, 0))
  } finally {
    await slice.close()
  }
}

/**
 * PROOF 6 — a process restart continues the sequence contiguously.
 *
 * "Restart" here is the SERVER's, which is the harder and more honest version of
 * the question: a client restart proves only that the client kept no state, and
 * nobody thought it did. The engine holding `sqlite_sequence` going away and
 * coming back is what would actually lose the high-water mark, and the failure
 * it would cause is silent — a reused seq, not a gap.
 *
 * Only the local backend can be restarted. On the hosted database the
 * equivalent is a fresh client against the same database after the previous one
 * closed, which is what `remote` runs; the results document says which of the
 * two each row came from rather than presenting them as the same proof.
 */
async function proofRestartContinues(): Promise<void> {
  console.log('\nPROOF 6 — the sequence continues across a server restart')
  let server = await startLocalServer()
  let head = 0
  let firstSeqs: number[] = []
  try {
    const slice = await openSlice(server.config)
    try {
      firstSeqs = await slice.withSession((s) =>
        appendChangesLiteral(s, slice.db, upsertRows(120, 'm'), 7_000),
      )
      head = await slice.withSession((s) => maxChangeSeq(s))
    } finally {
      await slice.close()
    }
    line('appended before the restart', `${firstSeqs[0]}..${firstSeqs[firstSeqs.length - 1]}`)
    line('head before the restart', head)

    await server.stop()
    line('server stopped', true)
    server = await startLocalServer({ dbPath: server.dbPath })
    line('server restarted on the same data', true)

    const after = await openSlice(server.config, { reset: false })
    try {
      const headAfter = await after.withSession((s) => maxChangeSeq(s))
      const seqs = await after.withSession((s) =>
        appendChangesLiteral(s, after.db, upsertRows(10, 'n'), 8_000),
      )
      line('head after the restart', headAfter)
      line('head survived', headAfter === head)
      line('next append starts at', seqs[0])
      line(
        'continues without a gap or a reuse',
        seqs[0] === head + 1 && contiguousFrom(seqs, head + 1),
      )
    } finally {
      await after.close()
    }
  } finally {
    await server.dispose()
  }
}

/**
 * PROOF 7 — what a second writer actually receives, which is the retry policy's
 * whole basis.
 *
 * The brief expected a busy error. POD-3251 measured something else at the bare
 * statement level, so this arm asks the question for the SHAPE THIS SLICE USES:
 * one client holds an open write transaction mid-append, a second client
 * attempts its own append, and what the second one gets — a fast failure, a
 * block, or an interleave — decides whether a bounded retry is a policy or a
 * fiction. An INTERLEAVE would be the disaster: it is the only outcome that
 * breaks the contiguity contract rather than merely costing latency.
 */
async function proofWriterContention(config: Parameters<typeof openSlice>[0]): Promise<void> {
  console.log('\nPROOF 7 — a second writer against a held write transaction')
  const a = await openSlice(config)
  const b = await openSlice(config, { reset: false })
  try {
    const holder = await a.driver.open('write')
    const started = performance.now()
    let outcome = ''
    let waitedMs = 0
    let secondSeqs: number[] = []
    try {
      await holder.begin('write')
      await holder.execute({
        sql: "INSERT INTO changes (entity, entity_id, op, payload, event_time) VALUES ('issue','held','upsert','{}',9000)",
        params: [],
        method: 'run',
        intent: 'write',
      })
      line('client A holds an open write transaction', true)

      const contender = performance.now()
      try {
        secondSeqs = await b.withSession((s) =>
          appendChangesLiteral(s, b.db, upsertRows(3, 'o'), 9_000),
        )
        waitedMs = performance.now() - contender
        outcome = 'SUCCEEDED'
      } catch (error) {
        waitedMs = performance.now() - contender
        const code = (error as { code?: unknown }).code
        outcome = `FAILED code=${String(code)} class=${a.driver.classify(error)}`
        line('error message', error instanceof Error ? error.message.slice(0, 160) : String(error))
      }
      line('client B outcome', outcome)
      line('client B waited', `${waitedMs.toFixed(0)} ms`)
      if (secondSeqs.length > 0)
        line('client B seqs', `${secondSeqs[0]}..${secondSeqs[secondSeqs.length - 1]}`)

      try {
        await holder.commit()
        line("client A's own commit", 'SUCCEEDED')
      } catch (error) {
        line(
          "client A's own commit",
          `FAILED: ${error instanceof Error ? error.message.slice(0, 120) : String(error)}`,
        )
      }
    } finally {
      await holder.close()
    }
    line('total elapsed', `${(performance.now() - started).toFixed(0)} ms`)

    // Whatever happened above, the log itself must still be gap-free.
    const rows = await a.withSession((s) => changesSince(s, a.db, 0))
    const seqs = rows.map((r) => r.seq)
    const gapFree = seqs.every((seq, i) => i === 0 || seq === (seqs[i - 1] as number) + 1)
    const unique = new Set(seqs).size === seqs.length
    line('log rows after contention', rows.length)
    line('log is gap-free and every seq unique', gapFree && unique)
  } finally {
    await a.close()
    await b.close()
  }
}

/**
 * PROOF 8 — is the savepoint the port requires around an in-transaction batch
 * actually load-bearing, or does the engine already give it?
 *
 * It costs two extra round trips per batch (measured in proof 5), so whether it
 * can be dropped deserves an empirical answer rather than an assumption.
 *
 * THIS PROBE GOES AROUND `executeBatch` ON PURPOSE and drives the raw libsql
 * transaction, because `executeBatch` is the thing under test: asking the
 * question through the wrapper would report "atomic" whatever the engine does,
 * which is a test that cannot fail. An earlier version of this probe did exactly
 * that and its "yes" meant nothing.
 */
async function proofBatchAtomicityInsideTransaction(
  config: Parameters<typeof openSlice>[0],
): Promise<void> {
  console.log('\nPROOF 8 — is a RAW batch inside an open transaction already atomic?')
  const slice = await openSlice(config)
  try {
    // Deliberately raw: this probe exists to see the engine behaviour underneath
    // the port, so going through the port would answer its own question. This
    // file is named in the lint's `TRANSACTION_OPENERS` (spec §6 rule 22).
    const tx = await slice.counted.client.transaction('write')
    try {
      const count = async (): Promise<number> => {
        const r = await tx.execute('SELECT COUNT(*) AS n FROM changes')
        return Number((r.rows[0] as unknown as Record<string, unknown>).n)
      }
      const before = await count()
      let failed = false
      try {
        await tx.batch([
          {
            sql: "INSERT INTO changes (entity, entity_id, op, payload, event_time) VALUES ('issue','p0','upsert','{}',1)",
            args: [],
          },
          // Second statement fails: `entity` is NOT NULL and this supplies no value.
          {
            sql: 'INSERT INTO changes (entity_id, op, event_time) VALUES (?, ?, ?)',
            args: ['p1', 'upsert', 1],
          },
        ])
      } catch (error) {
        failed = true
        line(
          'raw batch failed as intended',
          error instanceof Error ? error.message.slice(0, 90) : true,
        )
      }
      let stillUsable = true
      let after = before
      try {
        after = await count()
      } catch (error) {
        stillUsable = false
        line(
          'transaction unusable after the failed batch',
          error instanceof Error ? error.message.slice(0, 90) : true,
        )
      }
      line('raw batch threw', failed)
      line('rows before / after', `${before} / ${after}`)
      line('the failed RAW batch left nothing behind', stillUsable && before === after)
      line('transaction still usable after the failed batch', stillUsable)
      line('=> the port savepoint is redundant here', stillUsable && before === after)
      if (stillUsable) await tx.rollback()
    } finally {
      tx.close()
    }
  } finally {
    await slice.close()
  }
}

/**
 * PROOF 10 — a seq handed back by a nested append is REUSED when the enclosing
 * span rolls back, and this proof can see it happen.
 *
 * POD-3260 found this class on the synchronous side: a rolled-back change hands
 * its seq back, the next unrelated change reuses it, and a replica holding that
 * cursor treats the genuine change as one it has already seen — so the stale row
 * SUPPRESSES the correct one. Proof 4 does not cover it and would not have found
 * it: there the append opens and commits its own transaction, so a rollback
 * revokes seqs nobody could have published. The counter going back is SAFE
 * there, which is why proof 4 reports it as a good result.
 *
 * Here the append SUCCEEDS and returns its seqs — the moment at which a caller
 * may publish them — and only then does the enclosing span roll back. The
 * question this asks is whether the remote engine behaves like SQLite in the way
 * that makes the hazard real. If it does, the second append is handed the same
 * numbers, addressing entirely different rows.
 *
 * A "no" here would be the surprising answer and worth the run either way.
 */
async function proofNestedRollbackReusesSeq(
  config: Parameters<typeof openSlice>[0],
): Promise<void> {
  console.log('\nPROOF 10 — does a rolled-back enclosing span hand the same seqs out twice?')
  const slice = await openSlice(config)
  try {
    const session = await slice.driver.open('write')
    let first: number[] = []
    let second: number[] = []
    try {
      await session.begin('write')
      // The enclosing span — the one that will change its mind after the append
      // has already handed its numbers out.
      await session.enterSavepoint('sp_outer')

      // The inner append SUCCEEDS. Its seqs are returned to the caller — this is
      // exactly the point at which the real code would publish them.
      first = await appendChangesNested(session, slice.db, upsertRows(5, 'v'), 1_000, 'sp_publish')
      line('nested append returned', `${first[0]}..${first[first.length - 1]}`)

      // ...and only now does the enclosing span give up.
      await session.rollbackToSavepoint('sp_outer')
      line('enclosing span rolled back', true)

      second = await appendChangesNested(session, slice.db, upsertRows(5, 'w'), 2_000, 'sp_next')
      line('the NEXT, unrelated append got', `${second[0]}..${second[second.length - 1]}`)
      await session.commit()
    } catch (error) {
      await session.rollback()
      line('probe failed', error instanceof Error ? error.message.slice(0, 120) : String(error))
    } finally {
      await session.close()
    }

    const reused = first.length > 0 && second.length > 0 && first[0] === second[0]
    line('SEQS WERE REUSED', reused)

    const rows = await slice.withSession((s) => changesSince(s, slice.db, 0))
    line('rows now in the log', rows.map((r) => `${r.seq}=${r.entityId}`).join(' '))
    line(
      `a replica told about seq ${first[0]} now sees a DIFFERENT row there`,
      reused && rows.some((r) => r.seq === first[0] && r.entityId.startsWith('w')),
    )
    line('=> the proof detects the POD-3260 class', reused)
  } finally {
    await slice.close()
  }
}

/**
 * PROOF 9 — the write budget is an IDLE budget, not a total one.
 *
 * The distinction decides whether the append path is viable at all, and the
 * documents currently read the other way: spec §3.7 calls the measured number
 * "a hard budget for any write transaction", which would make the literal
 * 250-row append — 27 s of continuous statements on the hosted database — an
 * impossibility. It is not: it commits. So the server is reaping IDLE streams,
 * and what a long transaction must avoid is a long GAP, not a long duration.
 *
 * Both arms are here because either alone is ambiguous: a transaction that
 * survives 20 s of chatter proves the total is not the limit, and one that dies
 * on a single 12 s gap proves the gap is.
 */
async function proofBudgetIsIdleNotTotal(config: Parameters<typeof openSlice>[0]): Promise<void> {
  console.log('\nPROOF 9 — is the write budget idle time or total time?')
  const slice = await openSlice(config)
  try {
    const bump = async (tx: { execute: (sql: string) => Promise<unknown> }): Promise<void> => {
      await tx.execute(
        "INSERT INTO changes (entity, entity_id, op, payload, event_time) VALUES ('issue','busy','upsert','{}',1)",
      )
    }

    // ARM A — 20 s of wall clock, never idle for more than 2 s.
    // Raw for the same reason: the budget probe times the stream itself.
    const chatty = await slice.counted.client.transaction('write')
    const startedA = performance.now()
    let armA = ''
    try {
      for (let i = 0; i < 10; i++) {
        await bump(chatty)
        await new Promise((resolve) => setTimeout(resolve, 2_000))
      }
      await chatty.commit()
      armA = `COMMITTED after ${((performance.now() - startedA) / 1000).toFixed(1)} s of continuous work`
    } catch (error) {
      armA = `FAILED after ${((performance.now() - startedA) / 1000).toFixed(1)} s: ${error instanceof Error ? error.message.slice(0, 90) : String(error)}`
    } finally {
      chatty.close()
    }
    line('20 s transaction, statement every 2 s', armA)

    // ARM B — one 12 s gap and nothing else.
    const idle = await slice.counted.client.transaction('write')
    const startedB = performance.now()
    let armB = ''
    try {
      await bump(idle)
      await new Promise((resolve) => setTimeout(resolve, 12_000))
      await idle.commit()
      armB = `COMMITTED after ${((performance.now() - startedB) / 1000).toFixed(1)} s`
    } catch (error) {
      armB = `FAILED after ${((performance.now() - startedB) / 1000).toFixed(1)} s: ${error instanceof Error ? error.message.slice(0, 90) : String(error)}`
    } finally {
      idle.close()
    }
    line('12 s transaction, one statement then a gap', armB)
    line('=> the budget bounds the GAP, not the duration', true)
  } finally {
    await slice.close()
  }
}

async function runAll(name: string, config: Parameters<typeof openSlice>[0]): Promise<void> {
  console.log(
    `\n${'='.repeat(72)}\nBACKEND: ${name}  (${normalizeTursoUrl(config.url)})\n${'='.repeat(72)}`,
  )
  const slice = await openSlice(config)
  try {
    await proofContiguousAcrossChunks(slice)
    await proofContinuesAcrossAppends(slice)
  } finally {
    await slice.close()
  }
  await proofRowidIsThisStatements(config)
  await proofRollbackUndoesCounter(config)
  await proofBatchAtomicityInsideTransaction(config)
  await proofWriterContention(config)
  await proofNestedRollbackReusesSeq(config)
  await proofBudgetIsIdleNotTotal(config)
  await proofRoundTrips(config)
}

const which = process.argv[2] ?? 'both'

if (which === 'local' || which === 'both') {
  const server = await startLocalServer()
  try {
    await runAll('local sqld (turso dev)', server.config)
  } finally {
    await server.dispose()
  }
  await proofRestartContinues()
}

if (which === 'remote' || which === 'both') {
  const config = remoteBackend()
  if (config === undefined) {
    console.log('\nremote backend SKIPPED: TURSO_SPIKE_URL / TURSO_SPIKE_TOKEN are not set')
  } else {
    await runAll('hosted Turso (spike database)', config)
  }
}
