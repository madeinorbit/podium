# POD-6162: Turso database spike

As of 2026-10-15, 15:45 UTC. Design §8 of
`docs/internal/superpowers/specs/2026-10-15-server-data-access-design.md`. The spike code is
throwaway and stays on `issue/6162-a4-turso-database-spike` (head `56ea5cb0ac`, cut from
`c6d5044242`); only this report lands.

## Answer in one paragraph

**Not yet.** Our store does run on Turso under Bun: the full 123-migration chain applies, a
bun:sqlite-built 90 MB database opens and round-trips, and 4,446 of the store shard's 4,536 tests
pass. But the reason to adopt it, truly async execution, is not there. The async JS API runs every
query step on the calling thread, so a heavy query blocks the server's event loop for its whole
duration, exactly as bun:sqlite does, and for 1.2× to 4.3× longer. On top of that we hit
correctness hazards that bun:sqlite does not have: overlapping calls on one prepared statement
return the wrong rows, `PRAGMA foreign_keys` behaves differently inside a transaction, and a stock
SQLite process writing the same file loses committed writes without any error.

## Versions

| | |
|---|---|
| Turso package | `@tursodatabase/database` 0.8.3 (latest stable, published 2026-10-12; 0.9.0-pre.1 appeared 2026-10-15 and was not tested) with `@tursodatabase/database-common` 0.8.3 and the `linux-x64-gnu` native addon |
| Turso engine | reports `sqlite_version()` = 3.50.4 (its compatibility level) |
| bun:sqlite engine | SQLite 3.53.2 |
| Bun | 1.4.2 |
| Machine for all numbers | polaris "agents" VM: 4 vCPU, 12 GB, Ubuntu 24.04.5 LTS, Linux 6.8.0-147-generic, holding `test:polaris-agents` for every run |

## How it was tried

- `packages/runtime/src/sqlite/turso.ts`: a `SqlDatabase` over Turso. `openDatabase` returns it when
  `PODIUM_STORE_ENGINE=turso`. One native connection carries two facades: Turso's synchronous
  "compat" API, used by migrations and every direct `db.prepare` caller, and Turso's async
  `DatabasePromise` API.
- `apps/server/src/store/executor/turso-driver.ts`: a `StoreDriver` over the async facade, which
  `createBunStoreExecutor` selects for a Turso-opened database. It mirrors `bun-driver.ts`: one
  shared connection (`LanePolicy.readConcurrency: 0`), `BEGIN IMMEDIATE` for the write lane, a
  savepoint around a batch inside an open transaction, `UNBOUNDED_WRITE_BUDGET_MS`, `NO_BUSY_RETRY`.
  So every repository statement goes through Turso's async API.
- Turso has no `deserialize`, so the test fixture's schema image (built by bun:sqlite) is written to a
  temp file and Turso opens that file. As a result, 2,761 store opens in the shard ran Turso on a file
  that stock SQLite wrote.
- `PODIUM_TURSO_OPEN_LOG` recorded every Turso open. The final shard run opened Turso 3,679 times
  (2,761 image files, 568 other files, 350 in memory) across 279 test processes. That is the evidence
  the tests really ran on Turso.

## 1. Does our store run on it under Bun?

**Yes, with gaps.** Store shard (`bun run test:lane -- server-store`, 273 files, 4,536 tests), same
commit, same fixture, run back to back on the VM:

| run | passed | failed | failed files | wall | peak RSS |
|---|---|---|---|---|---|
| bun:sqlite (baseline) | 4,509 | 26 | 15 | 434.7 s | 1.29 GB |
| Turso, final driver | 4,446 | 89 | 31 | 659.5 s | 3.04 GB |
| Turso, first driver (no per-connection queue) | 4,383 | 152 | 35 | 646.5 s | |

The baseline's 26 failures exist on this branch without Turso. 25 of them also fail on Turso, and
one (`store/grants.test.ts`, "enforces one custodian") failed only in the baseline. So **64 failures
are caused by Turso**, in 17 files:

