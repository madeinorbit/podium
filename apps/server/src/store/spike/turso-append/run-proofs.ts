/**
 * The proof run that produces the results document [POD-3250], and — since
 * [POD-3357] — a gate whose EXIT CODE carries the verdict.
 *
 * SEPARATE FROM THE TEST FILE ON PURPOSE. `turso-append.integration.test.ts` is
 * the part CI can run: it starts a local `sqld` and asserts the contract. This
 * script runs the SAME proofs against the hosted Turso database, which CI cannot
 * do — it needs credentials, it costs real network time, and its contention arm
 * holds a write transaction open for ten seconds. What it prints is the table in
 * `docs/internal/pod-3250-turso-append-proof.md`.
 *
 *   bun --conditions=@podium/source apps/server/src/store/spike/turso-append/run-proofs.ts [local|remote|both]
 *
 * WHY IT NOW EXITS NON-ZERO [POD-3357]. Until this change the file was thirteen
 * `console.log` calls and nothing else: no assertion, no aggregate, no exit
 * code. It printed `contiguous from 1  false` exactly as readably as it printed
 * `true`, and returned 0 either way. That is a transcript, not a proof — and two
 * LANDED rules cite numbers only this script can observe (spec §6 rule 7's
 * idle-versus-duration budget, from proofs 9 and 11; rule 24's round-trip
 * counts, from proof 5). Nothing would have told us if they stopped being true.
 * So every printed invariant is now a CHECKED one, the narrative output is
 * unchanged in kind, and the verdict is the exit status.
 *
 * MEASUREMENTS ARE PRINTED, INVARIANTS ARE CHECKED, and the line between them is
 * deliberate. Round-trip COUNTS are a property of the shape and are asserted;
 * the MILLISECONDS beside them are a property of the network and are not. The
 * recorded hosted figures in the results document were measured from GERMANY
 * against `aws-us-east-1`; in production Fly IAD sits in the same metro as that
 * region, where a statement costs roughly 3–5 ms rather than the ~95 ms those
 * numbers show. Asserting on them would gate the epic on the operator's
 * location.
 *
 * EXIT CODES, and why a skip is not 0 — see `EXIT_SKIPPED` below.
 *
 * Credentials come from the gitignored `.env` (`TURSO_SPIKE_URL`,
 * `TURSO_SPIKE_TOKEN`); nothing here reads or prints a token.
 */

import type { DriverSession, Statement } from '../../executor/driver'
import { createScheduler, type WatchdogReport } from '../../executor/scheduler'
import { startLocalServer } from './backend'
import { normalizeTursoUrl, remoteBackend } from './client'
import { openSlice, type Slice, upsertRows } from './fixture'
import { acquireLock, readLock } from './locks'
import { acquireRunLease, refusalBanner, sweepAbandonedNamespaces } from './run-lease'
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

/* ------------------------------------------------------------------------- *
 * THE VERDICT HARNESS [POD-3357]
 * ------------------------------------------------------------------------- */

/**
 * Exit codes, and the one judgement call this issue left open.
 *
 * A run that cannot take the hosted lease [POD-3358] prints a banner naming the
 * holder and does not measure. The question is whether that skip should exit 0.
 *
 * IT SHOULD NOT, AND IT MUST NOT BE 1 EITHER. Exiting 0 is the exact shape this
 * issue exists to remove: a run that did nothing, reporting success, quiet in
 * CI — the hosted proofs could stop running altogether and every board stays
 * green. But collapsing it into 1 recreates the same conflation pointing the
 * other way, because "somebody else is using the database" is an honest,
 * expected, self-healing condition and "the AUTOINCREMENT counter no longer
 * rolls back" is a landed rule turning false. A caller that cannot tell them
 * apart will learn to ignore whichever is louder, and on this database the
 * frequent one is the skip — so the rare, important one is what gets ignored.
 *
 * So: THREE codes. 0 held, 1 an invariant failed, 3 nothing was measured. A CI
 * job can retry 3 later and page on 1, which is precisely the distinction, and
 * neither one is silent.
 */
const EXIT_OK = 0
const EXIT_FAILED = 1
const EXIT_SKIPPED = 3
/** An injection was requested and never reached its site — see `broken`. */
const EXIT_INJECTION_UNUSED = 4

/**
 * DELIBERATE BREAKAGE, which is what makes the checks above evidence [POD-3357].
 *
 * A check that has never been watched to FAIL is not known to be wired to
 * anything — this epic has now caught three that were not, and the most recent
 * read a `fetch` body the client never sets, so it passed vacuously while
 * looking rigorous. The remedy is the one POD-3358 used: an environment variable
 * that changes the MEASURED SYSTEM (not the assertion's input) at one named
 * site, so the run can be watched saying no.
 *
 *   PODIUM_SPIKE_BREAK=<id>   inject that defect
 *   PODIUM_SPIKE_ONLY=1,4     run only those proofs, so a defeat run is cheap
 *
 * Every injection perturbs the MECHANISM: it burns a seq, commits before the
 * failure, widens a gap, releases a savepoint instead of rolling it back. None
 * of them edits a boolean on its way to `check`, because an injection that did
 * would prove only that `check` can print the word FAIL.
 *
 * AND AN UNAPPLIED INJECTION IS ITSELF A FAILURE. If the id never reaches its
 * site — a typo, the wrong proof selected, a site that moved — the run would be
 * green and a reader would conclude the check is fine. `EXIT_INJECTION_UNUSED`
 * exists so that cannot happen quietly. `defeat-check.ts` drives the matrix.
 */
const injectedBreak = process.env.PODIUM_SPIKE_BREAK
const appliedBreaks = new Set<string>()
function broken(id: string): boolean {
  if (injectedBreak !== id) return false
  appliedBreaks.add(id)
  return true
}

