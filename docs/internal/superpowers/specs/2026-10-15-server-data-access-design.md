# Server data access and caching — design

POD-6140, agreed with the operator on 2026-10-15. Status (2026-10-18): built on the integration branch; every
memory copy in section 6 is removed; measured (E1, docs/measurements/pod-6140-result.md); the measured hot paths
are fixed (F lanes); the re-measure (E3) is running. See section 11.
Evidence behind every claim: [pod-6140-research.md](../../pod-6140-research.md).

## 1. Goal and scope

Shape the server into a typical SaaS server that serves many clients well, starting with how it
reads, writes and caches data. The database becomes the single source of truth, accessed the
right way, with no copies of tables held in memory.

**Direction, as context only.** The deployment path is: one self-hosted server for one user with a
local database (today) → several users on one local server → cloud hosting → multi-tenant cloud.
Hosted will most likely be Postgres. This design does not build any of those steps; it only refuses
to make them harder. In particular it never assumes that one process holds all the data.

**In scope:** the source-of-truth rule, rules for database access, caching, how queries execute,
removing the in-memory copies, rollout and measurement, and a spike on the new Turso database.

**Out of scope:**
- The sync system: active-first bootstrap (POD-5596), fetch-by-id (POD-5600), history pages, fan-out
  to many clients, the shared change log and its ordering, and the `change_latest` table itself.
  These belong to a later sync design. Writes keep going through one writer at a time, as today.
- Per-hot-path optimizations decided up front. They come after the rules are in place and fresh
  measurements show where the time goes.
- The move to Postgres, multi-user, cloud and multi-tenant work.
- Flightdeck (being rewritten).

## 2. Source of truth

The database is the only source of truth for stored facts. The server never holds a full copy of
a table in memory. Memory may hold only:

1. **Live runtime state** that is not stored facts: connected daemons, running sessions and their
   terminals, presence. It grows with activity, not with history.
2. **Declared caches**, under the rules in section 4.
3. **One-operation memos**: the existing read scope, which deduplicates lookups inside one
   operation and is gone when the operation ends.

**One way to read a fact.** Today a fact can be read from a memory copy or from the database. A
memory copy cannot see a save that is still in progress, so during a save the code must skip the
copy and ask the database. The two paths can disagree, and the workaround still sends many reads to
the database. With the database as the only place, every read asks the database. During a save the
database already shows that save's own unfinished changes. There is no special case and nothing to
keep in step.

**Boot** no longer loads whole tables. It loads live runtime state only.

## 3. Rules for using the database

These are general rules, not per-path solutions. Applied everywhere, they remove most of today's
wasted work; the remaining hot paths are then found by measurement and fixed one by one.

1. **Prepared once.** Every query is defined and prepared once, then reused. It is never rebuilt per
   call or per transaction.
2. **No query inside a loop.** Data for a set of rows is loaded with one query per table
   (`… WHERE id IN (…)`), then joined in the operation. Two standard tools: drizzle's relational
   queries (`with`) when an operation loads rows with their children, and a per-operation
   `dataloader` (the DataLoader pattern, on the existing read scope) when many call sites each
   ask for one row by id.
3. **Indexed lookups.** Every column used to look rows up has an index. The planner's statistics are
   kept current (`PRAGMA optimize` at boot and on a timer).
4. **Work in SQL.** Filtering, sorting, joining and counting happen in SQL, never by loading rows
   into JavaScript and working on them there.
5. **Read only what is needed.** Select the columns that are used. Lists come in pages with a limit
   and a cursor. Never load a whole table.