| cause | tests | where it shows | our call sites |
|---|---|---|---|
| No FTS5 (`no such module: fts5`) | 19 | `transcript-indexer` 10, `memory/transcript-index-ids` 5, `store.search-index` 3, `memory/lake` 1 | `store/conversations/index.ts:103` (virtual table, 3 triggers, `'rebuild'`), `:276` (`MATCH`); `store/conversations/transcript-index.ts:48`, `:187-192` (`snippet`, `bm25`, `MATCH`) |
| `PRAGMA foreign_keys` takes effect inside a transaction (SQLite ignores it there) | 20 | `migrations/retire-the-solo-user` 18, `migrations/store-lifecycle` 2 | the `PRAGMA foreign_keys = OFF/ON` lines inside 17 drizzle migrations, which drizzle runs in one transaction; the bracket `migrations/store-lifecycle.ts:40` (`withMigrationForeignKeysDisabled`) and its tests rely on SQLite ignoring them |
| `VACUUM INTO ?` refuses a bound path ("requires a string literal path") | 7 | `snapshot-verifier-boundary` 4, `store.lifecycle` 2, `snapshot-staging` 1 | `migrations/snapshot-staging.ts:55`, reached from `snapshot-verifier.ts:427` |
| `PRAGMA query_only = ON` refused (only `= 1` is accepted) | 4 | `sync-worker/producer` 2, `store.lifecycle` 1, `store.test` 1 | `sync-worker/producer.ts:101`, `migrations/store-lifecycle.ts:60` (the transfer fence), `packages/janitor/src/janitor.ts:1260` |
| 20 s test timeouts | 4 | `modules/messages/service` 2, `store.lifecycle` (rule 67 snapshot proof) 2 | not isolated. On bun:sqlite the same four tests take 0.28 s, 0.21 s, 6.2 s and 0.60 s. The two snapshot-proof tests park a proof that goes through the `VACUUM INTO` path above, so they are probably downstream of it. The two message-delivery tests ("more than 2000 distinct restart targets", "500 unrelated wakes") are either more than 3× and 33× slower or stuck. A rerun with a 300 s timeout was queued behind a 100-minute benchmark hold on the VM and withdrawn |
| Spike harness: these tests count statements by spying on `SqlDatabase.prepare`, but the Turso driver issues them through the async facade | 4 | `store/messages-golden` 3, `migrations/drop-legacy-message-status` 1 | not an engine gap |
| Backup and restore find twice the expected files | 3 | `migrations/backup` 2, `migrations/restore` 1 | not isolated. The tests count files matching each backup's name and find 6 where 3 are expected, so each backup has a companion file under Turso. The WAL probe (checkpoint, close, reopen) behaved the same on both engines, so the extra file comes from elsewhere in `migrations/backup.ts` / `restore.ts`; `backup-files.ts` on the spike branch lists it when run |
| Turso rewrites the schema SQL it stores and reports declared types in lower case (`TEXT` becomes `text`) | 2 | `migrations/accepted-delivery-status` 1, `migrations/drop-legacy-message-status` 1 | anything that reads `sqlite_master.sql` or `table_xinfo` types: `migrations/repair.ts:66`, `migrations/index.ts:158`, the shape checks in `store/shipping.ts:816` |
| Planner does not use the partial index together with `json_each` (`SCAN ship_orders`) | 1 | `store/shipping-lane-reads` | `store/shipping.ts:819` |

**A hazard the first driver exposed (63 tests).** Turso's async `Statement.get/run/all` binds the
parameters *before* awaiting its own execution lock (`database-common/dist/promise.js`, the
`bindParams(...)` before `await this.execLock.acquire()`). Two overlapping calls on one prepared
statement therefore both run with the second call's parameters. Repro
(`repro/concurrent-bind.mjs`): `Promise.all([st.get(1), st.get(2)])` returns `[two, two]`. Our
repositories do overlap calls inside a body (`store/shipping.ts:1189` and `:1221`, `Promise.all`
over order and issue lookups), so the first driver failed 63 more tests, mostly with "ship train
source branches must be unique". Queuing every call per connection in the driver fixed all 63. Any
real Turso driver must do the same, which also rules out running statements on one connection
concurrently.

