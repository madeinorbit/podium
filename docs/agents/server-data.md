# Server data

How server code (`apps/server`, `packages/sync`) reads, writes and caches data. Every server change follows this guide. It is the server side of [frontend-data.md](frontend-data.md). The agreed design behind it is `docs/internal/superpowers/specs/2026-10-15-server-data-access-design.md` (POD-6140); the evidence is `docs/internal/pod-6140-research.md`.

Today the server still holds several in-memory copies of tables (the world index, the issue map, the session map and others). POD-6140 removes them one at a time. Until a copy is removed, leave it as it is; new code reads the database and adds no copy.

## Source of truth

The database is the only source of truth for stored facts. The server never holds a full copy of a table in memory.

Memory may hold only:

| What | Example |
|---|---|
| **Live runtime state** that is not a stored fact. It grows with activity, not with history. | connected daemons, running sessions and their terminals, presence |
| **Declared caches**, under the rules in "Caching" below | none yet; the cache layer is built only when a measurement shows the first real need (POD-6150) |
| **One-operation memos**: the read scope, which removes repeated lookups inside one operation and is gone when the operation ends | `withReadScope` and `readScopeSlot` in `apps/server/src/store/executor/read-scope.ts` |

**One way to read a fact.** A memory copy cannot see a save that is still in progress, so during a save the code must skip the copy and ask the database; `readIssueCwdRows` (`apps/server/src/modules/world-index/issue-reader.ts:70`) does exactly this with `!spanOpen()`. When every read asks the database, the database already shows the save's own unfinished changes, so there is no special case and nothing to keep in step.

**Boot** loads live runtime state only. It never loads whole tables.

## Rules

Each rule has the reason for it and an example from this repository.

1. **Prepared once.** Every query is defined and prepared once, then reused. It is never rebuilt per call or per transaction.
   - Why: building a query in JavaScript costs far more than running it.
   - Example: preparing sessions-by-id once cut each call from 256.6 µs to 28.8 µs, so about 89% of the call was query building (POD-3854). Every repository query is now a module-level definition such as `const sessionById = prepared((db: StoreDrizzle) => …prepare())` in `apps/server/src/store/sessions.ts`, called as `sessionById(this.db).all({ id })` (POD-6147).
   - How: the helpers are in `packages/sync/src/adapters/sqlite/prepared.ts`. A comparison value is `param(column, 'name')`, so the column's encoder still applies; a `.values()`/`.set()` entry is `sql.placeholder('name')`. A query whose text varies by call (optional filters, a patch with varying keys, an `IN` list) is a `preparedFamily` keyed by a finite shape, never by a value; an `IN` list is keyed by `inListSize(n)` (0, 1, then powers of two) and padded with `inListValues`, so the number of SQL texts does not grow with list length.
   - Transactions: the store hands every repository ONE drizzle instance over the executor's ambient client, which routes each statement to the current transaction when it runs. A query prepared once is therefore valid inside and outside transactions; never build a per-transaction instance.
2. **No query inside a loop.** Data for a set of rows is loaded with one query per table (`… WHERE id IN (…)`), then joined in the operation.
   - Why: a query per row makes the statement count grow with the data.
   - Two standard tools: drizzle's relational queries (`with`) when an operation loads rows with their children, and a per-operation `dataloader` (the DataLoader pattern, on the read scope) when many call sites each ask for one row by id.
   - Example: `buildProjectionPass` (`apps/server/src/modules/sessions/view.ts:204`, POD-3855) loads issues, grants and queue counts for all sessions in one pass into a `ProjectionPass`. `view.projection-pass.test.ts` pins the same statement count at 5, 50 and 200 sessions.
3. **Indexed lookups.** Every column used to look rows up has an index. The planner's statistics are kept current (`PRAGMA optimize` at boot and on a timer).
   - Why: without an index, a lookup reads the whole table; without statistics, the planner guesses.
   - Example: `messages.from_issue` has no index, so `listLedger` (its `ledger` query in `apps/server/src/store/messages.ts`) scans the whole `messages` table and sorts it in a temporary table. `ANALYZE` has never run on the live database (research §3).
4. **Work in SQL.** Filtering, sorting, joining and counting happen in SQL, never by loading rows into JavaScript and working on them there.
   - Why: rows loaded into JavaScript cost memory and main-thread time for every row, needed or not.
   - Example: `readIssueCwdRows` (`apps/server/src/modules/world-index/issue-reader.ts:70`) builds and sorts a row for every issue, several times per machine every five seconds, so that `access-index.ts:86` can pick one owner of a directory (POD-5941).
