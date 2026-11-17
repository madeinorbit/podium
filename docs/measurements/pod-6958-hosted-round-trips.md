# POD-6958: round trips at hosted Postgres latency

As of `6bd105edd0` (`issue/6992-postgres-query-plans-and-round-trips`, on
`integrate/6951-cloud-hosting` at `e2532166d1`), 2026-11-17. Task POD-6992, design section 2.11
of `docs/design/POD-6958-postgres-store-design.md`. This report feeds operator decision OD2
(a round-trip budget before a second workspace goes live); the reductions are POD-7030.

## In one paragraph

On hosted Postgres every round trip costs about 2.6 ms from the app region. The pinned hot
operations make **between 1.01 and 1.46 round trips per statement**: sessions.create over tRPC
makes 144 round trips (about 374 ms of database time), mail to a running session over tRPC 134
(about 348 ms). Pipelining already folds every BEGIN into the transaction's first statement or
its workspace lock, and every root write into one round trip. The rest is one round trip per
statement, plus 2 per nested transaction (SAVEPOINT, RELEASE) and 2 per transaction (BEGIN with
the lock, COMMIT). Against OD2's example target of 25 round trips (about 65 ms), every
interactive pin is three to six times over.

## How it is measured

- **Round trips** are the driver calls that wait for the server, counted at the statement probe
  (`apps/server/src/store/executor/statement-probe.ts`, `RoundTripObservation`) from the
  session calls a lease makes, by the Postgres driver's pipelining (`pg-driver.ts`): a read's
  BEGIN and a global write's BEGIN go out with the first statement, a workspace write's BEGIN,
  `SET LOCAL lock_timeout` and workspace lock are one round trip, each statement and each batch
  is one, a failed batch one more, each COMMIT, ROLLBACK and savepoint command one, an empty
  body nothing.
- **The model is the wire.** `store/executor/round-trip-probe.pg.test.ts` runs each shape of
  lease (read body, workspace write, global write, empty bodies, root statements, root batch,
  batch in a transaction, failed batch, nested transaction, a repository read and upsert)
  through the real Postgres driver to a TCP proxy that counts round trips as they cross the
  wire. Warm, the wire equals the model in every shape.
- **The pinned operations run on SQLite.** A whole `SessionStore` does not boot on Postgres
  until POD-6994. The executor, the scheduler and the repositories make the same session calls
  on both engines, so the count read off a SQLite store is the Postgres cost. The pins hold it:
  each round-trip pin sits next to its statement pin and, like it, must be the same at 5 and
  200 rows.
- **Database time** is round trips × 2.6 ms. The wall times below come from
  `bun --conditions=@podium/source scripts/measure-hot-paths.ts --suite round-trips --repeat 7`,
  which also holds 2.6 ms before every round trip. They were taken twice on the second test host
  (8 CPU); the two runs agreed within 5%, and the table gives the first.

## The pinned operations (design 2.11)

From the pins (`*.statement-count.test.ts`). Statements are the same on both engines (design
2.10). "In transactions" counts the statements inside a write transaction; "transaction
overhead" counts BEGIN with the lock, COMMIT, SAVEPOINT and RELEASE.