interface Invariant {
  readonly proof: string
  readonly label: string
  readonly ok: boolean
  readonly got: string
}

const invariants: Invariant[] = []
let currentProof = '(no proof)'

/** A measurement or a piece of narrative. Printed, never judged. */
function line(label: string, value: unknown): void {
  console.log(`       ${label.padEnd(46)} ${String(value)}`)
}

/**
 * An invariant. Printed exactly as readably as `line`, and recorded.
 *
 * `got` is printed rather than a bare pass/fail because the number IS the
 * result — a reader of this transcript wants "254 round trips", not "ok".
 */
function check(label: string, ok: boolean, got: unknown = ok, want = 'true'): boolean {
  invariants.push({ proof: currentProof, label, ok, got: String(got) })
  const tail = ok ? '' : `   <-- expected ${want}`
  console.log(`  ${ok ? ' ok ' : 'FAIL'} ${label.padEnd(46)} ${String(got)}${tail}`)
  return ok
}

/**
 * Run one proof, and hold it to the number of invariants it promised.
 *
 * THE COUNT GUARD IS NOT BOOKKEEPING. A proof that throws — or returns early
 * down a branch nobody expected — records fewer checks than it has, and every
 * check it DID record can still be green. The aggregate would then report
 * success for a proof that never asked its question, which is the same vacuity
 * in a smaller box. So each proof declares its count and is failed for missing
 * it, and a throw is recorded as a failed invariant rather than killing the run
 * and losing the backends still to come.
 */
async function runProof(title: string, expects: number, body: () => Promise<void>): Promise<void> {
  if (selectedProofs !== undefined) {
    const n = Number(title.replace(/^PROOF (\d+).*$/s, '$1'))
    if (!selectedProofs.has(n)) return
  }
  currentProof = title
  console.log(`\n${title}`)
  const before = invariants.length
  let crashed: string | undefined
  try {
    await body()
  } catch (error) {
    crashed = error instanceof Error ? error.message.slice(0, 200) : String(error)
  }
  const recorded = invariants.length - before
  if (crashed !== undefined) check('the proof ran to completion', false, `threw: ${crashed}`, 'no throw')
  else check(`reached all ${expects} invariants`, recorded === expects, recorded, String(expects))
}

/** `PODIUM_SPIKE_ONLY=5,9` — run a subset, so one defeat run is not six minutes. */
const selectedProofs =
  process.env.PODIUM_SPIKE_ONLY === undefined
    ? undefined
    : new Set(process.env.PODIUM_SPIKE_ONLY.split(',').map((n) => Number(n.trim())))

/**
 * The defect injected into proofs 1 and 3: one stray row appended BETWEEN two
 * chunks, on the same session, inside the append's own transaction [POD-3357].
 *
 * This is the realistic shape of the failure those proofs exist to catch —
 * something consuming a seq that the append does not account for — and it
 * perturbs the DATABASE rather than the assertion: the append still derives its
 * range from `lastInsertRowid` exactly as it always did, and the range it
 * derives is now wrong about the world. A stray row cannot be argued away as
 * the check being told what to say.
 */
function burnSeqBetweenChunks(session: DriverSession, prefix: string) {
  return {
    afterChunk: async (): Promise<void> => {
      await session.execute({
        sql: `INSERT INTO ${prefix}changes (entity, entity_id, op, payload, event_time) VALUES ('issue','stray','upsert','{}',1)`,
        params: [],
        method: 'run' as const,
        intent: 'write' as const,
      })
    },
  }
}

/** PROOF 1 — the seqs one append returns are contiguous across every chunk. */
async function proofContiguousAcrossChunks(slice: Slice): Promise<void> {
  const seqs = await slice.withSession((s) =>
    appendChangesLiteral(
      s,
      slice.db,
      slice.tables,
      upsertRows(250, 'a'),
      1_000,
      broken('seq-burned') ? burnSeqBetweenChunks(s, slice.prefix) : {},
    ),
  )
  line('first / last seq', `${seqs[0]} / ${seqs[seqs.length - 1]}`)
  line('crosses chunk boundaries at', `${seqs[99]}→${seqs[100]}, ${seqs[199]}→${seqs[200]}`)
  check('rows appended', seqs.length === 250, seqs.length, '250')
  check('contiguous from 1', contiguousFrom(seqs, 1))
  const head = await slice.withSession((s) => maxChangeSeq(s, slice.tables))
  check('sqlite_sequence head is the last seq handed out', head === seqs[seqs.length - 1], head, String(seqs[seqs.length - 1]))
}

