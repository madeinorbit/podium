# POD-6140 research: how the server reads, writes and caches data today

Read-only research, 2026-10-15, worktree HEAD 015614ec6b. Sources: the issues named below
(`podium issue show`), the code, git history, the live database `~/.podium/podium.db`
(opened read-only) and the event-loop minute file `~/.podium/perf/loop-server.ndjson` on ludovico.
Statement counts measured before POD-3852 are double-counted and marked (2x).

## 1. The short version

1. **The database was never the slow part.** POD-3853's lanes never found a slow query. The hot
   statements were primary-key lookups and simple counts run 10^5 times. The cost per call was in
   JavaScript: preparing one drizzle query once cut sessions-by-id from 256.6 µs to 28.8 µs, so
   about 89% of each call was query building (POD-3854). The biggest CPU wins were not the
   database at all: `statSync` 11%, `resolveUpdateChannel` 14%, a linear `isMemberCwd` scan 9.3%
   self / 15.7% inclusive.
2. **The memory copies patch access patterns, and only partly.** Each POD-3853 switch moved call
   sites, not facts. Every copy falls back to SQL inside a write span, so grants still come from
   the database 21.2% of the time; the users copy has no production reader at all, while
   `users.get` stays the most-executed statement.
3. **The same facts live in up to six places.** Issue rows: `IssueStore.hydrated` (full row), the
   reports projection map, `WorldIndex.issuesById`, the Authority's `ChangeBaseline`, the
   `latestChangeStatesCache` string copy of `change_latest`, and the database. The whole wire
   world (`change_latest`) is held three times in process. Every one of these grows with total
   data, not with active data. Estimated at the "tens of thousands of issues" target: ChangeBaseline
   300–600 MB, latestChangeStates cache 150–250 MB, IssueStore 60–150 MB, session map 100+ MB
   (estimates, not measurements).
4. **The memory copies bring their own costs.** `structuredClone` on every `grantsFor`; a full
   copy and sort of all issues on every `readIssueCwdRows` (about 170k Buffers for 6.8k issues,
   POD-5941), several times per machine every five seconds; the whole `change_latest` cache
   dropped on every append and re-read on the next shared-issue visibility check.
5. **"Async" store, synchronous execution.** POD-3221 made every call awaitable, but on
   bun:sqlite there is one connection, reads take the same single slot as writes
   (`readConcurrency: 0`), and every statement runs on the main thread. The Turso driver that would
   change this sits on a branch about 9,700 commits behind (POD-3272, refresh filed as POD-3909).
6. **The client wants things the server cannot give yet**: active rows first, a row by id with
   "gone: removed / not visible", history pages, and one subscribe path (POD-5592, 5596, 5600,
   5800, 5802). Today a bootstrap reads the whole `change_latest` for every user and filters it,
   so its cost grows with total data, not with what that user may see.

## 2. Today's load (ludovico, attribution level, medians per minute)

| window | utilization | blocked | stalls/min | SQL statements | SQL wall | daemon frames | daemon wall | RSS |
|---|---|---|---|---|---|---|---|---|
| 24 h to 2026-10-15 12:00Z | 52.1% | 14.8% | 17 | 34,648 | 3,070 ms | 27,779 | 10,369 ms | 1.5 GB |
| last 60 min | 57.9% | 18.6% | 20.5 | 47,133 | 4,457 ms | 37,445 | 10,419 ms | – |

Daemon WebSocket frames are the largest cost (about 17% of wall); each causes about 1.25 SQL
statements. Frames have roughly tripled since September. One user, eight machines.

Client-side write rate on the operator's data (POD-5874): 186 session updates/min, 22 issue
updates/min.

## 3. The database

- `~/.podium/podium.db`: 3.58 GB, WAL. Rows: issues 7,232, sessions 6,015, messages 39,526,
  machines 8, change_latest 25,712, changes 20,110, podium_events 50,100, applied_mutations 78,332.
- **`applied_mutations` is 2.15 GB of the 3.58 GB** (its `result` column, ~27 KB per row), with
  no size bound.