6. **SQL lives in repositories.** Services ask by intent ("active issues visible to user U, next
   page") and never compose queries themselves.
7. **Short transactions.** One operation is one short transaction with as few round trips as
   possible. Nothing inside it waits on the outside world.
8. **Statement counts are pinned.** Tests fix how many statements each operation runs, so the
   count cannot grow with the amount of data.
9. **Portable SQL.** New SQL avoids SQLite-only features where a portable form exists, so a later
   move to Postgres touches repositories only.

## 4. Caching

- **The default is no cache.** A cache is added only after a fresh measurement shows the need. The
  order is: build it correct, measure, then fix. The cache layer itself is built when the final
  measurement shows the first real need, not before.
- **One interface.** Every cache sits behind one interface: get, get many, set, delete by key. The
  first implementation is an in-process LRU; a Redis implementation can replace it later without
  touching callers.
- **Declared.** Each cache is registered with: what it holds, its key, an entry limit, and the
  committed table writes that remove its entries. A test proves that a write removes the entry.
- **Removed key by key, after commit.** Never "throw the whole cache away on a write".
- **Never read inside a save.** A save always reads the database.
- **Never a whole-table copy.** There is no exception for small tables: with several users or
  tenants, "small" is multiplied, and several processes cannot share one in-memory copy.

## 5. How queries execute

- **Async everywhere.** Every data call is awaited through the existing store interface (POD-3221).
- **No new worker machinery.** On bun:sqlite a query still runs on the server's thread, so rules 5
  and 7 keep each query short. On Postgres the driver is truly async and this works with no further
  change.
- **The driver interface stays.** It is the seam where another engine plugs in.
- **Writes stay one at a time**, as today.
- **Turso spike** (section 8): if the new Turso database runs our store well, it can give truly
  async execution now while staying on SQLite and self-hostable, which makes the later move to
  Postgres smoother.

## 6. What gets removed

Each item below is removed by switching its readers to the database under the rules above, then
deleting it. Readers that need runtime state keep reading memory.

| copy | where | what replaces it |
|---|---|---|
| Users copy (unused today) | `modules/world-index/index.ts:92` | delete; users are read by prepared id lookups |
| Grants copy | `world-index/index.ts:86`, `grant-reader.ts` | indexed grant queries |
| Machine copies | `world-index/index.ts:93`, `modules/machines/service.ts:392,395` | prepared machine queries |
| The world index (POD-3869) as a whole | `modules/world-index/` | removed once its last fact is gone |
| Pending-message counters | `world-index/index.ts:90-91` | indexed counts in SQL |
| Raw copy of `change_latest` | `packages/sync/src/adapters/sqlite/sync-repository.ts:118` | indexed reads of `change_latest` by key |
| Sync change baseline (the parsed copy of every record, used to skip unchanged updates) | `packages/sync/src/change-log.ts:195` | inside the same save, one primary-key read of the stored row in `change_latest`, or a stored hash, decides "unchanged" |
| Full issue map, with its viewer state, reference index and projection map | `modules/issues/service/core.ts:55-139`, `service/reads.ts:120` | repository queries |
| Observation checkpoint map (never shrinks) | `modules/sessions/observation-leases.ts:29` | checkpoint reads from the database (the open POD-3862) |
| Full session map | `relay.ts:684`, `modules/sessions/repository.ts` | shrinks to running sessions (runtime state only); everything else from the database |

The `change_latest` table stays until the later sync design decides its future.

## 7. Rollout

1. **Fresh baseline and a repeatable benchmark.** Before the first change: read today's numbers
   off the live server with the POD-3810 event-loop accounting (busy share, stalls per minute,
   statements per minute and per daemon message, memory, boot time), and build a repeatable
   benchmark (seeded corpus plus synthetic load) that every later landing runs against its parent.
   Old numbers are stale and do not count.
2. **Foundations, with no behavior change:** prepared queries everywhere, the missing indexes and
   planner statistics, the cache interface, statement-count tests and a test that every
   repository query uses an index.
3. **Remove the copies**, each fact as its own landing, ordered only where the code overlaps:
   the world index (users, grants, machines, pending counts, folder lookup, in that order) and the
   observation checkpoint map in parallel; then the two sync copies; then the issue map; the
   session map last. For each one:
   1. switch its readers to the database;
   2. prove the answers did not change: for the folder → issue lookup, both sync copies, the issue
      map and the session map, a test runs old and new over the benchmark corpus and edge-case
      fixtures and compares; the issue map and the session map are also compared at runtime in
      development builds before the copy is deleted. The smaller removals rely on the existing
      tests plus new focused tests;
   3. delete the copy;
   4. measure on the benchmark against the parent commit as the control, with the two runs
      interleaved.
4. **Measure and fix.** With the rules in place, find the remaining hot paths from fresh
   measurements and fix them one by one, adding a declared cache only where the measurement
   demands it.

## 8. Turso spike (separate, throwaway)

Runs alongside the foundations. It neither blocks nor shapes them, and its code is thrown away. It
answers three questions about the new Turso database (the Rust rewrite of SQLite,
`@tursodatabase/database`):

1. Does our store run on it under Bun, through a new driver behind our driver interface? The store
   test shard shows what breaks.
2. Does a heavy query still block the server's thread, measured next to bun:sqlite?
3. Which compatibility gaps do we hit? Known: no FTS5 (used by transcript search), no recursive
   `WITH`.

Concurrent writes are not part of the spike; writes stay one at a time.

## 9. How we know it worked

- No whole-table copy in memory: server memory grows with live activity, not with total issues and
  sessions; boot loads no whole table.
- Every operation's statement count is pinned by a test and does not grow with data.
- Every repository query is served by an index.
- The old-versus-new comparison stays clean for each removed copy.
- Measured against the fresh baseline: memory, boot time, busy share and stalls are no worse after
  each landing, and better at the end.

## 10. Waiting on the operator

- Defer POD-3271, POD-3272 and POD-3909 (the old hosted-Turso track) with a note that hosted will
  be Postgres, and add the note to POD-3268. They are outside this issue's subtree.
- File the Turso spike as a sub-issue of POD-6140.

Found during research, not decided here (candidates for their own issues): `applied_mutations`
holds 2.15 GB of the 3.58 GB database with no size limit, and the change log keeps only 20k rows
or 3 days.

## 11. Sub-issues

Prefix letters are phases, numbers the order inside a phase. Blocking edges in the tracker enforce
"waits on".

| prefix | step | issue | status |
|---|---|---|---|
| A1 | Rules doc (`docs/agents/server-data.md`) | POD-6145 | done |
| A2 | Benchmark and live baseline | POD-6146 | done |
| A3 | Prepared repository queries (root cause first: one shared drizzle instance) | POD-6147 | done |
| A4 | Turso spike | POD-6162 | done (report only) |
| B1 | Indexes and query-plan audit | POD-6148 | done |
| B2 | Statement-count tests, relational queries and per-operation loaders | POD-6149 | done |
| B3 | Index-friendly query shapes (audit debt) | POD-6173 | done |
| B4 | Delivery flush batching | POD-6174 | done |
| B5 | Activity flush batching | POD-6175 | done |
| B6 | Grant reads inside writes (per-operation scope, fixes C1's measured regression) | POD-6189 | done |
| B7 | Loader batches per context | POD-6197 | done |
| R0 | Integration rebase onto dev/mw | POD-6183 | done |
| C1 | Remove the world index (five steps) | POD-6155 | done |
| C2 | Remove observation checkpoint map | POD-6159 | done |
| C3 | Remove sync memory copies (two steps) | POD-6156 | done |
| D1 | Remove full issue map | POD-6158 | done, e61e461a2a |
| D2 | Session map to running sessions | POD-6160 | done, b3b0ebeeed |
| D3 | Remaining whole-table reads (audit debt, 42 -> 32 entries, each with a reason) | POD-6172 | done, 206eafd6f4 |
| D4 | Bug: session auto-archive never awaited | POD-6206 | done |
| D5 | Parked session writes read the row once per operation | POD-6210 | done, 750c077c40 |
| D6 | Shipping recovery walk reads only open trains | POD-6207 | done, 5fb5b06a5b |
| D7 | Steward reads only matching subscriptions | POD-6208 | done, d22a8d24ee |
| D8 | Paged history listings | POD-6209 | done, e4140918a5 |
| D9 | Bug: search batch reads (also on dev/mw 0c37f9eb50) | POD-6214 | done, ae0361d75f |
| D10 | Bug: per-row conversation segment reads | POD-6215 | done, 0225cfa214 |
| E1 | Final measurement | POD-6161 | done, 957c797722 |
| F1 | Board projection drain (cursor write per batch, then only after an effect) | POD-6216 | done, 2d389d87b5, 11ab04ade0 |
| F2 | Grant reads once per change | POD-6217 | done, e617c446a5 |
| F3 | Earliest admin, settings and account reads once per operation | POD-6218 | done, d40ed2cc78, b3155cc330 |
| F4 | Delivery triggers read nothing; the flush checks targets | POD-6219 | done, 197ab798ca |
| F5 | Login credential once per request | POD-6220 | done, dc82fc3c44 |
| F6 | Boot whole-table reconcile | POD-6221 | deferred (sync scope, operator decides) |
| F7 | Boot ref backfill reads only candidates | POD-6222 | done, d7b4eb2f87 |
| F8 | Planner statistics floor for tables analysed while tiny | POD-6223 | done, a10462026a |
| F9 | Three unexplained test failures (two fixture bugs, one shutdown race) | POD-6226 | done, 08b8f422e8, 84c5715e0d, 0b510d72ad |
| F10 | Statement-count coverage of the remaining operations | POD-6227 | done, 606dca28a4 |
| F11 | Delivery pass reads an issue's members once | POD-6229 | done, 798f8b30c0 |
| F12 | Change log latest-state writes | POD-6228 | deferred (sync scope, operator decides) |
| F13 | Runtime payload reads in id order | POD-6224 | done, 003daba66d |
| F14 | Delivery pass reads its sender once (pin) | POD-6231 | done, 7c3a9e912b |
| E3 | Re-measure after the F lanes | POD-6230 | running |
| E2 | Cache interface (deferred until a measured need) | POD-6150 | deferred; no lane measured a need |

D4 to D10 and F1 to F14 were found while building or measuring; each was filed with its evidence and landed on its
own.
dev/mw holds the integration branch up to 0c37f9eb50 (D2f); everything after it waits for the
operator's go-ahead.

POD-6151 to POD-6154 were merged into POD-6155 and POD-6157 into POD-6156 (superseded).
