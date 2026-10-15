# Server data access and caching — design

POD-6140, agreed with the operator on 2026-10-15. Status: written for approval; nothing built.
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
   (`… WHERE id IN (…)`), then joined in the operation.
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
  order is: build it correct, measure, then fix.
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

1. **Fresh baseline.** Take a new baseline with the POD-3810 event-loop accounting before the
   first change: busy share, stalls per minute, statements per minute and per daemon message,
   memory, boot time. Old numbers are stale and do not count.
2. **Foundations, with no behavior change:** prepared queries everywhere, the missing indexes and
   planner statistics, the cache interface, statement-count tests and a test that every
   repository query uses an index.
3. **Remove the copies one at a time, smallest first**, each as its own landing: users, grants,
   machines, pending counts, the world index, the two sync copies, the issue map, and the session
   map last. For each one:
   1. switch its readers to the database;
   2. in development builds, let old and new both answer for a while and log any difference;
   3. delete the copy;
   4. measure against a run with the old code as the control.
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