/** PROOF 2 — a second append continues contiguously from the first. */
async function proofContinuesAcrossAppends(slice: Slice): Promise<void> {
  const before = await slice.withSession((s) => maxChangeSeq(s, slice.tables))
  const seqs = await slice.withSession((s) =>
    appendChangesLiteral(s, slice.db, slice.tables, upsertRows(30, 'b'), 2_000),
  )
  line('head before', before)
  line('first seq of the new append', seqs[0])
  check(
    'continues without a gap',
    seqs[0] === before + 1 && contiguousFrom(seqs, before + 1),
    `${seqs[0]}..${seqs[seqs.length - 1]}`,
    `${before + 1}..${before + seqs.length}`,
  )
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
  const a = await openSlice(config, { reset: false })
  const b = await openSlice(config, { reset: false })
  try {
    const head = await a.withSession((s) => maxChangeSeq(s, a.tables))
    const seqsA = await a.withSession((s) =>
      appendChangesLiteral(
        s,
        a.db,
        a.tables,
        upsertRows(100, 'c'),
        3_000,
        broken('seq-burned') ? burnSeqBetweenChunks(s, a.prefix) : {},
      ),
    )
    const seqsB = await b.withSession((s) =>
      appendChangesLiteral(s, b.db, b.tables, upsertRows(50, 'd'), 3_000),
    )
    const seqsA2 = await a.withSession((s) =>
      appendChangesLiteral(s, a.db, a.tables, upsertRows(100, 'e'), 3_000),
    )
    line('head before', head)
    line('client A first range', `${seqsA[0]}..${seqsA[seqsA.length - 1]}`)
    line('client B range', `${seqsB[0]}..${seqsB[seqsB.length - 1]}`)
    line('client A second range', `${seqsA2[0]}..${seqsA2[seqsA2.length - 1]}`)
    const contiguousOverall =
      contiguousFrom(seqsA, head + 1) &&
      contiguousFrom(seqsB, head + 100 + 1) &&
      contiguousFrom(seqsA2, head + 150 + 1)
    check(
      'every range contiguous and non-overlapping',
      contiguousOverall,
      `${head + 1}.. expected, got ${seqsA[0]}/${seqsB[0]}/${seqsA2[0]}`,
      `${head + 1}/${head + 101}/${head + 151}`,
    )
    // The rows each client believes it wrote must be the rows that are there.
    // THIS is the assertion proof 3 exists for, and the one a contiguity check
    // alone would fake: if `lastInsertRowid` were the DATABASE's last insert
    // rather than this statement's, every range above would still look
    // perfectly contiguous — it would simply address the other client's rows.
    const rows = await a.withSession((s) => changesSince(s, a.db, a.tables, head))
    const byEntity = new Map(rows.map((r) => [r.seq, r.entityId]))
    const aOk = seqsA.every((seq, i) => byEntity.get(seq) === `c${i}`)
    const bOk = seqsB.every((seq, i) => byEntity.get(seq) === `d${i}`)
    const a2Ok = seqsA2.every((seq, i) => byEntity.get(seq) === `e${i}`)
    check('returned seqs address the rows that client wrote', aOk && bOk && a2Ok, `A=${aOk} B=${bOk} A2=${a2Ok}`)
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
  const slice = await openSlice(config)
  try {
    const headBefore = await slice.withSession((s) => maxChangeSeq(s, slice.tables))
    let threw = false
    try {
      await slice.withSession((s) =>
        appendChangesLiteral(s, slice.db, slice.tables, upsertRows(250, 'f'), 4_000, {
          afterChunk: async (i) => {
            if (i !== 1) return
            // THE INJECTED DEFECT [POD-3357]: commit what the first two chunks
            // did before failing, which is what an append that did not own its
            // transaction would effectively do. The throw still happens, so
            // `append threw` stays green — and the three invariants that
            // actually matter go red, which is the point.
            if (broken('no-rollback')) await s.commit()
            throw new Error('deliberate failure after the second chunk')
          },
        }),
      )
    } catch {
      threw = true
    }
    const headAfter = await slice.withSession((s) => maxChangeSeq(s, slice.tables))
    const rows = await slice.withSession((s) => changesSince(s, slice.db, slice.tables, 0))
    const world = await slice.withSession((s) => latestChangeStates(s, slice.db, slice.tables))
    line('head before / after', `${headBefore} / ${headAfter}`)
    check('append threw', threw)
    // The half that matters, and the half a "no rows left behind" assertion
    // would miss: `sqlite_sequence` is ordinary table data on SQLite, so it
    // rolls back with the transaction. If it did not, a failed append would burn
    // its seqs and every later append would start after a gap.
    check('counter rolled back', headAfter === headBefore, headAfter, String(headBefore))
    check('no rows survived in changes', rows.length === 0, rows.length, '0')
    check('no rows survived in change_latest', world.length === 0, world.length, '0')
    // The next append must take the seqs the failed one would have.
    const seqs = await slice.withSession((s) =>
      appendChangesLiteral(s, slice.db, slice.tables, upsertRows(5, 'g'), 5_000),
    )
    check('no seq was burned — next append starts at', seqs[0] === headBefore + 1, seqs[0], String(headBefore + 1))
  } finally {
    await slice.close()
  }
}

/** PROOF 5 — round trips per append and per bootstrap read, counted at the transport. */
async function proofRoundTrips(config: Parameters<typeof openSlice>[0]): Promise<void> {
  const slice = await openSlice(config)
  try {
    /**
     * Measure one shape, and hold it to the round-trip count rule 24 cites.
     *
     * THE COUNT IS ASSERTED AND THE MILLISECONDS ARE NOT, deliberately. The
     * counts are a property of the SHAPE — `rows + chunks + 1` literal,
     * `6 × chunks + 1` batched — and are identical on both engines, so a change
     * in one is a change in the code and belongs in a gate. The milliseconds are
     * a property of the network the operator happens to be on: the recorded
     * hosted figures were taken from Germany, and the same statements from Fly
     * IAD, in the same metro as the `aws-us-east-1` database, cost roughly 3–5 ms
     * each. An assertion on those would fail for the wrong reason every time.
     */
    const measure = async (
      label: string,
      expected: number,
      body: (session: DriverSession) => Promise<unknown>,
    ): Promise<void> => {
      slice.counted.roundTrips.reset()
      const started = performance.now()
      await slice.withSession(async (session) => {
        const result = await body(session)
        // THE INJECTED DEFECT [POD-3357]: one more statement inside the measured
        // window. This is exactly the regression rule 24's counts exist to
        // catch — a read slipped into a path that was supposed to be blind — and
        // it moves the transport counter rather than the assertion's input.
        if (broken('roundtrip-extra')) await maxChangeSeq(session, slice.tables)
        return result
      })
      const ms = performance.now() - started
      const trips = slice.counted.roundTrips.count()
      check(label, trips === expected, `${trips} round trips, ${ms.toFixed(0)} ms`, `${expected} round trips`)
    }

    // Literal port: rows + chunks + 1. Batched: 6 × chunks + 1.
    await measure('append 100 rows, literal port', 102, (s) =>
      appendChangesLiteral(s, slice.db, slice.tables, upsertRows(100, 'h'), 6_000),
    )
    await measure('append 100 rows, batched', 7, (s) =>
      appendChangesBatched(s, slice.db, slice.tables, upsertRows(100, 'i'), 6_000),
    )
    await measure('append 250 rows (3 chunks), literal port', 254, (s) =>
      appendChangesLiteral(s, slice.db, slice.tables, upsertRows(250, 'j'), 6_000),
    )
    await measure('append 250 rows (3 chunks), batched', 19, (s) =>
      appendChangesBatched(s, slice.db, slice.tables, upsertRows(250, 'k'), 6_000),
    )
    await measure('append 1 row, literal port', 3, (s) =>
      appendChangesLiteral(s, slice.db, slice.tables, upsertRows(1, 'l'), 6_000),
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
    await measure('lock acquire, uncontended (read-decide-write)', 3, (s) =>
      acquireLock(s, slice.db, slice.tables, request, '2026-01-01T00:00:00Z'),
    )
    await measure('lock acquire, refused (already held)', 2, (s) =>
      acquireLock(
        s,
        slice.db, slice.tables,
        { ...request, holderSessionId: 'session-b' },
        '2026-01-01T00:00:00Z',
      ),
    )
    await measure('lock read', 1, (s) => readLock(s, slice.db, slice.tables, 'repo', 'test:heavy'))
    await measure('bootstrap read (change_latest fold)', 1, (s) => latestChangeStates(s, slice.db, slice.tables))
    await measure('head read (sqlite_sequence)', 1, (s) => maxChangeSeq(s, slice.tables))
    await measure('changesSince(0)', 1, (s) => changesSince(s, slice.db, slice.tables, 0))
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
  let server = await startLocalServer()
  let head = 0
  let firstSeqs: number[] = []
  try {
    const slice = await openSlice(server.config)
    try {
      firstSeqs = await slice.withSession((s) =>
        appendChangesLiteral(s, slice.db, slice.tables, upsertRows(120, 'm'), 7_000),
      )
      head = await slice.withSession((s) => maxChangeSeq(s, slice.tables))
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
      const headAfter = await after.withSession((s) => maxChangeSeq(s, after.tables))
      const seqs = await after.withSession((s) =>
        appendChangesLiteral(s, after.db, after.tables, upsertRows(10, 'n'), 8_000),
      )
      check('head survived the restart', headAfter === head, headAfter, String(head))
      check(
        'continues without a gap or a reuse',
        seqs[0] === head + 1 && contiguousFrom(seqs, head + 1),
        `${seqs[0]}..${seqs[seqs.length - 1]}`,
        `${head + 1}..${head + seqs.length}`,
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
        sql: `INSERT INTO ${a.prefix}changes (entity, entity_id, op, payload, event_time) VALUES ('issue','held','upsert','{}',9000)`,
        params: [],
        method: 'run',
        intent: 'write',
      })
      // THE INJECTED DEFECT [POD-3357]: A lets go of the write lock before B
      // arrives, so there is no contention to measure. The proof still runs and
      // still prints, and the three findings that describe contention go red —
      // which is the honest outcome, because a proof about a second writer with
      // nothing to contend against has measured nothing.
      const holds = !broken('contention-none')
      if (!holds) await holder.commit()
      check('client A holds an open write transaction', holds)

      const contender = performance.now()
      try {
        secondSeqs = await b.withSession((s) =>
          appendChangesLiteral(s, b.db, b.tables, upsertRows(3, 'o'), 9_000),
        )
        waitedMs = performance.now() - contender
        outcome = 'SUCCEEDED'
      } catch (error) {
        waitedMs = performance.now() - contender
        const code = (error as { code?: unknown }).code
        outcome = `FAILED code=${String(code)} class=${a.driver.classify(error)}`
        line('error message', error instanceof Error ? error.message.slice(0, 160) : String(error))
      }
      if (secondSeqs.length > 0)
        line('client B seqs', `${secondSeqs[0]}..${secondSeqs[secondSeqs.length - 1]}`)
      // The brief expected a fast busy error. There is none: B BLOCKS for the
      // holder's whole idle window and then wins. Both halves are asserted,
      // because "SUCCEEDED" alone is also what an uncontended append prints —
      // it is the waiting that makes this a contention result at all.
      check('client B succeeded rather than getting a busy error', outcome === 'SUCCEEDED', outcome, 'SUCCEEDED')
      check('client B BLOCKED on the holder (>= 1 s)', waitedMs >= 1_000, `${waitedMs.toFixed(0)} ms`, '>= 1000 ms')

      let commitOutcome: string
      if (holds) {
        try {
          await holder.commit()
          commitOutcome = 'SUCCEEDED'
        } catch (error) {
          commitOutcome = `FAILED: ${error instanceof Error ? error.message.slice(0, 120) : String(error)}`
        }
      } else {
        commitOutcome = 'SUCCEEDED (committed early, before B arrived)'
      }
      // The loser is the HOLDER, and it loses everything it had done. This is
      // what spec §6 rule 7 is priced against: a write transaction that pauses
      // is charging every other writer for the pause and then dying itself.
      check("client A's own commit failed — the holder is the loser", commitOutcome.startsWith('FAILED'), commitOutcome, 'FAILED')
    } finally {
      await holder.close()
    }
    line('total elapsed', `${(performance.now() - started).toFixed(0)} ms`)

    // Whatever happened above, the log itself must still be gap-free. An
    // INTERLEAVE is the only outcome that breaks the feed contract rather than
    // merely costing latency, so this is the invariant of the proof.
    //
    // THE INJECTED DEFECT [POD-3357] deletes one row before the check reads the
    // log. Named for what it is: this perturbs the DATA rather than the engine,
    // because nothing available here can make the engine interleave two
    // writers. What it establishes is that the check reads the real table and
    // would see a gap that was really there — not that the engine could produce
    // one. That distinction is in the defeat list rather than papered over.
    if (broken('log-gap')) {
      await a.counted.client.execute(
        `DELETE FROM ${a.prefix}changes WHERE seq = (SELECT MIN(seq) + 1 FROM ${a.prefix}changes)`,
      )
    }
    const rows = await a.withSession((s) => changesSince(s, a.db, a.tables, 0))
    const seqs = rows.map((r) => r.seq)
    const gapFree = seqs.every((seq, i) => i === 0 || seq === (seqs[i - 1] as number) + 1)
    const unique = new Set(seqs).size === seqs.length
    line('log rows after contention', rows.length)
    check('log is gap-free and every seq unique', gapFree && unique, `gapFree=${gapFree} unique=${unique}`)
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
  const slice = await openSlice(config)
  try {
    // Deliberately raw: this probe exists to see the engine behaviour underneath
    // the port, so going through the port would answer its own question. This
    // file is named in the lint's `TRANSACTION_OPENERS` (spec §6 rule 22).
    const tx = await slice.counted.client.transaction('write')
    try {
      const count = async (): Promise<number> => {
        const r = await tx.execute(`SELECT COUNT(*) AS n FROM ${slice.prefix}changes`)
        return Number((r.rows[0] as unknown as Record<string, unknown>).n)
      }
      const before = await count()
      let failed = false
      // THE INJECTED DEFECT [POD-3357]: wrap the raw batch in the very savepoint
      // the port adds, which makes the engine atomic here and so makes the
      // recorded finding false. It changes what the ENGINE does, not what the
      // check reads — and it is the one perturbation that could plausibly arrive
      // for real, as a libsql release that started wrapping batches itself.
      const guarded = broken('batch-atomic')
      if (guarded) await tx.execute('SAVEPOINT injected_guard')
      try {
        await tx.batch([
          {
            sql: `INSERT INTO ${slice.prefix}changes (entity, entity_id, op, payload, event_time) VALUES ('issue','p0','upsert','{}',1)`,
            args: [],
          },
          // Second statement fails: `entity` is NOT NULL and this supplies no value.
          {
            sql: `INSERT INTO ${slice.prefix}changes (entity_id, op, event_time) VALUES (?, ?, ?)`,
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
      if (guarded) await tx.execute('ROLLBACK TO injected_guard').catch(() => {})
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
      line('rows before / after', `${before} / ${after}`)
      check('raw batch threw', failed)
      // The recorded finding is that the raw batch is NOT atomic: the first
      // statement stayed applied. That is why the port's savepoint is a
      // requirement rather than a precaution, and why it is priced in proof 5
      // at four of the six round trips a batched chunk costs.
      check("the failed RAW batch left its first statement applied", after === before + 1, `${before} -> ${after}`, `${before} -> ${before + 1}`)
      check('transaction still usable after the failed batch', stillUsable)
      check('=> the port savepoint is LOAD-BEARING, not redundant', stillUsable && after !== before, `atomic=${after === before}`, 'atomic=false')
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
  const slice = await openSlice(config)
  try {
    const session = await slice.driver.open('write')
    let first: number[] = []
    let second: number[] = []
    let probeError: string | undefined
    try {
      await session.begin('write')
      // The enclosing span — the one that will change its mind after the append
      // has already handed its numbers out.
      await session.enterSavepoint('sp_outer')

      // The inner append SUCCEEDS. Its seqs are returned to the caller — this is
      // exactly the point at which the real code would publish them.
      first = await appendChangesNested(session, slice.db, slice.tables, upsertRows(5, 'v'), 1_000, 'sp_publish')
      line('nested append returned', `${first[0]}..${first[first.length - 1]}`)

      // ...and only now does the enclosing span give up.
      //
      // THE INJECTED DEFECT [POD-3357]: RELEASE the enclosing span instead of
      // rolling it back. The hazard then does not arise — the seqs stay spent,
      // the next append gets fresh ones — and the proof's finding becomes false.
      // This is the perturbation that matters here because proof 10 asserts a
      // NEGATIVE result (the hazard is real on this engine): the way to watch it
      // say no is to remove the rollback that creates the hazard.
      if (broken('outer-commits')) {
        await session.releaseSavepoint('sp_outer')
        line('enclosing span RELEASED (injected)', true)
      } else {
        await session.rollbackToSavepoint('sp_outer')
        line('enclosing span rolled back', true)
      }

      second = await appendChangesNested(session, slice.db, slice.tables, upsertRows(5, 'w'), 2_000, 'sp_next')
      line('the NEXT, unrelated append got', `${second[0]}..${second[second.length - 1]}`)
      await session.commit()
    } catch (error) {
      await session.rollback()
      probeError = error instanceof Error ? error.message.slice(0, 120) : String(error)
      line('probe failed', probeError)
    } finally {
      await session.close()
    }

    // A probe that died has not answered its question, and its `reused = false`
    // would otherwise read as the reassuring answer.
    check('the probe completed', probeError === undefined, probeError ?? 'yes', 'no error')

    const reused = first.length > 0 && second.length > 0 && first[0] === second[0]
    check('SEQS WERE REUSED', reused, `${first[0]}.. then ${second[0]}..`, 'the same first seq twice')

    const rows = await slice.withSession((s) => changesSince(s, slice.db, slice.tables, 0))
    line('rows now in the log', rows.map((r) => `${r.seq}=${r.entityId}`).join(' '))
    // The consequence, and the reason this is worse than a gap: a replica told
    // "seq 1 is v0" is now served w0 at seq 1, holds a cursor past it, and
    // treats five genuine changes as ones it has already applied. A gap heals; a
    // stale row SUPPRESSING the correct one does not.
    check(
      `a replica told about seq ${first[0]} now sees a DIFFERENT row there`,
      reused && rows.some((r) => r.seq === first[0] && r.entityId.startsWith('w')),
    )
    check('=> the proof detects the POD-3260 class', reused)
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
  const slice = await openSlice(config)
  try {
    const bump = async (tx: { execute: (sql: string) => Promise<unknown> }): Promise<void> => {
      await tx.execute(
        `INSERT INTO ${slice.prefix}changes (entity, entity_id, op, payload, event_time) VALUES ('issue','busy','upsert','{}',1)`,
      )
    }

    // ARM A — 20 s of wall clock, never idle for more than 2 s.
    // Raw for the same reason: the budget probe times the stream itself.
    //
    // THE INJECTED DEFECT [POD-3357] widens arm A's pause past the server's idle
    // budget, so the transaction that is supposed to demonstrate "20 s is fine"
    // gets reaped. It changes the SHAPE being measured — a chatty transaction
    // becomes an idle one — which is precisely the condition rule 7 turns on.
    const chattyGapMs = broken('chatty-gap') ? 12_000 : 2_000
    const chatty = await slice.counted.client.transaction('write')
    const startedA = performance.now()
    let armA = ''
    try {
      for (let i = 0; i < 10; i++) {
        await bump(chatty)
        await new Promise((resolve) => setTimeout(resolve, chattyGapMs))
      }
      await chatty.commit()
      armA = `COMMITTED after ${((performance.now() - startedA) / 1000).toFixed(1)} s of continuous work`
    } catch (error) {
      armA = `FAILED after ${((performance.now() - startedA) / 1000).toFixed(1)} s: ${error instanceof Error ? error.message.slice(0, 90) : String(error)}`
    } finally {
      chatty.close()
    }
    check('20 s transaction, chatty — COMMITS', armA.startsWith('COMMITTED'), armA, 'COMMITTED')

    // ARM B — one 12 s gap and nothing else.
    //
    // THE INJECTED DEFECT [POD-3357] shortens the gap to 1 s, inside the budget,
    // so the transaction the proof needs to DIE survives instead.
    const idleGapMs = broken('idle-short') ? 1_000 : 12_000
    const idle = await slice.counted.client.transaction('write')
    const startedB = performance.now()
    let armB = ''
    try {
      await bump(idle)
      await new Promise((resolve) => setTimeout(resolve, idleGapMs))
      await idle.commit()
      armB = `COMMITTED after ${((performance.now() - startedB) / 1000).toFixed(1)} s`
    } catch (error) {
      armB = `FAILED after ${((performance.now() - startedB) / 1000).toFixed(1)} s: ${error instanceof Error ? error.message.slice(0, 90) : String(error)}`
    } finally {
      idle.close()
    }
    check('12 s transaction, one gap — DIES', armB.startsWith('FAILED'), armB, 'FAILED')
    // The conclusion spec §6 rule 7 rests on, and the line that used to be the
    // literal `true` this issue was filed about. It is a CONJUNCTION now:
    // either arm alone is ambiguous. A transaction surviving 20 s of chatter
    // proves the total is not the limit only if a shorter idle one dies.
    check(
      '=> the budget bounds the GAP, not the duration',
      armA.startsWith('COMMITTED') && armB.startsWith('FAILED'),
      `chatty=${armA.split(' ')[0]} idle=${armB.split(' ')[0]}`,
      'chatty=COMMITTED idle=FAILED',
    )
  } finally {
    await slice.close()
  }
}

/**
 * PROOF 11 — the PORT'S WATCHDOG over proof 9's two arms [POD-3345].
 *
 * Proof 9 measures the ENGINE. This measures what the port built on top of it,
 * against the same two shapes and on the same database, because the watchdog
 * was written from the spec's prose rather than from this measurement and got
 * the quantity wrong: it timed from BEGIN, so it would have reported arm A —
 * which commits — and could not have told arm B's silence from arm A's chatter.
 *
 * The budget sits deliberately below the engine's, which is the whole point of
 * a watchdog: it must speak BEFORE the server reaps the stream. So the result to
 * read is the pair — silence on the arm that commits, exactly one report on the
 * arm that dies, raised while the transaction is still alive.
 */
async function proofWatchdogSeesTheGap(config: Parameters<typeof openSlice>[0]): Promise<void> {
  // THE INJECTED DEFECTS [POD-3357]. `watchdog-chatty` widens arm A's pause past
  // the budget, so the watchdog speaks about a transaction the engine is
  // perfectly happy with — the false-alarm regression, and the one POD-3345's
  // original begin-timed watchdog actually had. `watchdog-quiet` shortens arm
  // B's gap to inside the budget, so the arm that must die survives and the
  // watchdog has nothing to report about it — the silent-watchdog regression.
  //
  // A THIRD INJECTION WAS TRIED AND IS NOT POSSIBLE, which is worth recording
  // rather than omitting: raising `budgetMs` above the 12 s gap would also
  // silence the watchdog, and `createScheduler` REFUSES it — a watchdog budget
  // at or above the driver's own write budget is rejected, because the engine
  // would reap the stream before the watchdog could speak. That guard is why
  // the upper bound on `idleMs` below cannot be defeated by injection; see
  // `defeat-check.ts`'s limitations section.
  const budgetMs = 5_000
  const chattyGapMs = broken('watchdog-chatty') ? 6_000 : 2_000
  const armBGapMs = broken('watchdog-quiet') ? 2_000 : 12_000
  const slice = await openSlice(config)
  const bump: Statement = {
    sql: `INSERT INTO ${slice.prefix}changes (entity, entity_id, op, payload, event_time) VALUES ('issue','busy','upsert','{}',1)`,
    params: [],
    method: 'run',
    intent: 'write',
  }
  const idle = (ms: number): Promise<void> =>
    new Promise((resolve) => {
      setTimeout(resolve, ms)
    })

  /** Run one arm through the scheduler and report what the watchdog said. */
  async function arm(
    label: string,
    body: (lease: { begin(lane: 'write'): Promise<void>; session: DriverSession }) => Promise<void>,
  ): Promise<{ committed: boolean; reports: WatchdogReport[] }> {
    const reports: WatchdogReport[] = []
    // NOT closed: `scheduler.close()` closes the driver, and the second arm
    // needs it. The slice's own `close` returns it at the end.
    const scheduler = createScheduler({
      driver: slice.driver,
      watchdog: { budgetMs, report: (report) => reports.push(report) },
    })
    const startedAt = performance.now()
    let outcome: string
    let committed = false
    try {
      await scheduler.run('write', body)
      committed = true
      outcome = `COMMITTED after ${((performance.now() - startedAt) / 1000).toFixed(1)} s`
    } catch (error) {
      outcome = `FAILED after ${((performance.now() - startedAt) / 1000).toFixed(1)} s: ${
        error instanceof Error ? error.message.slice(0, 130) : String(error)
      }`
    }
    line(label, outcome)
    const first = reports[0]
    line(
      `  watchdog reports (budget ${budgetMs / 1000} s)`,
      first
        ? `${reports.length} — first at idle ${(first.idleMs / 1000).toFixed(1)} s, lease held ${(first.heldMs / 1000).toFixed(1)} s`
        : '0',
    )
    return { committed, reports }
  }

  try {
    // ARM A — 20 s of wall clock, never quiet for more than 2 s. The engine
    // commits it, so the watchdog must not have a word to say about it. THIS
    // ARM IS THE DISTINGUISHING ONE: a watchdog timing from BEGIN would report
    // here, and the port's did until POD-3345 measured it.
    const armA = await arm('20 s transaction, statement every 2 s', async (lease) => {
      await lease.begin('write')
      for (let i = 0; i < 10; i++) {
        await lease.session.execute(bump)
        await idle(chattyGapMs)
      }
      await lease.session.commit()
    })
    check('arm A committed', armA.committed, armA.committed, 'true')
    check('arm A: the watchdog stayed SILENT', armA.reports.length === 0, armA.reports.length, '0')

    // ARM B — one statement then a 12 s gap. The engine reaps it, and the
    // watchdog must say so at its own budget, well before that happens.
    const armB = await arm('12 s transaction, one statement then a gap', async (lease) => {
      await lease.begin('write')
      await lease.session.execute(bump)
      await idle(armBGapMs)
      await lease.session.commit()
    })
    const firstB = armB.reports[0]
    check('arm B died', !armB.committed, armB.committed ? 'COMMITTED' : 'FAILED', 'FAILED')
    check('arm B: the watchdog reported exactly once', armB.reports.length === 1, armB.reports.length, '1')
    // Raised at the watchdog's OWN budget, while the transaction was still
    // alive — not at the 12 s mark, which would be the watchdog merely echoing
    // the engine's reaper after the damage was done.
    check(
      'arm B: raised at the budget, while the transaction was alive',
      firstB !== undefined && firstB.idleMs >= budgetMs && firstB.idleMs < 11_000,
      firstB === undefined ? 'no report' : `idle ${(firstB.idleMs / 1000).toFixed(1)} s`,
      `>= ${budgetMs / 1000} s and < 11 s`,
    )

    check(
      '=> the watchdog follows the engine, not the clock',
      armA.reports.length === 0 && armB.reports.length === 1,
      `armA=${armA.reports.length} armB=${armB.reports.length}`,
      'armA=0 armB=1',
    )
  } finally {
    await slice.close()
  }
}

async function runAll(name: string, config: Parameters<typeof openSlice>[0]): Promise<void> {
  console.log(
    `\n${'='.repeat(72)}\nBACKEND: ${name}  (${normalizeTursoUrl(config.url)})\n${'='.repeat(72)}`,
  )
  // The declared invariant count beside each proof is what `runProof` holds it
  // to. It is not documentation: a proof that returns early records fewer checks
  // than it has, and every check it DID record can still be green.
  const slice = await openSlice(config)
  try {
    await runProof('PROOF 1 — contiguous seqs across chunks (250 rows = 3 chunks)', 3, () =>
      proofContiguousAcrossChunks(slice),
    )
    await runProof('PROOF 2 — a later append continues from the head', 1, () =>
      proofContinuesAcrossAppends(slice),
    )
  } finally {
    await slice.close()
  }
  await runProof('PROOF 3 — lastInsertRowid belongs to the statement, not the database', 2, () =>
    proofRowidIsThisStatements(config),
  )
  await runProof(
    'PROOF 4 — a throw mid-append rolls back the rows and the AUTOINCREMENT counter',
    5,
    () => proofRollbackUndoesCounter(config),
  )
  await runProof('PROOF 8 — is a RAW batch inside an open transaction already atomic?', 4, () =>
    proofBatchAtomicityInsideTransaction(config),
  )
  await runProof('PROOF 7 — a second writer against a held write transaction', 5, () =>
    proofWriterContention(config),
  )
  await runProof(
    'PROOF 10 — does a rolled-back enclosing span hand the same seqs out twice?',
    4,
    () => proofNestedRollbackReusesSeq(config),
  )
  await runProof('PROOF 9 — is the write budget idle time or total time?', 3, () =>
    proofBudgetIsIdleNotTotal(config),
  )
  await runProof('PROOF 11 — does the port\u2019s watchdog report the gap or the duration?', 6, () =>
    proofWatchdogSeesTheGap(config),
  )
  await runProof('PROOF 5 — round trips, counted at the HTTP transport', 11, () =>
    proofRoundTrips(config),
  )
}

/**
 * One backend's verdict, and the vacuity guard that makes it mean something.
 *
 * AN EMPTY RUN IS NOT A PASSING RUN. `invariants.length === 0` is what a proof
 * suite that silently stopped executing looks like, and reporting 0 failures for
 * it would be this issue's own defect wearing a verdict block. It is a failure,
 * and it says which.
 */
function verdictFor(backend: string, from: number): boolean {
  const mine = invariants.slice(from)
  const failed = mine.filter((invariant) => !invariant.ok)
  console.log(`\n${'-'.repeat(72)}\nVERDICT — ${backend}\n${'-'.repeat(72)}`)
  console.log(`  invariants checked ......................... ${mine.length}`)
  console.log(`  held ....................................... ${mine.length - failed.length}`)
  console.log(`  FAILED ..................................... ${failed.length}`)
  for (const invariant of failed) {
    console.log(`\n    FAIL  ${invariant.proof}`)
    console.log(`          ${invariant.label}`)
    console.log(`          got: ${invariant.got}`)
  }
  if (mine.length === 0) {
    console.log('\n  => NOTHING WAS CHECKED. This run proves nothing; it is not a pass.')
    return false
  }
  console.log(
    failed.length === 0
      ? '\n  => PASS: every invariant this backend can observe held.'
      : `\n  => FAIL: ${failed.length} invariant(s) the epic's landed rules rest on no longer hold.`,
  )
  return failed.length === 0
}

const which = process.argv[2] ?? 'both'
let failedAnything = false
/** Set when a backend was asked for and did not run — see `EXIT_SKIPPED`. */
let skippedAnything = false

if (which === 'local' || which === 'both') {
  const from = invariants.length
  const server = await startLocalServer()
  try {
    await runAll('local sqld (turso dev)', server.config)
  } finally {
    await server.dispose()
  }
  await runProof('PROOF 6 — the sequence continues across a server restart', 2, () =>
    proofRestartContinues(),
  )
  if (!verdictFor('local sqld (turso dev)', from)) failedAnything = true
}

if (which === 'remote' || which === 'both') {
  const from = invariants.length
  const config = remoteBackend()
  if (config === undefined) {
    console.log('\nremote backend SKIPPED: TURSO_SPIKE_URL / TURSO_SPIKE_TOKEN are not set')
    skippedAnything = true
  } else {
    // Row isolation comes from the table prefix and is automatic. THIS is the
    // other half: proofs 5, 7, 9 and 11 measure latency and transaction
    // lifetime, and a neighbour holding the database's write lock moves those
    // numbers without making them look wrong. So the hosted arm runs alone or
    // does not run — loudly, because a silent overlap is the whole defect
    // [POD-3358].
    const lease = await acquireRunLease(config)
    if ('refused' in lease) {
      console.log(`\n${refusalBanner(lease)}`)
      // Not a pass and not a failure: exit 3. A caller can retry this; it must
      // not confuse it with an invariant breaking [POD-3357].
      skippedAnything = true
    } else {
      try {
        // Under the lease there is no neighbour, so leftover `sp_…` tables can
        // only belong to runs that died. Collect them before adding one more.
        const swept = await sweepAbandonedNamespaces(config)
        if (swept > 0) console.log(`\nswept ${swept} table(s) left by earlier runs`)
        await runAll('hosted Turso (spike database)', config)
      } finally {
        await lease.release()
      }
      if (!verdictFor('hosted Turso (spike database)', from)) failedAnything = true
    }
  }
}

/**
 * An injection that never reached its site [POD-3357].
 *
 * This is the guard against the failure mode the coordinator named: a check that
 * looks rigorous and cannot fail. If `defeat-check.ts` asks for a break and the
 * break does not happen, the run is GREEN — and a green run would then be read
 * as "the injection did not defeat the check", i.e. as evidence the check is
 * strong, when it is evidence of nothing at all. So an unapplied injection is
 * its own exit code, and the defeat driver treats it as an error rather than a
 * result.
 */
if (injectedBreak !== undefined && !appliedBreaks.has(injectedBreak)) {
  console.log(
    `\nINJECTION '${injectedBreak}' WAS NEVER APPLIED — no site matched it (wrong id, or the ` +
      'proof holding it was not selected). This run proves nothing about any check.',
  )
  process.exit(EXIT_INJECTION_UNUSED)
}

console.log(
  `\n${'='.repeat(72)}\n` +
    `RESULT: ${failedAnything ? 'FAILED' : skippedAnything ? 'INCOMPLETE' : 'PASSED'} — ` +
    `${invariants.length} invariant(s) checked, ${invariants.filter((i) => !i.ok).length} failed` +
    `${skippedAnything ? ', and a backend did not run' : ''}\n${'='.repeat(72)}`,
)

// Failure dominates a skip: if anything actually broke, that is the news.
process.exit(failedAnything ? EXIT_FAILED : skippedAnything ? EXIT_SKIPPED : EXIT_OK)