**Migration chain and schema.** On a fresh database the chain applies all 123 migrations, with the
same 90 indexes and 32 triggers. Turso adds **six internal tables** that show up in `sqlite_master`
and `table_xinfo`, one for each table with `AUTOINCREMENT`
(`__turso_internal_seq___turso_internal_autoincrement_{changes, lock_waiters, podium_events,
settings_audit_events, superagent_messages, workflow_events}`, 7 columns each). `sqlite_sequence`
itself still behaves exactly as in SQLite, including rollback, so `maxChangeSeq`
(`packages/sync/src/adapters/sqlite/sync-repository.ts:309`) works. 181 of 218 stored schema
statements differ only in formatting (whitespace, backticks, `NOT NULL DEFAULT` order).

**A real database file.** The brief asked for a backup-API copy of the live `podium.db`. That was not
done: the operator's addendum (issue mail, 13:48 UTC) forbids copying or scanning the live 3.6 GB
file, and ludovico's disk was 100% full anyway. Per the addendum, I built a database on the VM
instead: bun:sqlite, our migrations, and POD-4747's synthetic corpus seeded through POD-6146's seeder
(cell `h20a4`: 59,884 issues, 63,792 sessions, 1,889 repos, 42,578 dependencies, 6 machines; 90 MB,
170,193 rows). Results:

| step | result |
|---|---|
| Turso opens the bun:sqlite file | same schema digest, all 96 table counts equal, `integrity_check` ok (1.65 s vs 1.21 s on bun:sqlite) |
| `SessionStore.open` on Turso | 693 ms; migrations a no-op; 618 of 618 sampled issues found; a 500-id batch read found 500 |
| Turso writes one repo row, closes | |
| bun:sqlite reopens | `integrity_check` ok; exactly `repos` and `repo_prefixes` grew by 1 |

So handing a file from one engine to the other, one at a time, works.

## 2. Does a heavy query still block the server's thread?

**Yes, completely, and for longer.** `bench-event-loop.ts`: each engine gets its own WAL file
database of 100,000 rows (about 230 bytes each). Each scenario is measured 7 times, with the engines
interleaved inside each repeat. During each query a 1 ms `setInterval` ticker runs, alongside
`perf_hooks.monitorEventLoopDelay` (resolution 1 ms, already ticking before the query, reset at its
start). Both engines return identical results.

| scenario | engine | query wall, median (min–max) | longest event-loop stall, median | ticker fired during query |
|---|---|---|---|---|
| full scan, `LIKE '%7-%'` count (19,001 hits) | bun:sqlite | 19.3 ms (18.9–27.3) | 18.5 ms | never |
| | Turso | 82.9 ms (79.0–93.0) | 82.7 ms | never |
| sort of all 100k rows on an unindexed expression, materialized | bun:sqlite | 90.9 ms (80.3–93.3) | 90.6 ms | never |
| | Turso | 193.5 ms (183.4–238.0) | 193.0 ms | never |
| 2,000 primary-key lookups on cached pages (one awaited call each) | bun:sqlite | 12.8 ms (12.3–21.7) | 11.8 ms | never |
| | Turso | 15.8 ms (14.3–27.6) | 15.8 ms | never |

"Never" means the 1 ms ticker did not fire once while the query was in flight, in any of the 42
measurements. The stall equals the query's wall time. The source says why: each step is a native
`stepSync()` on the calling thread, and the binding's own comment reads "For in-memory / Node.js
builds, ioStep is a no-op since I/O is synchronous". The `await` between steps only yields to
microtasks, never to timers or I/O, so even the lookup burst (2,000 separate awaited calls) never
lets a timer run. The design's rules 5 and 7 (keep each query short) are therefore just as necessary
on Turso as on bun:sqlite.