5. **Read only what is needed.** Select the columns that are used. Lists come in pages with a limit and a cursor. Never load a whole table.
   - Why: the cost of a read must follow what the caller needs, not how much data exists.
   - Example: `listLedger` caps its answer with `boundedLimit(q.limit, 200, 500)` (`store/messages.ts`). The RPC listings (`issues.list`, `tree`, `graph`) still load a full repository listing and filter it in memory, with no limit or cursor (research §5); new listings must not copy them.
6. **SQL lives in repositories.** Services ask by intent ("active issues visible to user U, next page") and never compose queries themselves.
   - Why: when all SQL is in one place, it can be prepared, indexed, counted and later moved to another engine without touching services.
   - Example: `MessagesStore.listLedger({ issueId, sessionId, limit })` (`store/messages.ts`) is an intent: "the delivery ledger for this issue or session". The caller does not know which columns or indexes answer it.
7. **Short transactions.** One operation is one short transaction with as few round trips as possible. Nothing inside it waits on the outside world.
   - Why: writes run one at a time, so a long transaction holds up every other write; on a remote database each round trip costs a network trip.
   - Example: `Authority.commit` (`packages/sync/src/authority/authority.ts:227`) authorizes, writes and appends the change in one transaction, and broadcasts only after the commit. On Turso a round trip was about 95 ms, and 371 statements sent one by one took 37 s against 0.22–0.88 s sent together (POD-3251).
8. **Statement counts are pinned.** Tests fix how many statements each operation runs, so the count cannot grow with the amount of data.
   - Why: a query added inside a loop is invisible in review and on small test data; a pinned count fails at once.
   - Example: `apps/server/src/store/prepared-loop-scaling.test.ts` counts query construction and execution at drizzle's prepare step, so a rebuilt query or a per-row query fails the test. `view.projection-pass.test.ts` (rule 2) pins a count across sizes.
9. **Portable SQL.** New SQL avoids SQLite-only features where a portable form exists, so a later move to Postgres touches repositories only.
   - Why: hosted Podium will most likely run on Postgres.
   - Example: `worktreesOfSessions` in `apps/server/src/store/user-layout.ts` matches ids with `in (select value from json_each(…))` over a JSON string. A plain `IN (…)` list (`inArray`) says the same thing in portable SQL.

## Caching

1. **The default is no cache.** Add a cache only after a fresh measurement shows the need. The order is: build it correct, measure, then fix.
2. **One interface.** Every cache sits behind one interface: get, get many, set, delete by key. The first implementation is an in-process LRU; a Redis implementation can replace it later without touching callers. The cache layer itself (POD-6150) is built when the final measurement shows the first real need, not before.
3. **Declared.** Each cache is registered with:
   - what it holds;
   - its key;
   - an entry limit;
   - the committed table writes that remove its entries.

   A test proves that a write removes the entry.
4. **Removed key by key, after commit.** A write removes only the entries it changed, and only once its transaction has committed. Never throw the whole cache away on a write. (Today `latestChangeStatesCache` in `packages/sync/src/adapters/sqlite/sync-repository.ts` is dropped whole on every append and read again in full on the next visibility check.)
5. **Never read inside a save.** A save always reads the database.
6. **Never a whole-table copy.** There is no exception for small tables: with several users or tenants, "small" is multiplied, and several processes cannot share one in-memory copy.

## How queries execute

1. **Async everywhere.** Every data call is awaited through the existing store interface (POD-3221).
2. **No new worker machinery.** On bun:sqlite a query still runs on the server's main thread (one connection, `readConcurrency: 0` in `store/executor/bun-driver.ts:58`), so rules 5 and 7 keep each query short. On Postgres the driver is truly async and this works with no further change.
3. **Writes stay one at a time**, as today.
4. **The driver interface stays.** `apps/server/src/store/executor/driver.ts` is the seam where another engine plugs in.

## What a change must show

| A change that… | must show | automatic check |
|---|---|---|
| adds or changes a repository query | it is prepared once (rule 1) | `apps/server/src/store/prepared-guard.test.ts`: a source census of per-call builders (with an explicit allowlist) and a runtime preparation count (POD-6147) |
| adds or changes a lookup | the query-plan audit passes: the query is served by an index (rule 3) | added by POD-6148 |
| adds or changes an operation that reads or writes | its statement count is pinned by a test and does not grow with data (rule 8) | added by POD-6149 |
| adds a cache | a measurement that shows the need, its declaration, and a test that a write removes the entry | added with the cache layer, POD-6150 |
| removes an in-memory copy | before the copy is deleted, proof that the answers did not change: for the folder → issue lookup, both sync copies, the issue map and the session map, a test that runs old and new over the benchmark corpus and edge-case fixtures and compares (the issue map and the session map also at runtime in development builds); for the smaller copies, the existing tests plus new focused tests. After, the benchmark against the parent commit, the two runs interleaved | benchmark added by POD-6146 |