- **`ANALYZE` has never run** (no `sqlite_stat1`), so the planner has no statistics.
- Missing indexes on keys that are looked up: `sessions.issue_id` (used by the visibility pass
  after writes), `sessions.machine_id`, `messages.from_issue` (`listLedger` does a full scan plus
  a temp sort).
- Query preparation: the driver caches one SQLite statement per SQL text, but drizzle builders are
  rebuilt on every call almost everywhere; `.prepare()` / `preparedPerDb` is used at about six
  sites.

## 4. In-memory copies of database facts (selected)

| copy | file | bound | still also read from the database |
|---|---|---|---|
| `IssueStore.hydrated` (full issue rows) | modules/issues/service/core.ts:107 | none, includes deleted | inside spans; permanently if boot quarantined a row |
| `WorldIndex` issues / grants / users / machines / pending counts (POD-3869) | modules/world-index/index.ts:86-93 | none | grants inside spans (21.2%); users always (copy unused); machines at 19 sites |
| Session registry `Map<Session>` | relay.ts:684 | none, includes archived | `sessions.getSession` 146k per 7 min (2x), twice per capability check at relay.ts:640/643 |
| `ChangeBaseline` (parsed latest wire value of every entity) | packages/sync/src/change-log.ts:195 | none | is a copy of `change_latest` |
| `latestChangeStatesCache` (raw strings of all `change_latest`) | packages/sync/src/adapters/sqlite/sync-repository.ts:118 | none | dropped on every append |
| `MachinesService` record and name caches | modules/machines/service.ts:392 | small | management paths |
| `SessionObservationLeases` | modules/sessions/observation-leases.ts:29 | none, never deleted | daemon lifecycle (POD-3862, never started) |

Boot loads every issue (all columns), every non-deleted session, all of `change_latest` (parsed),
all grants, users, machines, drafts, shipping orders and dependencies.

## 5. The write path and the feed

One gate: `Authority.commit` (packages/sync/src/authority/authority.ts:227) — authorize, arbitrate,
write and append to `changes` in one transaction, then broadcast. Broadcast evaluates visibility
for every subscribed user for every change, then frames and encodes once per connection. Resume
works from a cursor `(feedId, epoch, seq)` within a retention window of 20k rows or 3 days; outside
it the client re-bootstraps. Bootstrap and delta run in a worker thread on a read-only connection.

There is no row-by-id read and no history page on the sync surface; RPC listings
(`issues.list`, `tree`, `graph`, …) load a full repo listing and filter in memory, without cursor
or limit.

## 6. The client contract that is asked for (POD-4286 tree)

1. Active-first bootstrap: active rows, an "active complete" marker, then history, at one snapshot
   point (POD-5596). The active rule is shared code in `packages/model` (POD-5593, done).
2. History in small batches, applied as updates (POD-5592; pull vs push undecided, POD-5910).
3. Deltas since a cursor (exists), able to start before history finishes; needs a per-row version
   so a newer live value wins over an older history batch (POD-5597).
4. Rows and families by id, batched per 50 ms per client, answering row / removed / not visible
   (POD-5600, new route).
5. Per-user visibility on every path; "not visible" distinct from "deleted".
6. More record kinds in sync: full machine, repos and checkouts (per-machine visibility),
   approvals, pins, settings, threads, read position (POD-5620, POD-5802).
7. One subscribe path for live values and ordered logs, pushed, never polled (POD-5800, 5798).

No target number of concurrent clients is written down anywhere.

## 7. Prior decisions that bind this design

- SQLite dialect everywhere; drizzle over an async executor; bun:sqlite locally, hosted Turso via
  `@libsql/client/web`, no Postgres (POD-3221 spec rev 12, POD-3268). Open: remote-only vs embedded
  replica (POD-3221 deferred decision 1). **Superseded in direction by the operator on 2026-10-15:
  hosted will be Postgres.**
- On Turso a round trip is ~95 ms; 371 statements one by one took 37 s against 0.22–0.88 s
  pipelined (POD-3251). Batching per operation is a precondition for remote execution.
- Visibility is evaluated only at the Authority; the replica never filters (ADR 2 Am1 D12.7).
- Change capture is declared at the write, in the same transaction (POD-247).