The numbers count only the query call. Seeding is not measured. Machine: the VM, `7eb2d57920`, run
15:27 UTC. (An earlier run on flatblock, made before I read the rule that benchmarks belong on the
VM, showed the same picture and is not used here.)

## 3. Compatibility gaps

From `compat-probe.ts`, which runs each case on bun:sqlite and Turso, each on a fresh database
migrated through our real chain, and from the repro scripts in `repro/`. All were run on the VM.

| feature | Turso 0.8.3 | our call sites |
|---|---|---|
| FTS5 | **missing** (`no such module: fts5`). Turso's own full-text index (`CREATE INDEX … USING fts`, `fts_match`, `fts_score`, `fts_highlight`) works only with `experimental: ['index_method']`, and its syntax differs: no virtual table, no external-content table, no `'rebuild'` or `'delete'` commands, no `snippet`/`bm25` | `store/conversations/index.ts:103`, `:276`; `store/conversations/transcript-index.ts:48`, `:187-192`; readers in `modules/memory/search.ts`, `modules/memory/transcript-indexer.ts`, `modules/conversations/queries.ts` |
| `WITH RECURSIVE` | **works** (contrary to COMPAT.md going in) | none in production code |
| `json_each` IN-list | works, same rows | `packages/sync/src/adapters/sqlite/sync-repository.ts:653`; `store/conversations/index.ts:195`; `store/user-layout.ts:373`; `store/shipping.ts:819` (but see the planner row below) |
| partial indexes | created (all 7 of ours) and used by the planner | 7 in the migrations |
| `AUTOINCREMENT` + `sqlite_sequence` | works, rollback included; adds 6 visible internal tables | `changes` and five other tables; `sync-repository.ts:309` (`maxChangeSeq`) |
| savepoints (nested, `ROLLBACK TO`, `RELEASE`, outside a transaction) | works | `store/executor/executor.ts:876`; the batch boundary in the driver |
| `INSERT OR IGNORE` (POD-3221 rule 31) | same suppression matrix: PK, UNIQUE, NOT NULL and CHECK suppressed; FK throws; `ON CONFLICT DO NOTHING` suppresses uniqueness only | the 25 `OR IGNORE` sites |
| `INSERT OR REPLACE` across PK + a separate unique index (rule 31b) | same: both conflicting rows replaced | `store/auth.ts:102`, `packages/runtime/src/session-mint.ts:211`, `enrollment-ledger-import.ts:112,166`, `modules/updates/recovery-store.ts:80` |
| `UPDATE OR IGNORE` | same | `store/repos.ts:432`, `:464` |
| `RETURNING` (insert, update, delete) | same | `store/issues.ts:395,432,725,823`, `store/conversations/index.ts:198`, `store/notification-facts.ts` |
| `ON CONFLICT DO UPDATE … excluded` | same | 52 `onConflictDoUpdate` sites |
| `INDEXED BY`, window functions, JSON and date functions, triggers, `ALTER TABLE` add/rename/drop, `BEGIN IMMEDIATE/EXCLUSIVE/DEFERRED`, FK enforcement and cascade, `DROP TABLE` refusal under FKs | same | `sync-repository.ts:391` (`INDEXED BY`) and throughout |
| `PRAGMA foreign_keys` inside a transaction | **differs**: Turso applies it (fresh / in transaction / after commit = 0/0/0; SQLite = 0/1/1) | 17 migrations; `migrations/store-lifecycle.ts:40` |
| `PRAGMA query_only = ON` | **refused**; `= 1` works and then refuses writes | `sync-worker/producer.ts:101`, `migrations/store-lifecycle.ts:60`, `packages/janitor/src/janitor.ts:1260` |
| `VACUUM INTO ?` | **refused** with a bound path; literal paths only | `migrations/snapshot-staging.ts:55` |
| `ATTACH` | experimental flag only | none in production code |
| other `PRAGMA`s we issue (`journal_mode`, `busy_timeout`, `user_version`, `quick_check`, `integrity_check`, `wal_checkpoint(TRUNCATE)`, `wal_autocheckpoint`, `table_info`, `table_xinfo`, `index_list`, `foreign_key_check`) | work | |
| a second connection in the same process reading during `BEGIN IMMEDIATE` | works (sees the committed snapshot) | `openReader`, `store.outsideTransaction` |
| **a second process on the same file** | **refused by default**: Turso locks the file exclusively ("File is locked by another process"; bun:sqlite gets "database is locked", even for reads). Works only with `experimental: ['multiprocess_wal']` | anything outside the server process: the `sqlite3` CLI, scripts, a second server during a handoff |
| **stock SQLite and Turso writing one file** (`multiprocess_wal`) | **loses committed writes** (`repro/lost.mjs`, 3 of 3 runs): bun:sqlite in another process inserts 7, Turso never sees it, Turso inserts 3, and the file ends with `1,7`. Turso's committed row is gone and `integrity_check` still says `ok` | any tool that opens `podium.db` while the server runs |
| one prepared statement used by overlapping async calls | **wrong rows** (see section 1) | every `Promise.all` inside a body |
| value types (boolean params, blobs, no-row `get`) | same | |