| Operation | Pin | Statements | Round trips | At the root | In transactions | Transaction overhead | Database time at 2.6 ms |
|---|---|---:|---:|---:|---:|---:|---:|
| tRPC `sessions.create` | `session-create.statement-count.test.ts` | 106 | 144 | 45 | 61 | 38 (9 transactions, 10 savepoints) | 374 ms |
| tRPC `messages.send` to a running session | `mail-send.statement-count.test.ts` | 92 | 134 | 27 | 65 | 42 (10 transactions, 11 savepoints) | 348 ms |
| Agent-relay mail to a running session | `mail-send.statement-count.test.ts` | 84 | 120 | 32 | 52 | 36 (10 transactions, 8 savepoints) | 312 ms |
| Steward poll | `steward.subscriptions.statement-count.test.ts` | 76 | 80 | 69 | 7 | 4 (1 transaction, 1 savepoint) | 208 ms |
| Owner bootstrap (sync worker) | `sync-feed.statement-count.test.ts` | 67 | 68 | 67 | 0 | 1 (the read session's end) | 177 ms |
| In-process draft session create | `session-create.statement-count.test.ts` | 41 | 49 | 22 | 19 | 8 (2 transactions, 2 savepoints) | 127 ms |

Notes:

- The design's table named an owner bootstrap of 64 statements; POD-7061 moved its pin to 67.
- The worker bootstrap reads in one REPEATABLE READ snapshot on Postgres
  (`sync-worker/pg-read-session.ts`): its BEGIN rides on the first read, and closing the session
  ends the transaction, which is the one round trip beyond its statements. A job given an idle
  budget sets it first, which is one round trip more.
- The tRPC `sessions.create` pin leaves out the session activity publication's read: a timer
  the create starts, which at 200 rows fires inside the counted window. It is background work,
  one round trip when it runs.

## At hosted latency (measured)

From `measure-hot-paths.ts --suite round-trips` (its own fixture: 50 sessions, 30 issues, a
shell agent on the host machine, so its operations are lighter than the pins' fixtures).
Medians of 7 runs.

| Operation | Statements | Round trips | Wall time as run | Wall time at 2.6 ms per round trip | Round trips × 2.6 ms |
|---|---:|---:|---:|---:|---:|
| In-process draft session create | 27 | 33 | 7.5 ms | 88 ms | 86 ms |
| tRPC `sessions.create` | 58 | 78 | 15.4 ms | 236 ms | 203 ms |
| tRPC `messages.send` to a running session | 89 | 131 | 23.4 ms | 419 ms | 341 ms |
| `issues.crud.create` | 33 | 47 | 9.7 ms | 147 ms | 122 ms |
| Issue frame reads (the ready list, then one issue read per session, 50) | 664 | 664 | 48.1 ms | 2,063 ms | 1,726 ms |

The latency is held before each round trip at a tenth of a millisecond's precision, but timers
overshoot under load: the measured wall time runs about 0.4 ms per round trip above the sum.
The round trips themselves are exact.

## Where the round trips go (for POD-7030)

1. **One round trip per statement.** 69% to 99% of each pin's round trips are its own
   statements, sent one at a time because each awaits the last. Independent reads of one operation (the
   machine list, the repository registry, the earliest admin and its settings, the visibility
   audiences) could go out as one batch, which the driver already pipelines.
2. **Nested transactions cost two each.** Every `createOrJoinTransaction` inside a write is a
   SAVEPOINT and a RELEASE, each its own round trip: 22 of `messages.send`'s 134. The driver
   could hold the SAVEPOINT until the first statement inside it, as it holds BEGIN, and send the
   RELEASE with the next statement or the COMMIT. That needs no repository change.
3. **Several transactions per operation.** `messages.send` opens 10 write transactions, each
   paying BEGIN-with-lock and COMMIT. Fewer, larger transactions per operation, or one per
   request, would save two round trips each.
4. **Root statements.** 22 to 69 per operation run outside any transaction, one round trip each.
   Reads that need not see one snapshot could be batched; those that must could share one read
   transaction, whose BEGIN costs nothing.
5. **Per-row reads in issue frame reads.** One issue read is about 13 statements; the frame reads
   make 664 round trips for 50 sessions (about 1.7 s on hosted). It is the frame cache that
   `measure-hot-paths --suite queries` gates, and on a remote database it needs a batched read.
6. **Cold preparation.** postgres.js prepares a statement with parameters on its first use on a
   pooled connection with a Parse and Describe, one round trip before the Bind
   (`round-trip-probe.pg.test.ts` shows 2, then 1). It is once per statement text per
   connection; a pool warmed at boot, or fewer distinct texts (`IN` lists are already one text
   per size class), keeps it out of requests.

## Query plans on Postgres

`store/query-plan-audit.pg.test.ts` plans every Postgres definition (865 definitions, 1,114
statements) with `EXPLAIN (GENERIC_PLAN, FORMAT JSON)`, the plan Postgres runs a prepared
statement on. It plans them on a clone of the template filled with 10,000 synthetic rows per
table that grows with work (50 per small table) and analyzed. The seed's statistics follow the
SQLite audit's picture: one workspace, every key selective, `deleted_at` mostly NULL,
closed-set columns cycling through their CHECK lists, flags rarely set. 434 statements scan or
sort, and every one is explained, by the lists the SQLite audit has and two of its own:

| List | Entries |
|---|---:|
| Small tables (the SQLite audit's 32, plus `sync_capture` and `lock_waiters`) | 34 tables |
| Allowlist: the SQLite audit's entries with its reasons, plus 4 Postgres-only | 59 |
| Whole-table reads on purpose: the SQLite audit's, plus 2 Postgres-only | 44 |
| Query-shape debt: 4 as on SQLite, 3 Postgres index order (POD-7101) | 7 |
| The planner's cost choice, each proved: for real values, on a real data shape, or with the chosen plan barred, an index serves it | 13 |
| INDEXED BY statements whose Postgres plan reads the hinted index on a real data shape | 6 |

Also proven there:

- **INDEXED BY.** All 15 statements that name an index on SQLite read the same index on
  Postgres, 9 of them on the seed. The other 6 read it under the data shape the hint assumes
  (few active orders, few open trains, few worktrees; for the worktrees, through its sibling
  partial index over the same rows), or for real parameter values: the retention prune's age
  threshold, and the running flag, which is a bound `true`.
- **Expression indexes.** No JSON-field expression index (`(col ->> 'k') COLLATE "C"`) exists in
  the baseline yet. All 6 expression indexes match the queries written for them:
  `idx_conversations_search` (GIN), `idx_issues_worktree_folded`, `idx_sessions_cwd_folded`,
  `idx_labels_name_nocase`, `users_email_unique` and `workflows_scope_name_active`. The last
  three are on small tables, which Postgres scans, so they are proven with sequential scans
  barred.
- The SQLite-only plan tests that were skipped on Postgres hold there too: the message readers
  read the recipient index, not a status index (POD-5941), and the shipping dependents read the
  active orders' partial index.
- A planted unindexed lookup and a planted sort fail the audit.

Found, and fixed here:

- `issue-listings.ts` `issueListing` with `completeParent` put the integer `1` in an `AND`, which
  Postgres refuses ("argument of AND must be type boolean"). Its Postgres form now says `TRUE`;
  the SQLite text is unchanged.

Found, for other tasks:

- **POD-7101 (filed):** `ORDER BY col NULLS FIRST`, which the binding tasks added to keep
  SQLite's NULL order, cannot use a Postgres btree that stores NULLs last
  (`effectsInStatus`, `expireDueEffects`), and `to_id IS NULL ORDER BY created_at` does not use
  `idx_messages_recipient_time` for order (`messagesAddressedTo`).
- **Constants bound as parameters** (`inArray(status, [...MESSAGE_PENDING])`, `eq(flag, true)`)
  hide their values from the generic plan, so these statements depend on Postgres keeping custom
  plans: `queuedCount`, `syncTurnRunning`. The audit proves that the custom plans use the index.
  Writing such constants as SQL literals would make the generic plan right as well.
- **JSON key lists** (`json_array_elements_text($n)`) are estimated at 100 rows whatever their
  length. Against the audit's 10,000 rows the planner hashes the whole table
  (`upsertConversations`, `deleteMachineConversations`, `adoptParents`). At a real table's size
  the key lookups win; the audit proves that they read the primary key.
- `transcript-costs.ts` `latestWindow` reads every cost row for one maximum: no index holds
  `window_since_ms`.
- `identity-upgrade.ts` `passwords` and `links` read tables only a SQLite install has; a
  Postgres boot must not run the identity import (POD-6994).

## Record payloads

`sync/record-payloads.pg.test.ts` writes a SQLite store through the server's own paths
(machines, issues with a parent and a dependency, sessions bound by their daemon, mail over
tRPC to a session and to an issue), copies every row into Postgres, and streams every record
kind from both with one clock. As of `6bd105edd0`: 35 records over 13 kinds (`machine`,
`machineAccess`, `repo`, `issueProjection`, `issueDep`, `issueUserState`, `superagentThread`,
`agentProfile`, `instancePreferences`, `checkout`, `issueEvent`, `message`, `session`) are equal
byte for byte under `JSON.stringify(record.value)`, with the same ids. There are no differences.

## Limits

- The pinned operations' round trips are read off SQLite stores. They become Postgres
  measurements of the same pins when a store boots on Postgres (POD-6994). The model they use
  is proven against the wire, warm, for every shape of lease.
- Statements that SQLite's executor makes and Postgres's would not are not in these counts, and
  neither are the reverse. The change capture is one statement on both engines (design 2.10), so
  there are none today.
- The plan audit's verdicts are for its picture of a large database, as the SQLite audit's are.
  A real database's statistics can choose differently. The generic plan is the pessimistic one:
  Postgres runs a custom plan while it costs less.