## Recommendation

**Not yet.** Do not adopt Turso for async execution now. Reasons, in order of weight:

1. **It does not give async execution.** The JS binding runs queries on the server's thread (section
   2). The one benefit §8 hoped for is absent, and the same queries take 1.2× to 4.3× longer, so the
   stalls get longer.
2. **Silent data hazards.** Lost writes when any stock SQLite process writes the file, wrong rows
   from overlapping calls on a prepared statement, and different `foreign_keys` semantics in
   migrations. Each can be worked around, but each is the kind of bug a migration discovers in
   production.
3. **Gaps that need real work:** FTS5 (two search features to port onto an experimental index), plus
   smaller fixes (`query_only = 1`, a literal `VACUUM INTO` path, schema checks that tolerate
   Turso's rewritten SQL and its internal tables).
4. **Not 1.0**, and the store shard runs 1.5× slower with 2.4× the peak memory.

What would change this:

- The Node/Bun binding steps queries off the main thread (a native worker or thread pool), with the
  ticker in `bench-event-loop.ts` firing during a 100k-row sort, and the event-loop stall far below
  the query time.
- FTS5, or a stable full-text index we decide to port to.
- `multiprocess_wal` (or its successor) is stable and interoperates with stock SQLite without losing
  writes; `repro/lost.mjs` is the test.
- A 1.0 release.

Re-run cost: the spike branch keeps everything: `PODIUM_STORE_ENGINE=turso bun run test:lane --
server-store`, `run-probes.sh`, `run-file-compat.sh` and `bench-event-loop.ts`. A future Turso
version can be re-measured in under an hour.

Until then the design stands as written: async everywhere through the existing interface, short
queries on bun:sqlite (rules 5 and 7), and Postgres as the truly async engine later. Nothing here
changes the design's rules.

## Evidence on the spike branch

`apps/server/src/store/spike/turso-6162/`: `bench-event-loop.ts` and `bench-100k.vm.out.txt`;
`compat-probe.ts`, `table-diff.ts`, `run-probes.sh` and `probes.vm.out.txt`; `file-compat.ts`,
`run-file-compat.sh`, `corpus-export.ts`, `seed.ts` (both copied from POD-6146) and
`filecompat.vm.out.txt`; `repro/` (`concurrent-bind.mjs`, `lost.mjs`, `interop.mjs`, `mp.mjs`,
`exp.mjs`); `backup-files.ts`. Driver: `apps/server/src/store/executor/turso-driver.ts`. Shim:
`packages/runtime/src/sqlite/turso.ts`.
