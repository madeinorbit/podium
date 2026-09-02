# Drizzle async query layer — investigation and plan (POD-3221)

Status: investigation, 2026-09-02. Nothing here is implemented.

The ask: move the server's SQL queries to drizzle-orm and make them async, so that the cloud
version can potentially run on Postgres and the self-hosted version can potentially run on
Turso (libsql). This document records what exists today, what has to change, the order to do
it in, and the traps.

**Short version.** Three separable projects hide inside one sentence, and they have very
different costs:

| Project | What it buys | Blast radius |
|---|---|---|
| A. Drizzle query builder over the existing sync `bun:sqlite` connection | Typed queries from the schema we already maintain, one truth for column names/types, a query logger, fewer hand-written row mappers | ~530 `prepare()` sites in 45 repository files. Local to the store. |
| B. Async repositories with an explicit executor (`db` or `tx`) | Driver independence *within the SQLite dialect*: `Bun.SQL`, libsql remote (Turso), Cloudflare D1/DO-SQLite | The whole server domain: ~620 repository methods, ~750 synchronous service methods, the sync kernel's Ledger/Authority ports, boot, 107 test files |
| B′. Backend enablement | A second backend can boot, migrate, search, back up, shut down and serve the external clients | Ports for open/migrate, search, durability, transfer and the operator clients; per-backend acceptance |
| C. Postgres dialect | A Postgres backend, in a tenant topology still to be decided (database or schema per tenant, or shared tables with a tenant key everywhere) | A second schema (88 tables), a second migration journal, FTS port, a data-copy tool, a transactional feed-head allocator, and the durability subsystem, which is file-level today |

A and B are worth doing and can be sequenced so that B is a decision gate rather than a
prerequisite. **This issue's outcome is "prepared for Postgres", proven by a dual-backend
vertical slice, not "Postgres-ready"** (rev 11, final review finding 1): B′ acceptance can only
run against a backend that C builds, and no stage in this issue implements Postgres query
bodies, which the SQLite drizzle tables cannot provide. A functioning Postgres backend, its
concurrency model, its rollout from SQLite and its acceptance are a later epic; this document
records their requirements in Stage C so that nothing done here forecloses them. C stays out of
scope until the cloud architecture decision is taken, because the cloud proposal on record is
instance-per-tenant SQLite with no shared database
(`docs/cloud/multitenant-cloudflare-architecture.md`), the current schema is single-tenant by
construction (`feed_identity.singleton`, `meta.key`, natural keys without a tenant component), and
Turso is SQLite-dialect, so B plus B′ gets you Turso without a schema twin.

---

## 1. What exists today

### 1.1 Runtime and driver

- Bun is the only shipped runtime. The migrator refuses `node:sqlite`
  (`apps/server/src/migrations/index.ts:229-244`); the release is one `bun --compile` binary
  (`scripts/build-bun.ts`). The `node:sqlite` adapter in `packages/runtime/src/sqlite/node.ts` is
  only reached by the Node test lane.
- The persistence seam is `SqlDatabase` (`packages/runtime/src/sqlite/types.ts`): `prepare()`
  with positional `?` params, sync `run/get/all`, `exec`, `close`. There is a documented "no
  native addon" constraint so the compiled binary stays self-contained.
- One shared connection per process. The nesting-safe `transaction(db, fn)` helper
  (`packages/runtime/src/sqlite/transaction.ts`) keys depth on the handle object and **throws if
  `fn` returns a thenable**. That guard is load-bearing for the sync kernel (next section).
- Bun 1.3.14 ships `Bun.SQL` with a SQLite backend (`new SQL('sqlite://…')`), async, with
  `begin()` transactions. Verified locally in this worktree.

### 1.2 Query surface

| What | Count | Where |
|---|---|---|
| Repository classes | 34 | `apps/server/src/store/*.ts`, `store/conversations/*`, `modules/operations/store.ts`, `packages/sync/src/adapters/sqlite/sync-repository.ts` |
| `.prepare(` call sites in those repositories (non-test) | 529 | shipping 77, issues 59, sessions 42, workflows 33, messages 33, repos 28, … |
| Repository method signatures | ~620 | the async blast radius inside the store |
| `transaction(this.db, …)` inside repositories | 41 | shipping 19, observation-checkpoints 4, conversations 5, … |
| Store call sites from services (non-test) | 574 | 45 files; relay.ts 56, superagent/service.ts 56, issues/service/reads.ts 43 |
| Store call sites in tests | 1,840 | 92 test files |
| `new SessionStore(` | 475 | 107 test files plus server.ts, relay.ts, daemon recovery worker, scripts |

Style: no base class, no shared query helper, no prepared-statement cache. Every site is
`this.db.prepare(sql).get(...) as Row` plus a hand-written mapper
(`apps/server/src/store/sessions.ts:129` spells out 49 columns). Repositories close over the
shared handle; there is no executor parameter.

### 1.3 Drizzle today

- `drizzle-orm` and `drizzle-kit` are pinned at `1.0.0-rc.4` in three package.json files. Only
  the **migrator** runs at runtime (`apps/server/src/migrations/index.ts:249-258`, via
  `drizzle-orm/bun-sqlite` on the raw `bun:sqlite` handle). No repository uses the query builder.
- Schema-as-code exists and is complete: 84 `sqliteTable` in
  `apps/server/src/migrations/schema.ts` and 4 in `packages/sync/src/adapters/sqlite/schema.ts`.
  Column conventions: text ISO timestamps, integer 0/1 booleans (no `mode: 'boolean'`), JSON as
  text (23 `mode: 'json'`), 64 CHECK constraints (3 use `GLOB`), 73 indexes, 36 `brandedRef()`
  calls through a helper typed against `sqlite-core` only (`apps/server/src/migrations/branded-ref.ts`).
  Nothing uses `unixepoch()`, `strftime`, blobs, custom types or generated columns.
- 87 migrations, all drizzle-kit generated, inlined into `drizzle-manifest.generated.ts` for
  the compiled binary. 13 of them use SQLite's `__new_` table-rebuild pattern with
  `PRAGMA foreign_keys` toggling. FTS5 is **not** in migrations: `conversations_fts` and
  `transcript_fts` are created per boot (`apps/server/src/store/conversations/index.ts:17`).
- ADR 6 D5.3 (`docs/adr/0006-replica-storage.md:213-215`) currently says: "Server repositories
  keep raw SQL; drizzle is schema-authoring + migration apply only." This issue reverses that
  decision and the ADR needs an amendment.
- Installed adapters in `drizzle-orm@1.0.0-rc.4`: `bun-sqlite` (sync and async API),
  `bun-sql` (with `sqlite`, `postgres`, `mysql` sub-drivers over `Bun.SQL`, async,
  built on `sqlite-core/async`), `libsql`, `node-postgres`, `postgres-js`, `pg-core`,
  `sqlite-proxy`, `d1`, `durable-sqlite`. No drizzle patches in `patches/`.

### 1.4 The sync kernel is synchronous by decision, not by accident

- `packages/sync/src/authority/ports.ts:106` — `TransactPort = <T>(fn: () => T) => T`.
  `AuthorityPort.commit` is sync. `Ledger.commit` (`packages/sync/src/ledger.ts:235-261`) runs the
  entity write and the change-log append in ONE transact span (ADR 2 D10) and rejects an async
  `write()` explicitly (`authority.ts:211-217`). Publication is a post-commit tail: `finalize`
  folds the baseline and broadcasts only after `transact` has returned (`authority.ts:452-488`).
- ~25 non-test `ledger.commit(` sites in 18 service files; `Ledger` is the single writer of the
  change log, and global `seq` arbitration happens inside that transaction (D12.6).
- `packages/sync/src/adapters/sqlite/sync-repository.ts:71` derives a contiguous seq range by
  arithmetic from `lastInsertRowid` after a batched insert. That is only correct while no other
  writer can interleave.
- The client replica ports (`ReplicaCacheStore`, `packages/sync/src/replica/ports.ts:93`) are
  sync too, and the mobile adapter documents why (`mobile-sqlite/sql.ts:26-36`). Client replicas
  (IndexedDB, expo-sqlite, Tauri SQL) are **out of scope** for this work: ADR 6 D5.1 keeps them
  off drizzle, and `drizzle-orm` is on the browser-forbidden list
  (`scripts/check-boundaries.ts:713-714`).
- Lint: `sync-kernel-purity` (`scripts/check-boundaries.ts:564-580`) forbids `drizzle-orm`,
  `bun:*` and `@podium/runtime/sqlite` anywhere in `packages/sync/src/` outside `adapters/`. The
  ports can become async; they must not grow drizzle types.

### 1.5 Code that silently assumes "no yield between two store calls"

These are the places where "make it async" changes correctness, not just signatures:

1. **Frame read caches** premised on the microtask boundary: `apps/server/src/store/issues.ts:33-96`
   (issue frame cache, invalidated with `queueMicrotask`), `store/users.ts:55-90`
   (`frameAccounts`, 1,221 reads in one frame in the profile that motivated it),
   `relay.ts:1153-1161` (`closedIssueIdsThisFrame`). The premise "a row cannot change inside a
   frame that never yields" is false once the store awaits.
2. **Repos registry cache** invalidated by a sync proxy that inspects SQL text
   (`store/repos.ts:32-113`), and a second unwrapped handle `txDb` (`repos.ts:64-77`) that exists
   only because transaction depth is keyed on handle identity.
3. **Getters and constructors** that read the store: `modules/issues/service/core.ts:207-210`
   (`get rows()` lazily hydrates from `listIssueRows()`), `core.ts:130-135`,
   `modules/superagent/service.ts:264` (constructor), `modules/memory/service.ts:67`
   (constructor), `relay.ts:431` (constructor reads settings).
4. **Sync predicates handed to the kernel**: `feed-visibility.ts:171-219, 464-469` are boolean
   callbacks the `FeedVisibilityPolicy` calls per row; `modules/sessions/session-authz.ts:79-85`
   reads users on every command; `modules/operations/engine.ts:162` and three launch/workspace
   resolvers read settings inside sync lambdas.
5. **Store calls inside array callbacks**: `modules/issues/service/mail-pending.ts:38`,
   `modules/issues/service/core.ts:960` (inside a `ledger.commit` write span).
6. **Read-decide-write spans** in `modules/lock/service.ts:339-549` (7 `transact` bodies) and
   `modules/messages/service.ts:225, 846`.
7. **Boot** is synchronous end to end: `new SessionStore()` opens, sets PRAGMAs, migrates,
   builds 34 repositories and runs four boot heals in the constructor
   (`store.ts:199-330`). The pre-migrated test fixture states the dependency outright:
   "`SessionStore`'s constructor cannot await anything" (`test-support/pre-migrated-store.ts:50-52`).
8. **Process-memory mirrors written in the same synchronous frame as a store write, and
   interval callbacks with no single-flight guard** (rev 10.1, F8). `shipping/service.ts:1792,
   2311` set `this.leases` after `ledger.commit`, and `tick()` and `reconcile()` read them;
   `sessions/inbox.ts:688-700` deletes the queued row, then decrements the in-memory count,
   then persists; `messages/service.ts:850-861` emits and marks delivered after its span.
   `MessageScheduler.sweep()` (`scheduler.ts:345`) and `approvals.sweepStalledExecutions()`
   (`relay.ts:2690`) are interval callbacks that are safe today only because they are
   synchronous; `inbox.drain` already has a single-flight guard. Under async a second `tick()`
   can see an attempt row whose lease is not yet in memory, and overlapping sweeps can
   re-inject a message mid-delivery.
9. **Mutable process-owned objects mutated before commit and restored by assignment on
   failure** (rev 11, final review finding 2). Issue rows are map-owned mutable objects:
   `update` applies `Object.assign(row, patch)` and then persists (`issues/service/crud.ts:
   959-1007`); `persistWith` documents the mutate-then-commit order as a synchronous assumption,
   snapshots the row, mutates it, calls `ledger.commit`, and on a throw restores the snapshot
   into the same object (`issues/service/core.ts:875-924`). Sessions are the same shape:
   `mutateSessionMeta` mutates the live `Session` inside the write callback
   (`session-meta-ops.ts:323-332`) and the repository restores captured state into it on
   rollback (`sessions/repository.ts:326-359`). Once acquiring the write lane is an await, the
   map holds uncommitted values while another request reads or mutates it, and a later rollback
   restores an old snapshot over a second operation's committed change. The scheduler
   serialises the database executor; it does not serialise reads of `IssueService.rows`, live
   `Session` objects, shipping leases or any other process-owned projection. Step 14a is the
   audit.

### 1.6 Other processes on the same database file

| Who | Access | Consequence under Postgres |
|---|---|---|
| Janitor (`apps/janitor/src/janitor.ts:1250`, hosted in a worker thread of the server process since POD-2505, `apps/server/src/janitor-host.ts`) | second connection, read-only, `query_only` | becomes a client with its own role |
| `podium auth mint-session` (`packages/runtime/src/session-mint.ts:116`) | second **writer** | must go through the server, not the DB |
| Daemon transfer (`apps/daemon/src/server-transfer.ts:350`) | opens a staged candidate `podium.db` | file-level; no analogue |
| Migration ledger guard (`packages/runtime/src/migration-ledger.ts:58`) | reads `__drizzle_migrations` | needs a client |
| Backup, restore, snapshot verifier, `wal_checkpoint`, transfer fence, Litestream plan | copy the file, `PRAGMA quick_check` in a child | entire subsystem is per-backend |
| Harness caches (`packages/harness/src/discovery/cache.ts`, codex/opencode readers) | their own or foreign DBs | out of scope |

### 1.7 SQLite-only SQL in runtime queries

| Construct | Count | Portable? |
|---|---|---|
| `INSERT OR REPLACE` | 13 (+1 in `session-mint`) | No. It deletes and re-inserts: fresh rowid, and every unnamed column resets to its default. None of the target tables is a foreign-key parent, so no cascade is involved (rev 10.1). Convert only with every column named. |
| `INSERT OR IGNORE` | 12 | `onConflictDoNothing` on both dialects |
| `ON CONFLICT … DO UPDATE` | 38 | yes |
| `RETURNING` | 1 | yes |
| bare `rowid` in SQL | ~15 uses in 10 files | No. Tables that order or address by `rowid` need an explicit integer PK. |
| `lastInsertRowid` | 3 | Replace with `RETURNING` |
| `PRAGMA` at runtime | 10 | `journal_mode`, `busy_timeout`, `foreign_keys` OFF/ON around migrations, `wal_checkpoint`, `query_only` fence, `table_info` introspection in query paths (`store.ts:585`, `store/sessions.ts:887`) |
| `sqlite_master` | 8 | `information_schema` |
| FTS5 `MATCH`, `snippet()`, `bm25()` | ~44 refs | No. Postgres = `tsvector`/GIN; libsql supports FTS5. |
| `GLOB` in CHECK | 3 | `SIMILAR TO` / regex |
| `LIKE` | present | SQLite `LIKE` is ASCII case-insensitive; Postgres is case-sensitive (`ILIKE`) |
| Hand-built `?` placeholder lists with 999-variable chunking | several | Drizzle builds these; Postgres limit is 65,535 |
| `? 1 : 0` booleans, `=== 1` decodes | 16 / 72 | typed columns remove them |

### 1.8 Verified driver facts (measured 2026-09-02 on Bun 1.3.14 and on the 1.4.0 binary)

| Probe | 1.3.14 | 1.4.0 |
|---|---|---|
| `Bun.SQL` SQLite heavy query (535 ms) with a 1 ms timer running | 0 ticks: runs **on the event-loop thread** | same |
| Three concurrent `begin()` on one `Bun.SQL` SQLite connection | `cannot start a transaction within a transaction` | same |
| `begin("IMMEDIATE")` | not honoured | same |
| Two `Bun.SQL` connections on one file, concurrent read-then-write, busy_timeout 3 s | `database is locked` | not re-run |
| Two **bun:sqlite** connections, `BEGIN IMMEDIATE`, busy_timeout 3 s, an `await` inside the body | `database is locked` | not re-run |

The Bun docs state the model outright: "SQLite doesn't use connection pooling … Each `SQL`
instance represents a single connection", "SQLite executes queries synchronously … The API still
returns Promises", and `max` does not apply to SQLite. The 1.4 release notes change nothing here.

The last table row is the structural fact. SQLite's busy wait is synchronous. On one thread a
second connection waiting for the write lock blocks the very event loop that has to run for the
first connection's `await` to resolve and commit. Engine-level serialization therefore cannot
work for async transactions inside one thread, whatever the driver. Serialization has to be
done by whoever hands out the connection: a pool with many connections and a server that
arbitrates (Postgres), or a queue in front of the one connection (every in-process SQLite).

Other facts:

- Async over an in-process synchronous engine adds interleaving risk without adding
  concurrency. It buys portability to a networked database and nothing else. That is the honest
  trade of Stage B and the reason the store should not go async before there is a backend that
  benefits.
- `@libsql/client` for a **local file or embedded replica** loads a native `libsql` addon
  through a runtime loader with nine platform packages. `@tursodatabase/database` 0.7.2 (the new
  Rust engine) and `@tursodatabase/sync` are the same shape with four platform packages
  (darwin-arm64, linux-x64-gnu, linux-arm64-gnu, win32-x64; no darwin-x64, no musl). Bun can embed
  a `.node` file in a compiled executable only when it is required directly by path; the
  loader-based packages are what the open Bun issue #18909 is about. So local or embedded Turso
  is possible with a per-platform explicit require in `scripts/build-bun.ts`, at the price of the
  first native library in a binary that deliberately has none. `@libsql/client/web` and
  `@tursodatabase/serverless` are pure-JS remote clients and need none of this, at the price of
  a network round trip per query.
- libsql's local mode ignores `busy_timeout` and fails interleaving transactions immediately
  (libsql-client-ts issue #288); the community answer is a userland queue-and-retry package.
- Drizzle's `bun-sql/sqlite` migrator and `bun-sqlite` migrator both write `__drizzle_migrations`;
  the downgrade guard and the daemon convergence gate read that table, so the ledger format has
  to be confirmed identical before switching drivers.

### 1.9 What drizzle and the rest of the ecosystem do about async SQLite

- **Drizzle's bun:sqlite and better-sqlite3 drivers make the transaction callback synchronous.**
  `drizzle-orm/bun-sqlite/session.js` wraps the callback in bun:sqlite's own sync
  `db.transaction()` and returns whatever the callback returned. An async callback returns a
  Promise, the transaction commits at once, and the body runs afterwards in autocommit. That is
  the bug Podium's thenable guard exists to catch. Drizzle's answer for in-process SQLite is
  therefore the model the store already has.
- **Drizzle's async SQLite drivers do not serialize.** `sqlite-proxy` issues `begin`/`commit`
  on whatever callback you give it; `libsql` calls `client.transaction()` per transaction; both
  interleave on one connection and fail. Drizzle has no pool layer for SQLite; it delegates
  concurrency to the driver.
- **Drizzle's Postgres drivers need no application queue** because `db.transaction()` checks a
  dedicated connection out of `pg.Pool` and the server serializes. That is the one setup where
  the queue is somebody else's.
- **Every ORM that offers async SQLite ships the queue inside itself.** Prisma, Knex, TypeORM and
  Sequelize all run SQLite on a pool of size one, which is a queue by another name. A size-one
  async pool is about thirty lines. It is not an invention; drizzle just does not include it.
- Alternatives that avoid the queue and their cost: run the store on a worker thread with
  `sqlite-proxy` (real loop relief, but read-decide-write transactions still need a queue inside
  the worker), or run a server (`sqld`, Postgres), which is Stage C.

**The drizzle maintainers' position, from their issue tracker (checked 2026-09-02).**

- drizzle-orm #2275 "sqlite transactions can't be async for 4 of 5 implementations" (open since
  2024-05, labels `bug`, `priority`, 38 thumbs-up) and #1472 "Async SQLite transaction will not
  rollback" (open since 2023-11, 15 thumbs-up) are the two open issues under
  `qb/transactions` + `db/sqlite`. Both describe exactly the failure in the first bullet above.
- The only maintainer reply on either is a 2025-08-30 status message sent in batch to every open
  issue, describing the drizzle-kit rewrite and other branches; it does not mention SQLite
  transactions. The one contributor reply with content (#1723, 2024-02) is "Bettersqlite3 is
  only synchronous". The transactions documentation page still carries no SQLite warning.
- The community workarounds in #2275 are the two shapes described above: a userland
  `BEGIN`/`COMMIT`/`ROLLBACK` wrapper plus a single-flight promise queue so a second transaction
  waits for the first, or Expo's `withExclusiveTransactionAsync`, which opens a new connection
  per transaction. A community PR to add Bun.SQL SQLite support (#5103) was closed unmerged; the
  maintainers shipped their own `bun-sql/sqlite` driver in the 1.0 release candidates, and it
  delegates to `Bun.SQL`'s `begin()` with no queue, which is the behaviour measured in §1.8.
- rc.4's changelog: "Split SQLite into `async`, `effect` versions (`sync` remains subtype of
  `async`)". The 1.0 direction is async-shaped types for every SQLite driver, with the sync
  drivers' transaction callbacks left synchronous.

Net: after two and a half years there is no drizzle-level answer, and none is signalled. The
size-one queue is the community's answer and this plan's.

---

## 2. What we need to do

### Stage 0 — decide and record

1. Amend ADR 6 D5.3: drizzle becomes the query layer for the server store.
2. Decide the executor model up front. **A repository set bound to an executor, with the root
   set routing ambiently to the active transaction** (rev 10, Fable Stage B review F1):
   `store.x` is bound to the root, `tx.x` to a transaction, and the root set consults the
   transaction context in `AsyncLocalStorage`: inside a body, `store.issues.get(id)` runs on
   that body's transaction; outside, it runs through the scheduler. This is what makes "call
   sites keep their shape" true: there are 58 span-opening sites in 19 files, and the services
   they call (`LockService`, the issue service's `persistManyWith`, the messages service, the
   events repository via `appendEvent`) all hold the root store from construction, so an
   explicit unit-of-work parameter would have to thread through hundreds of service methods, the
   executor-parameter design of revision 7 one layer up. Ambient routing is today's semantics
   (one connection, everything inside the open `BEGIN`) and the server already carries request
   scope this way (`modules/issues/authority-arbitration.ts:35`). `tx.x` stays available where
   an author wants the binding visible, and the Authority takes the unit of work explicitly
   (step 11) because the same-client property must be visible in its types. A stale context
   (a continuation from a finished body) rejects. Ambient depth counting is retired. (Rev 8:
   replaces the executor-parameter design, review finding 9.)
   **Repository state is process-scoped and shared between the root and every tx set** (rev 9,
   Codex finding 5). The classes are not stateless query bags: `GrantsRepository` owns the
   visibility audiences and the revision counter the feed cache validates against
   (`grants.ts:87-112`, `feed-serving.ts:475-505`); `SyncRepository` owns the latest-state cache
   and its generation, which keys a larger feed-visibility cache (`sync-repository.ts:29-38`,
   `feed-visibility.ts:417-449`); issues, users and repos own caches and invalidation. A fresh
   instance per transaction would bump only its own revision or generation and leave the root's
   feed cache valid after a grant write, which is stale authorisation after a revoke. So
   executor-bound query operations are separated from one `RepositoryRuntimeState` graph that
   root and tx sets share; invalidation and audience/head publication happen after commit
   (rollback may invalidate, never publish); and the three cross-aggregate callbacks
   (sessions → observation checkpoints, issues → repos, repos → issues, `store.ts:227-236`) are
   bound within the set being built, never to the store's root fields. Tests write through a tx
   set and assert that root grants, the feed world, the sync generation and the repo and issue
   caches observe the result, and that a rollback publishes nothing.
   **Read-your-writes inside a body** (rev 10, F8): the sync repository invalidates its
   latest-state cache inside the Authority's span and `visibilityEdge` reads it in the same
   span, so "invalidate at commit" alone would serve a pre-append cache to an in-span read. The
   transaction-bound set never serves from shared caches: it reads through, or keeps a
   transaction-local cache discarded at the end. Shared caches are invalidated in the unit of
   work's after-commit hook (step 12); rollback discards the local cache and may invalidate
   the shared one.
3. Decide whether B (async) ships with A or after it. Recommendation below.
3a. **Tenant topology is postponed, with two seams kept open** (rev 9, Codex finding 8;
   decision 2026-09-02). Multi-tenancy is a later epic; this one is its preparation. The
   direction on record is tenant- or workspace-keyed tables, with the **workspace as the feed
   boundary**, and it is not decided here. Stages A and B do not depend on it as long as:
   (i) the feed-head allocator (step 16) is keyed by feed, never a singleton, so a workspace
   key is a column added later and not a redesign; and (ii) the executor and unit of work have
   a place to carry a context value (today empty), so tenant scoping can later travel with the
   transaction rather than with each query. Stage C and the Postgres schema twin wait for the
   decision. No revision of this plan claims "a shared multi-tenant database" as an outcome.
3b. **Prototype the two hardest boundaries before converting any repository** (rev 9): a tiny
   executor proof with the connection queue, an active transaction token, nested savepoints, the
   post-commit tail and async close; and **a dual-backend vertical slice** (rev 11, finding 1,
   replacing the allocator-only spike): locks, one representative aggregate with joins and JSON
   columns, the sync append with the transactional feed-head allocator, boot and shutdown, on
   real SQLite and real Postgres through a real pool. The slice proves that a rollback leaves no
   sequence hole and that the entity row and the change row share one checked-out client, and
   it **chooses the dialect-query strategy** from measured code: explicit SQLite and Postgres
   repository adapters under shared domain mappers, generated dialect-specific query modules
   from a constrained description, or a dialect-neutral builder (the Kysely alternative in §8).
   It also chooses the schema-twin technique (§Stage C step 18). Their results fix the
   interfaces every later issue uses. The executor prototype settles, with the service-layer count in
   hand: ambient routing versus an explicit unit-of-work parameter (F1), the three-lane
   scheduler port (F5) and the after-commit hook (F7); the Postgres spike exercises the `read`
   lane's snapshot isolation (rev 10). The prototype includes a service-shaped write closure
   using narrowed deps, and the cross-service span `issues.shippingCommitMany`
   (`shipping/service.ts:2204-2215`, an issues-service commit whose `write` calls shipping
   repository methods), because that is the shape the executor design must survive; services
   hold narrowed dependency lambdas built in `relay.ts`, not the store, so the design cannot
   assume a `uow` in their deps (rev 10.1, F1). `store.outsideTransaction(fn)` is the one
   explicit way to read a committed view from inside a body; nothing uses it yet.
4. Driver for the SQLite path: **keep `bun:sqlite`**. `Bun.SQL`'s SQLite mode is a Promise
   wrapper over the same engine on the same thread, ignores transaction modes, and has no queue
   (§1.8), so it buys nothing and loses `serialize/deserialize` (the fast test fixture) and the
   file-level backup path. Both are builtins and survive `--compile`.

### Stage A — drizzle query layer (sync driver, unchanged call sites)

5. Add a `Database` type = drizzle instance built from the schema
   (`drizzle(client, { schema })`), created in `store.ts` next to the migrator on the same raw
   handle. Keep the `SqlDatabase` seam alive for the non-store consumers in §1.6.
   **Drizzle bypasses the `SqlDatabase` wrapper**: it runs on the raw `bun:sqlite` handle from
   `bunSqliteClient`, so anything the wrapper did (query attribution, the repos cache proxy)
   stops seeing converted queries the moment the first one lands. Steps 5a to 5c therefore
   come **before** the first repository conversion (rev 8, review finding 3):
   5a. Move query attribution to the **execution seam, not drizzle's logger** (rev 9, Codex
       finding 10). The logger contract is `logQuery(query, params)` with no completion, row
       count, duration or error; the existing profiler measures wall time and rows including
       failures. So the raw `bun:sqlite` client handed to drizzle is wrapped at `prepare`/`query`
       so every statement drizzle runs is timed on completion with its rows, failure, normalised
       SQL and caller. A logger may supplement it for generated SQL. Parity tests for `get`,
       `all`, writes and thrown statements land before the first converted repository.
       Precisely (rev 10.1, F7): drizzle calls the client's `query()`, bun's **cached**
       statement API keyed by SQL text, and `stmt.values()` for array mode, never `prepare()`;
       the store today calls `prepare()` per call with no cache. So the wrapper wraps `query`
       and `prepare`, forwards `exec`, `transaction`, `serialize` and `values`, and registers
       itself with `aliasBunSqliteClient` so the migrator still finds the raw handle. Stack
       capture stays gated behind `PODIUM_LOOP_PROFILE`. Every converted query silently moves
       onto bun's statement cache, one cached statement per distinct SQL text including each
       `IN (…)` arity; step 17 measures statement count and RSS after a feed bootstrap.
   5b. Replace the repos registry cache's SQL-inspecting `prepare` proxy
       (`store/repos.ts:80-105`) with an invalidation the store owns and every writer calls,
       which its own header comment already asks for once a second bypassing writer exists.
   5c. Lint-forbid drizzle's `db.transaction` / `tx.transaction` everywhere; the only
       transaction boundary is the store's transact port. Drizzle's defaults to `deferred` and
       would emit a second `BEGIN` inside a wrapper-issued one.
   5d. The issues writer guard (`store-issues-row-cache-writers.test.ts`) finds writers by
       regexing SQL text; it is replaced by a scan for `.insert(issues)` / `.update(issues)` /
       `.delete(issues)` in the same sub-issue that converts `issues.ts`.
6. Convert repositories one aggregate at a time, smallest first (locks, accounts, read-watermarks,
   messaging-topics, approvals) to settle the patterns, then the five large ones last
   (shipping 2,683 lines, issues, sessions, messages, workflows). **Stage A uses the sync
   forms only** (`.all()`, `.get()`, `.run()`): a body that awaits makes the method async, and
   in Stage A that trips the frame caches, the transaction helper's thenable guard and the
   Authority's async-write refusal (rev 8, finding 1). Each conversion:
   - queries against `schema.ts` tables; typed selects replace the `as Row` casts;
   - `mode: 'boolean'` on the schema so mappers shrink (schema-only change, no migration);
     `mode: 'json'` is decided per column, in a schema-only commit **before** the aggregate
     converts: there are 23 such columns today, not five (rev 10.1, F4), and shipping reads all
     of its own through `jsonArray`/`jsonObject` (`shipping.ts:92-115`), which quarantine a
     corrupt value; a typed select on the schema as declared would throw inside `claimTrain`,
     which calls `listOrders()` three times in its transaction, so one corrupt blob would abort
     every train claim. Shipping keeps quarantine on every json-mode column. Each aggregate
     conversion adds one characterisation test that plants a corrupt blob and asserts the load
     survives, because no fixture does today;
   - `INSERT OR REPLACE` (13 statements in the server once step 9 retires the boot upgrade's,
     plus `session-mint.ts:186`, which stays until B′ routes the mint through the server): the
     cascade hazard headlined in earlier revisions **does not apply to any of them**, because
     none of the target tables (`meta`, `telegram_chat_bindings`, `user_layout`,
     `user_preferences`, `grants`, `client_sessions`, `accounts`, `user_read_position`,
     `steward_state`) is a foreign-key parent (rev 10.1, F5). The real per-site differences:
     REPLACE assigns a fresh rowid (harmless, none of these tables orders by rowid) and resets
     every column not named in the statement to its default, which an `onConflictDoUpdate`
     naming only some columns would not. The per-site check is therefore "does the statement
     name every column"; `grants.ts:199` and `auth.ts:70` name all of theirs;
   - `rowid`: **classify each use, then an additive ordinal column, never a primary-key
     change** (rev 9 Codex finding 11; rev 10.1 Fable layers F2). Every affected table already
     has a primary key, and an `INTEGER PRIMARY KEY` is only the rowid under another name, so
     the rev 9 surrogate-key rebuild of `sessions`, `issues` and `messages` would have rebuilt
     the parents of most of the schema's 41 `onDelete` edges inside the foreign-keys-off window
     (F6) for nothing. The mechanism is `ALTER TABLE t ADD COLUMN ord INTEGER`, a backfill
     `UPDATE t SET ord = rowid`, an index on `(…, ord)`, and the insert filling `ord` from
     `COALESCE((SELECT MAX(ord) FROM t), 0) + 1` inside the same write transaction, which is
     atomic because every write takes the write lane (`BEGIN IMMEDIATE` today, the scheduler's
     write lane in Stage B); on Postgres the twin declares `ord` as an identity column, gaps
     being fine for ordering. Classification (the reviewer did it, verified): contractual and
     getting `ord` are `queued_messages` (FIFO within one `queued_at`), `messages` ("latest
     send in one tick", ids are random), `automation_runs` ("latest spawned run"), `repos`
     (registry order that repo discovery documents it depends on); tie-breaks that become
     "timestamp then natural key" with a characterisation test are `sessions` (resume-value
     scan), `pins` (`pinned_at, kind, id`; `ord` only if the UI test objects), `issues` (merge
     keeps the oldest), `automations` lists; `maintenance_commands` uses rowid as a row address
     and becomes a composite-key `IN` subselect; `upstream_outbox` is archived and must not be
     migrated (`ORDER BY queued_at, mutation_id`); `conversations` has no bare-rowid query
     outside the FTS join; `lock_waiters` needs nothing. `transcript_fts` is used as row storage
     ordered by rowid, so the `SearchIndex` port carries an insertion-order read. Each `ord`
     migration lands before the query that uses it. The FTS tables are exempt from the lint;
   - `lastInsertRowid` → `RETURNING`;
   - keep FTS behind a small `SearchIndex` port with a SQLite implementation, whole raw
     statements allowed there only.
6a. **The five large repositories convert in family slices, not one commit each** (rev 10.1,
   F9). `shipping.ts` has 77 sites across seven families (orders, attempts, steps, holds,
   receipts, trains, effect envelopes) sharing select prefixes and mappers, and 19 spans that
   cross families (`commitTrainEffect` touches four). One commit per repository is the
   long-lived branch §3.6 forbids. Order: shared selects and mappers first (typed selects
   replacing the row casts, behaviour unchanged), then one family per commit, with each
   cross-family transaction converted in the commit of the last family it touches. Same for
   `issues.ts` and `sessions.ts`. `shipping.ts:585, 1491` read the `issues` table directly;
   route them through `IssuesRepository` or list them as accepted cross-aggregate reads so the
   writer scans in 5d stay per table.
7. Use the existing store tests as the oracle: they are 1,840 call sites of characterisation.
   Where a repository has thin coverage, add a golden test before converting it.
8. (Moved to 5a.)
9. Retire the one-time boot upgrades that are past their deletion horizon instead of porting
   them (machine identity `store.ts:595`, repo identity `store.ts:349-391`, the
   `PRAGMA table_info` probes). Each is an introspection site that has no dialect-neutral form.
10. Add `bun run migration:check`-style CI that the schema file and the query layer agree
    (drizzle typecheck does this for free once queries use the tables).

Outcome of Stage A alone: typed queries, one schema truth, call sites untouched, tests
untouched, boot untouched. Reversible per aggregate.

### Stage B — async repositories and explicit transactions

11. Change the port types first and let typecheck drive the rest. **The kernel is
    parameterised on a unit of work, not handed an opaque `tx`** (rev 9, Codex finding 4):
    today `Authority.commit` runs zero-argument `authorize`, `arbitrate.current` and `write`
    callbacks and appends through its root `ChangeStorePort` (`authority.ts:183-224, 444-451`),
    which is only atomic because one SQLite handle happens to be inside the open `BEGIN`. On a
    pooled backend the entity write and the change append would commit on different clients.
    So `TransactPort<Uow>` passes a `Uow`, `AuthorityCommit<Uow, T>` hands it to `authorize`,
    `current` and `write`, and the Authority resolves its change store from the same `Uow`. At
    composition the `Uow` is the tx-bound repository set: the feature write uses `uow.issues`,
    the append uses `uow.sync`. Every storage-backed Authority method becomes async, not only
    `commit`: baseline seed, `capture`, `reconcile`, `changesSince`, `cursor`, `bootstrap` and
    the retention reads. `StoreDatabaseOpener` becomes `Awaitable`; the fixture's synchronous
    clone opener is wrapped in `Promise.resolve` and its env channel is untouched (rev 9,
    finding 12). Keep the kernel free of drizzle types (the lint rule).
    The port is `UnitOfWorkPort<Uow> = { write, read }`, where `read` returns a consistent
    snapshot at one head (rev 10, F5). **Scoping is on the async boundary too** (rev 10, F2):
    `Authority.broadcast` calls `scope` per subscriber inside the ordered drain, and `scope`
    calls the synchronous `policy.decide` and `anchors.visibilityEdge`
    (`authority/scoping.ts:122-128, 210, 234`), whose server implementations read the store per
    row (`feed-visibility.ts:171, 218`) and, for `visibilityEdge`, load the whole sessions
    table. Step 14's "rights on the applying transaction" covers a command, where the principal
    is known; it does not cover phase 3, where the subjects are only known once the batch
    exists. So the kernel's `FeedVisibilityPolicy` gains `forBatch(refs)` beside the existing
    `forBootstrap` (`feed/visibility.ts:236, 311`): the adapter prefetches every issue, session
    and grant list the batch's subjects can reach in one batched read under the writer's lease,
    and `decide` and `mayRead` stay synchronous over that snapshot, exactly as
    `BootstrapVisibilityPrefetch` already does for bootstrap. The prefetch is also where
    `visibilityEdge`'s whole-table session read becomes a keyed read.
11a. **An await-preparation pass for tests and test helpers only** (rev 9 finding 12, corrected
    by rev 10.1 F3). In production code `await` needs an `async` function, which changes every
    caller's return type: that is the Stage B flip itself and happens in step 15, one module at
    a time, in commits that may not touch test assertions. In tests, `await` on a non-Promise
    is legal, but it still yields to the microtask queue, and the frame caches close on a
    microtask, so the six suites that assert one query per frame
    (`store-issues-frame-cache.test.ts`, the superagent and feed-serving principal-wiring
    suites, `modules/daemon-request.test.ts`) and the six store-constructing suites under fake
    timers change meaning the moment an `await` lands between two reads. Those convert with
    step 14's frame-cache replacement; every other test and helper gets its `await`s while the
    store is still synchronous, in commits that change no assertion. The type-shape edits this
    forces are the one exemption from §6.1's "not the same commit" rule.
12. **The queued resource is the connection, not the transaction** (rev 8, findings 2 and 8).
    There is one `bun:sqlite` handle. A read issued while another task's transaction body is
    parked on an `await` runs inside that transaction and sees its uncommitted writes; if the
    body then rolls back, the reader acted on rows that never existed. So:
    - **A scheduler port with three lanes, `read`, `write`, `exclusive`, each with a stated
      isolation** (rev 10, F5): `read` is a consistent snapshot at one head; `write` is
      serialised with all writes and sees its own writes; `exclusive` runs alone. The SQLite
      implementation maps all three onto one lane, a size-one queue that owns the connection: a
      top-level transaction holds it from `BEGIN IMMEDIATE` to `COMMIT`/`ROLLBACK`, and reads
      outside a transaction wait behind an open one. That reproduces today's semantics exactly,
      since today everything is serialised by the thread, and the hop costs about a quarter of
      a microsecond (measured: 0.73 µs for a sync point read, 0.98 µs through the queue). A
      Postgres implementation keeps only the write lane serialised and gives `read` a
      `REPEATABLE READ` snapshot on one checked-out client; it does not inherit total
      serialisation. The write lane on Postgres implies **exactly one server process per tenant
      database at a time, including during a rolling deploy**, or the feed-head allocator in
      step 16 needs a row lock; that constraint is recorded in §5 decision 2.
    - **Post-commit work is three mechanisms with separate failure contracts, run under an
      explicit "no transaction" context, not one `afterCommit` list** (rev 10 F7, corrected by
      rev 11 finding 3). Once `COMMIT` has succeeded there is no rollback, so a tail failure can
      leave the durable log ahead of the baseline, cache revisions stale, subscribers untold, or
      the caller holding an error for an operation that committed; and a root store call from a
      tail callback would either inherit the finished transaction context and reject on its
      dead token, or queue behind the lease its own caller holds and deadlock. So phase 3 runs
      under a distinct post-commit `AsyncLocalStorage` value that routes to the root, inside the
      scheduler's ordered operation, and consists of:
      (1) **internal commit application**: the baseline fold and mandatory cache invalidation,
      in a defined order, not skippable by any other hook; an invariant failure here marks the
      store unhealthy and forces a reseed or restart rather than returning an ordinary
      transaction error, which is today's contract (`authority.ts:457-489` folds before it
      broadcasts and isolates each subscriber);
      (2) **durable follow-up writes**: today `capture` and `reconcile` finalise with no span of
      their own (`authority.ts:226-255`) and only the `announce: false` convention
      (`core.ts:990, 1019`) keeps a feed event from publishing inside a span; and "mail" is
      not merely I/O: `IssueService.sendMail` is a durable repository write followed by a
      best-effort nudge (`issues/service/mail.ts:57-79`), and `LockService.steal` calls it
      inside the lock transaction (`lock/service.ts:500-539`). Each such nested write is
      decided individually: it stays in the original unit of work, or it becomes an idempotent
      reaction enqueued as a scheduler follow-up or a transactional outbox row. Durable mail is
      never silently reclassified as best-effort;
      (3) **external effects**: sockets, notifications, process callbacks; run independently,
      caught per effect, with stated retry or demotion.
      The spec states which of the three the outer promise waits for. Failure injection at
      every hook position: an ambient root-store call from a tail, an async visibility-prefetch
      rejection (it must demote or retry the subscriber, never corrupt the baseline or report
      a committed write as rolled back), a durable follow-up rejection, a subscriber that
      throws. This still turns "no I/O in a body" into a shape: the body has nowhere else to
      put it.
    - **Publication flush is driven by the scheduler, not a microtask** (rev 10, F4). The
      funnel and feed serving both coalesce a synchronous burst into one frame per connection
      by flushing on `queueMicrotask` (`funnel.ts:311`, `feed-serving.ts:652`). Under the
      queue a burst of N commits is N lease acquisitions, and each commit's flush microtasks
      run before the caller's next commit, so N frames per connection; the boot reconcile loops
      and the bind-storm per-session commits are exactly such bursts. The pipe flushes when the
      scheduler goes idle, bounded by a maximum batch or delay so sustained load cannot starve
      publication, and "frames per burst" joins the step 17 gate with the boot reconcile and a
      bind-storm fixture as the two measured bursts.
    - **Re-entrancy by `AsyncLocalStorage`**, not by handle identity: a `store.transact` call
      made from inside a body (the Ledger's `onAppended` subscribers, `funnel.run`, any
      service the body calls) must become a savepoint on the open transaction, not a queue
      wait on itself, which would park every writer in the process forever. The transaction
      context travels with the async task. Verified: Bun's `AsyncLocalStorage` survives
      `await`.
    - **A transaction watchdog**: a body holding the connection longer than a budget logs its
      stack. Today an await inside a transaction is impossible by construction; under Stage B
      it is the failure mode that wedges the server and makes `mint-session` fail after its
      busy timeout.
    - **No I/O other than the database inside a body.** A rule, plus the watchdog to catch
      violations.
    - **Publication stays on the far side of commit.** Revision 8 said `onAppended` fires inside
      the span; the code says the opposite and is right (rev 9, Codex finding 2):
      `Authority.commit` completes `transact` and only then runs `finalize`, the "post-span
      tail" that folds the baseline and broadcasts (`authority.ts:452-488`), and the Ledger's
      listeners are driven by `authority.subscribe` (`ledger.ts:211-234`), so nothing observes
      a row that could still roll back. The async design keeps three phases: the database
      transaction; commit; then the ordered baseline update and publication. The scheduler may
      keep its lease through phase 3 so a later commit cannot overtake publication, but the
      SQL transaction is closed first. Subscriber callbacks stay synchronous and a returned
      thenable is rejected, so a subscriber that wants to commit queues the next top-level
      mutation instead of nesting a savepoint whose durability would be fate-shared with the
      outer write.
    - **An active transaction token, not only the callback boundary** (rev 9, finding 6). A
      closure or a detached continuation can retain the tx set and the inherited async context
      past commit. So every tx executor carries a token checked on every operation; the token is
      invalidated before the outer callback's result is returned and before the connection is
      released; a stale context rejects rather than bypassing the queue (with ambient routing,
      Stage 0 step 2, root use inside a body is the normal path, not an error); parallel nested
      transaction branches are rejected rather than named by depth; an `exclusive` request from
      a task that holds a lease rejects rather than waiting on itself (rev 10, F10). Drain
      policy at shutdown (rev 10, F11): a JavaScript continuation cannot be cancelled, so after
      the grace period the parked holder is rolled back, its token invalidated so its next
      operation rejects, and the drain proceeds; the same action is what the watchdog escalates
      to if it ever does more than report.
    - **Every use of the handle goes through the scheduler, including the file-level
      subsystem** (rev 9, finding 7): schema identity, `wal_checkpoint`, backup (which itself
      checkpoints, `backup.ts:82-105`), the transfer fence, boot upgrades, migration and
      `close` are exclusive operations on the same resource, otherwise a snapshot can include
      a parked transaction or `query_only` can flip under a writer. The file-level behaviour
      is unchanged; the code is not untouched, which corrects §6.1.
    - **Lifecycle states `open → accepting → draining → closed`** and an async shutdown:
      `PersistStep` becomes awaitable (`shutdown.ts:33-48` runs them without awaiting today),
      intake and background producers stop, persistence steps are awaited in order, queued work
      drains or is cancelled, then close. Tests cover ordinary shutdown, listen failure,
      snapshot-before-update and the transfer fence with an intentionally parked transaction.
    - **The migration operation carries the `foreign_keys` OFF/ON bracket on its own
      connection** (rev 10.1, F6). `PRAGMA foreign_keys` is a no-op inside a transaction
      (verified on SQLite 3.53), and drizzle's migrator runs every pending migration inside one
      transaction, so the PRAGMA lines drizzle-kit emits into the 13 rebuild migrations are
      inert. The only thing protecting those rebuilds from cascade-deleting the children of the
      table being rebuilt is the store's own OFF before the migrator and ON after
      (`store.ts:199-216`), which the pre-migrated image also relies on. The scheduler's
      exclusive migration operation is "OFF, backup, migrate, repair, ON, on this connection,
      before the scheduler accepts", B′'s open-and-migrate port says the same, and a migrations
      test runs a rebuild with enforcement on and asserts the refusal.
    - **The transfer fence is in-process only.** `PRAGMA query_only` is per connection: it
      stops the server's handle and not `mint-session`'s own connection or the janitor's
      (rev 10.1, F10). That gap exists today; the scheduler does not close it; B′ closes the
      second writer by routing the mint through the server, and "a mint during a transfer"
      joins B′'s acceptance.
    - On Postgres the same queue keeps the Ledger's single-writer invariant (D10/D12.6) true
      without `SELECT … FOR UPDATE` while there is one server process per tenant.
    - ADR 2 D10 and D12.6 get an amendment naming the queue and the post-commit tail as the
      mechanism, after the feed-head allocator (step 16) is specified; ADR 6 D5.3 gets the
      drizzle amendment.
12a. **The feed's certified reads and admission are redesigned, not audited** (rev 9, Codex
    finding 3). `Authority.bootstrap` reads `latestChangeStates()` and then `cursor()` in one
    synchronous pass and documents that as its no-gap argument (`authority.ts:300-339`);
    `readChangesSince` pages to `max` relying on the synchronous single writer
    (`change-log.ts:274-319`); `FeedServing.serveWorld` reads the world, sends it and installs
    the peer at that head in one turn, "the one place a connection acquires a position"
    (`feed-serving.ts:377`). Once any of these awaits, a commit or prune can land between the
    rows and the head they certify, or after the world is read but before the peer is
    registered, and that peer gets neither the row nor the delta: ADR 2's worst failure.
    Design for Stage B (rev 10, F3): `bootstrap`, `changesSince`, the cursor and floor checks
    and every paged certified read run in one `read` unit of work and return the rows with the
    head and floor from that same snapshot, and **feed admission registers the peer
    (`publisher.connect`, `retainPrincipal`) inside that same unit of work, before it
    releases.** On SQLite the lane is the lease, so no commit and therefore no publication can
    land between the world read and the registration; the gap is closed by that one sentence,
    and the barrier test only has to prove that a commit issued during admission lands after
    registration. The authorisation revision is read inside the same unit of work. A
    `buffering → bootstrapped → live` admission state machine with buffered replay is
    implementable (`FeedPublisher.emitTo` already filters on `seq > fromSeq`) but is a second
    mechanism for a gap the first closes; it is recorded as the Postgres-lane alternative to
    "admission takes the write lane" and decided in B′ with the Postgres feed test, because on
    Postgres a snapshot read does not block writers.
13. `SessionStore` gets an async factory (`await SessionStore.open(path, …)`); the constructor
    becomes private so an un-opened store cannot be handed to a registry. Boot heals move into
    `open()` **in the constructor's current order**: the machine-identity upgrade before any
    reader (POD-318, `store.ts:283-292`), then FTS, the seed, the repos import, the
    repo-identity upgrade, the worktree-identity upgrade, the seq renumber, the dangling-ref
    heal. Update the 9 non-test constructions (including the daemon's recovery-worker fixture)
    and the test helpers; give tests one `openTestStore()` helper so the 475 `new SessionStore(`
    sites become one mechanical rewrite; module-scope constructions become top-level `await`.
    The pre-migrated image fixture keeps working: the opener seam stays synchronous and is
    called from inside `open()`, and the env channel from `globalSetup` to the forks stays,
    because it is still the only synchronous channel (rev 8, finding 12). Three shared helper
    modules carry most of the test fan-out (`gateway/feed-test-plumbing.ts:74`,
    `sessions/oracle-support.ts:177`, `messages/characterization-support.ts:195`) and convert
    first; `describe`-scope constructions use an async `describe` callback, which this vitest
    accepts; and because tests rarely `close()` a store, the watchdog and queue timers are
    `unref`'d or the forks hang (rev 10.1, F12).
14. Fix the §1.5 list by design, not by sprinkling `await`:
    - frame caches (issues, users, relay closed-set): their premise is "no write can land
      inside this frame", and the scheduler's `read` lease gives the same guarantee, so the
      fan-out passes (the publish flush, the bootstrap read) run inside one `read` unit of work
      and the caches become unit-of-work-scoped caches in `RepositoryRuntimeState`, valid for
      the lease's lifetime, the same mechanism the transaction-bound set uses (rev 10, F9).
      Dropping them is not an option: the profile that created the issue cache was 5,163
      `getIssue` calls costing 13 seconds of CPU in one frame (`store/issues.ts:33-50`), and
      threading a read context through the fan-out is the executor-parameter design again.
      Reads inside the lease do not hop the queue; the step 17 query-count gate is the proof;
    - `get rows()` and lazy hydration → explicit `await service.rows()` or hydrate at boot;
    - constructors that read → `static async create()`;
    - visibility and authz predicates: **a grant is evaluated live** (ADR 9 D2 rule 4, which
      `grants.ts:25, 114` calls "D16.1"; ADR 9 itself has no D16, rev 10 F6). Today "live" and
      "same synchronous frame" coincide; under async a view computed before an `await` and used
      after a revoke committed is the revoked grant that keeps working. One definition covers
      every path: **live means read under the lease that applies or publishes the decision.** A
      command reads rights under its write lease; phase 3 scoping reads them under the writer's
      lease at the committed head (the `forBatch` prefetch, step 11); bootstrap reads them under
      its read lease; the `worldFor` cache validates on `(cursor, authorizationRevision)` read
      under the same lease. All three are the committed state at one head, the strongest "live"
      one process can offer and what the synchronous frame gave. The predicates stay sync over
      those reads. ADR 9 D2 rule 4 gets that sentence as an amendment (rev 8 finding 6, rev 10
      F6);
    - `SessionRegistry` is `relay.ts`, and its constructor reads settings, sessions, users,
      four shipping lists, repos, closed issues and automations (`relay.ts:431-1210`);
      `memory/service.ts:67` writes in a constructor. These become `static async create()`
      and are their own Stage B sub-issue (rev 8, finding 7);
    - array-callback store calls → batch reads (`WHERE id IN (…)`) before the loop, which is
      also the N+1 fix.
14a. **Process-state transaction audit before the async port flip** (rev 11, finding 2).
    Inventory every mutable registry and every capture-and-restore path (issue rows, sessions,
    shipping leases and in-flight sets, service registries) and choose one explicit model per
    registry: acquire the write unit of work before reading or mutating it and make every
    reader take the read lease; or build an immutable draft from a committed snapshot, persist
    the draft, and install the new object only after commit (for issues, drafts plus a revision
    check are simpler than keeping rollback-by-assignment); or move the projection behind its
    own versioned mutex independent of the database scheduler. For sessions, separate the
    durable metadata snapshot from live terminal state and say which fields may change while
    persistence is awaiting. Deterministic barrier tests: two updates to the same issue and the
    same session, a rollback racing a successful update, and a pure in-memory read while a
    database write is parked.
15. Convert services top-down: relay, then modules. ~750 sync method bodies in
    `apps/server/src/modules` become async; tRPC procedures (28 sync today) become async. Do it
    one module at a time behind a green typecheck; do not leave a half-async module.
16. The sync repository's seq-range arithmetic (§1.4). `RETURNING` order is unspecified in
    SQLite and Postgres, and `applyLatestChangeStates(chunk, first)` needs a seq per row
    positionally (a chunk may hold an upsert and a remove for the same entity, so rows cannot
    be re-keyed by entity). Either one insert per row with `RETURNING seq` inside the
    transaction, or multi-row `RETURNING seq` sorted ascending and zipped to the chunk, which
    is valid only under a single writer, which the queue guarantees; measure both at 100 rows.
    `maxChangeSeq` reads `sqlite_sequence` (`sync-repository.ts:131`), which is transactional
    on SQLite: a rolled-back append rolls back the counter too, so the feed stays gap-free.
    **A Postgres sequence cannot stand in for it** (rev 9, Codex finding 1): `nextval` is
    non-transactional, a rolled-back insert burns its values, and the protocol treats
    `seq !== cursor + 1` as a gap (`ports.ts:43-52`, ADR 2 D12). The Postgres form is a
    transactional singleton head row per feed, allocated with
    `UPDATE feed_head SET seq = seq + n RETURNING seq` inside the same transaction, the range
    `head − n + 1 … head` assigned explicitly to the inserted rows, and the durable head read
    from that row. Never `serial`, `identity`, `nextval` or `last_value` for this table. Tests:
    a throw after allocation, a process restart, pruning, and two clients if failover can ever
    overlap. This is the step 3b spike.
17. Benchmarks before and after on the two paths that run thousands of queries per frame:
    feed bootstrap (`gateway/feed-serving.ts`) and issue frame reads
    (`store-issues-frame-cache.test.ts` shape). Assert the query count, not the duration.

Outcome of Stage B, stated narrowly (rev 9, Codex finding 9): **the Bun/SQLite server has
asynchronous, executor-bound repositories and every dialect-specific statement is isolated
behind a port.** Nothing else is a configuration change yet: the migrator refuses any handle
that is not the registered `bun:sqlite` client (`migrations/index.ts:228-258`), boot creates a
directory, sets file PRAGMAs, builds a file-backed snapshot verifier and creates FTS5 objects,
and the janitor, `mint-session` and the transfer path open the file themselves. Those are
Stage B′.

### Stage B′ — backend enablement (new in rev 9)

18a. Ports for what is still SQLite-file-shaped after B: open and migrate, search
    (`SearchIndex`), durability (backup, restore, snapshot verification, checkpoint), the
    transfer fence, and the operator and maintenance clients (janitor read-only access,
    `mint-session`'s write, the daemon's candidate-database validation).
18b. Per-backend acceptance: a backend is supported only when it can boot a fresh database,
    upgrade and reopen an existing one, run the full store and service suites, shut down cleanly
    and satisfy its backup and restore story. For Postgres, the two-tenant collision test and
    the gap-free feed test are mandatory acceptance, not a confidence sample.
18c. Turso remote, D1 and DO-SQLite are each a B′ item with their own environment and binding
    model, not a driver constructor swap.

### Stage C — Postgres (only if the cloud decision changes)

18. A second schema module against `pg-core` (88 tables). **No runtime-generic table DSL is
    mandated** (rev 11, finding 8): the schema is about 2,400 lines with branded and
    self-referential foreign keys, composite keys, partial expression indexes, JSON defaults,
    autoincrement keys and 64 checks including dialect-specific `GLOB`, and a generic DSL over
    both drizzle dialects becomes a lossy third schema API or leans on casts that erase the
    inference this work exists to gain. The step 3b slice prototypes the technique and picks
    between generated concrete drizzle schema files from a narrow data manifest, and explicit
    dialect schemas sharing brands and domain column descriptors, checked by a structural
    parity test. The query strategy chosen in 3b decides how repository bodies get their
    Postgres implementation; a schema twin alone does not.
19. A second drizzle journal (`out: migrations/pg`). This is exactly the two-ordering-authorities
    problem POD-305 refused; the rule has to be "every schema change is authored for both
    dialects in one commit" with a CI check that both heads name the same logical change.
    Postgres starts from a fresh baseline; the 87 SQLite migrations do not replay.
20. FTS: `tsvector` implementation of the `SearchIndex` port.
21. **Rollout from SQLite is a fenced, restartable migration state machine, not a copy tool**
    (rev 11, finding 6). Podium's own restore code spends its header on the lesson
    (`migrations/restore.ts:1-65`): restoring sequence history without moving the feed epoch in
    the same step produces silent permanent divergence, and the daemon's transfer proof
    validates integrity, target identity, feed id and epoch, and migration head before
    promotion (`server-transfer.ts:320-379`). The cutover: stop intake and every writer
    (including the operator clients, since the SQLite fence is connection-local); take a source
    snapshot; record source schema, feed identity and head; copy into a fresh target with a
    per-table checkpoint so a failure halfway through 88 tables is retryable; classify and
    quarantine invalid JSON rather than failing or silently loading it into `jsonb`; validate
    counts, key sets, constraints, the latest-state projection, the feed head and sampled
    payload hashes; mint a new feed epoch or prove exact continuity, atomically; switch
    configuration; define the point after which rollback needs a reverse migration rather than
    reopening the stale SQLite file. Crash-and-retry tests at every phase, and a pre-cutover
    client cursor exercised against the promoted backend.
22. **Single-writer on Postgres is enforced or replaced, never assumed** (rev 11, finding 5).
    Nothing in boot today can make "one server process per tenant database" true, and rolling
    replacement and crash recovery are exactly when overlap is normal. Either the server takes a
    database advisory or fencing lease before accepting traffic, a second server provably
    refuses or stands by, and takeover after lease loss is defined; or multiple writers are
    supported with row locks or guarded updates or `SERIALIZABLE`, bounded transaction retries
    and idempotent command outcomes. The feed-head `UPDATE … RETURNING` already takes a row
    lock and is tested with two clients unconditionally. Retry and idempotency rules for
    serialisation failures, deadlocks, connection loss during `COMMIT` and an ambiguous commit
    result are specified; none of these exist on the in-process SQLite path.
23. Backup, restore, snapshot verification, transfer fence, `wal_checkpoint`, Litestream:
    replace with `pg_dump`/managed backups behind a backend-specific `Durability` port.
24. Janitor and `mint-session` become clients (§1.6).
25. Semantics sweep: `LIKE` → `ILIKE` where case-insensitive matching was relied upon,
    `GLOB` checks, text collation and ordering, bigint columns arriving as strings, `RANDOM()`.

---

## 3. How we should do it — recommendation

1. **Stage A first, on the sync driver, without touching call sites.** It is mechanical,
   reversible per aggregate, and it is where most of the typed-query value is. It also
   surfaces every SQLite-ism (§1.7) as a visible decision instead of a hidden one.
2. **Build the bound repository set in Stage A even though the driver is sync.** Repositories
   are instantiated against an executor from the start, so `store.issues` and `tx.issues` exist
   in Stage A with synchronous bodies (`.all()`, `.get()`, `.run()`). Stage B then changes
   return types and the transact port, not query bodies and not call-site shapes. Stage B
   itself cannot be done per aggregate, because a transaction spans repositories (the Ledger
   spans an entity write and the change append), so the transact port flips for everyone at
   once. That is why A must be landable per aggregate and B must be short-lived. (Rev 8: the
   earlier "awaitable form in Stage A" was self-contradictory, finding 1.)
2a. **Do the §1.5 refactors before B, as ordinary work.** Hidden reads in constructors and
   getters, store calls inside array callbacks, and per-row authz reads are design debts
   independent of async, and their fixes (explicit `create()`, batched reads, a precomputed
   principal view) are what a remote backend needs anyway. The frame caches are the exception:
   they exploit a real JavaScript guarantee, and their replacement is an explicit request-scoped
   read context that makes the same idea visible.
3. **Stage B as its own project with its own issue tree**, started by changing the kernel port
   types and following the red. The §1.5 list is the real work; the `await` sprinkling is not.
   Do not start B until A has converted the large repositories, or the two will fight over the
   same 2,683-line files.
4. **Prove the Turso path with a spike before promising it**: run the acceptance lane against
   `drizzle-orm/libsql` with the web client against a local `sqld`, and measure the feed
   bootstrap. The number that matters is round trips per request; the codebase was written for
   sub-millisecond local queries and has N+1 shapes that a remote database will expose.
5. **Treat Postgres as a spike on three repositories (locks, accounts, sync) rather than a
   stage.** It will tell you the cost of the schema twin and the journal rule before the
   architecture decision that would justify it.
6. Land each stage on `main` in small, per-aggregate commits. A long-lived branch converting
   30 repositories will not survive the rate of change in `shipping.ts` and `issues.ts`.

---

## 4. What to be careful about

**Correctness**

- Async removes the implicit atomicity of a synchronous frame. Every read-then-write that is not
  already inside `transact` becomes a TOCTOU window. Audit the 574 service call sites for
  read→decide→write pairs and wrap them; the lock and messages services are the model.
- The `Ledger`'s thenable guard is an invariant, not a nuisance: its async replacement must make
  it impossible for code to run after the commit but believe it is inside the span. Passing `tx`
  explicitly and never capturing it outside the callback is the mechanism.
- `INSERT OR REPLACE` is delete+insert. Converting it to an upsert stops resetting columns not
  named in the statement; none of its 13 target tables has children, so cascades are not the
  issue. Read each site for unnamed columns.
- Frame caches (§1.5.1) become wrong, not just useless, under async. Remove or redesign them
  before converting the code that relies on them.
- Publication runs after commit today and must stay there; what has to be preserved is that
  publication order equals commit order (the ordered pipe in `authority.ts:493-524` exists for
  exactly this), which the after-commit hook and the scheduler-driven flush in step 12 provide.
- The seq-range arithmetic in `sync-repository.ts:71` is only correct with a single
  interleaving-free writer.

**Runtime and packaging**

- Bun builtins (`bun:sqlite`, `Bun.SQL`) and pure-JS clients survive `bun --compile` as they
  are. libsql and Turso local or embedded modes need a per-platform explicit `.node` require in
  the build (§1.8), and Turso's new engine ships fewer platforms than the release targets.
- Async SQLite runs on the event-loop thread with every driver Bun offers (§1.8). Stage B does
  not relieve loop blocking; only a worker thread or a server does.
- No driver serializes async transactions on one SQLite connection, and engine-level locking
  cannot do it inside one thread (§1.8). The size-one pool in step 12 is the mechanism, and it
  must wrap every top-level transaction, including the Ledger's.
- The pre-migrated test fixture (`serialize`/`deserialize`) is `bun:sqlite`-only. Switching the
  test driver to `Bun.SQL` or libsql costs the 469 ms → 65 ms store construction win across
  475 constructions.
- Second-process access (janitor read-only handle, CLI writer) keeps working on SQLite files
  and stops working on anything remote.

**Drizzle specifics**

- `1.0.0-rc.4` is a release candidate, pinned exactly. The relational query API changed
  between rc versions; expect one upgrade with churn before 1.0.
- Drizzle cannot express branded id types (`branded-ref.ts:22-25`), so `RepoId`/`SessionId`
  re-entry stays at the mapper edge as it does today. Do not fight it.
- Typecheck cost: 88 tables of drizzle generics on top of a repo whose typecheck already OOMs
  when run unscoped. Measure `apps/server` typecheck time after converting the first large
  repository, and keep queries in the repository files, never in services.
- Drizzle's SQLite dialect and Postgres dialect are different type universes. There is no
  clean way to write one query body that typechecks against both `SQLiteTable` and `PgTable`.
  A "dual-dialect repository" means either duplicated query code or a thin per-dialect layer
  under a shared domain mapper. Decide this before Stage C, not during it.
- The `bun-sql` and `bun-sqlite` migrators must agree on the `__drizzle_migrations` row format;
  the downgrade guard and daemon convergence gate read it.

**Process**

- The sync-kernel purity lint will reject drizzle imports outside `packages/sync/src/adapters`;
  keep the async port types plain.
- The store tests are the oracle. Do not convert a repository whose tests you cannot run
  green first, and do not rewrite tests and implementation in the same commit.
- Turso as a hosted **sync backbone** was rejected on record
  (`docs/offline-sync-architecture.md:24`). Turso as a plain remote SQLite for the server store
  is a different question and was never evaluated; do not cite that rejection either way.
- The cloud proposal on record is instance-per-tenant SQLite streamed to R2, no shared
  database. Postgres is a reversal of that proposal and should be argued there first.

---

## 5. Decisions taken (2026-09-02)

1. **Postgres on the server is a real direction.** Stages A and B are the preparation for it
   and are both in scope. Stage C remains out of scope until the cloud architecture decision is
   revisited. A and B are done so that C reuses the executor model, the ports and the domain
   mappers; C will still have to implement the Postgres query bodies under whichever
   dialect-query strategy the vertical slice (step 3b) selects, because drizzle's SQLite and
   Postgres table types are different type universes (§4). "No rework of the store" is not
   claimed (rev 11, finding 1).
2. **The size-one transaction queue in front of `bun:sqlite` is the mechanism** for async
   transactions on SQLite (§1.8, §1.9). No driver switch: `bun:sqlite` stays. On Postgres the
   write lane of the scheduler port (step 12) implies exactly one server process per tenant
   database at a time, including during a rolling deploy; otherwise the feed-head allocator
   needs a row lock (rev 10, F5).
3. **Two requirements govern every step.** Podium as it exists keeps running exactly as it does
   today on SQLite, and the server is ready for Postgres at the end. Section 6 turns both into
   checkable criteria.
4. Still open, not blocking: self-hosted Turso as remote-only (pure JS) or embedded replica
   (native addon beside the binary). Nothing in A or B depends on the answer.

## 6. Definition of done

### 6.1 "Keeps running stably as it is today"

Every landed step must satisfy all of these, and they are the review checklist for each
aggregate conversion:

- **No behaviour change on SQLite.** The existing store and service tests are the oracle and
  are not rewritten in the same commit as the implementation they cover. Where an
  `INSERT OR REPLACE` site named only some columns, the reset of the others stays explicit.
  **For Stage B the oracle is a captured trace, not a mechanically awaited copy of the tests**
  (rev 11, finding 7): a rewritten suite can encode the new timing by accident, exactly as
  finding 4 shows. Before the flip, a backend-neutral conformance suite records, from the
  synchronous Stage A implementation, the externally observable sequence per scenario: results
  and errors, database rows, in-memory projections, bus events, feed frames, timer scheduling
  and relative completion order. The async implementation replays the same scenarios and is
  compared against the trace, plus the same-entity concurrency scenarios of step 14a. The
  synchronous implementation stays available behind a test adapter until parity holds.
- **Landed per aggregate, on `main`, each commit revertible on its own.** No long-lived branch.
  A conversion that cannot land alone is split until it can.
- **The queue is proven, not assumed.** A test drives concurrent top-level transactions with
  awaits inside their bodies and asserts no lost update, no interleaved `BEGIN`, and that a
  throw rolls back only its own transaction. It also covers: a reader issued while another
  body is open sees only committed rows; a body that calls `store.transact` re-entrantly gets
  a savepoint and does not deadlock; an `onAppended` subscriber that commits from inside a
  notification; and the watchdog fires for a body parked past its budget, reported through an
  injectable sink. This test exists before the first async repository lands (rev 8, findings
  2 and 8). Rev 10 (F10) adds the properties the design is chosen for: commit order equals
  publication order equals seq order under concurrent top-level transactions; **a
  subscriber-initiated durable commit is complete before the outer caller's `await`
  resolves**, while batch N still reaches every subscriber before batch N+1: today the
  re-entrant commit is durable before its call returns and only its delivery is queued
  (`authority.ts:499-527`), so a caller that reads a derived row right after its commit sees
  it, and revision 10's "lands after the outer await, find and characterise the callers" was a
  knowing semantic change under a "no behaviour change" definition of done (rev 11, finding
  4). The mechanism is an ordered follow-up slot that the outer operation awaits before
  resolving, and the durable re-entrant subscribers are enumerated with caller-visible
  before-and-after tests; a stale token rejects; two nested `transact`
  calls started in parallel from one body reject; a write then a read in one body sees the
  write for every cached aggregate; an `exclusive` request from a lease holder rejects; frames
  per burst equal one for the boot reconcile and a bind-storm fixture. All cases run on one
  deterministic interleaving harness (barriers the bodies await) shared with step 12a.
- **Nothing runs after its commit.** The Ledger's thenable guard is replaced by a test that
  fails if a transaction body can touch the connection after `COMMIT`; the `tx` handle is the
  only executor inside a body.
- **Hot paths do not regress.** Feed bootstrap and issue frame reads are measured before Stage
  B starts and after it lands; the gate is query count per request, and the budget is "no
  increase". The frame caches are removed only when their replacement holds that number.
- **The file-level subsystem behaves as it does today.** Backup, restore, snapshot verification,
  transfer fence and WAL checkpoint keep their semantics on `bun:sqlite`; in Stage B their
  handle use goes through the scheduler as exclusive operations (step 12), so the code is
  touched but the behaviour is not. The janitor's read-only handle and the CLI's `mint-session`
  writer keep working.
- **Shutdown is ordered and awaited.** Intake stops, producers stop, persistence steps are
  awaited in order, queued work drains, then close; tested with a parked transaction.
- **The pre-migrated test fixture keeps its speed.** Store construction in tests stays on the
  page-image path.
- **Boot order is preserved.** The async `open()` runs migrations, repository construction and
  the boot heals in the same order the constructor does today, and nothing reads the store
  before `open()` resolves.

### 6.2 "Ready for Postgres on the server"

Checkable at the end of Stage B, and the acceptance for this issue's tree:

- Every repository method returns a Promise, and every repository instance is bound to an
  executor (`store.x` to the root, `tx.x` to a transaction). No repository closes over a
  connection. `SessionStore.transact` is the only way to open a transaction and it runs
  through the connection queue.
- No SQLite-only construct remains in a repository query body: no bare `rowid`,
  `INSERT OR REPLACE`, `PRAGMA`, `sqlite_master`, `lastInsertRowid`, `GLOB`, hand-built `?`
  placeholder lists, or `? 1 : 0` boolean encodings. A boundaries-style lint over
  `apps/server/src/store/**` and the sync adapter enforces the list so it cannot regress.
- Full-text search sits behind a `SearchIndex` port with the SQLite FTS5 implementation as its
  only member; the `sql\`\`` escape hatch is allowed there and nowhere else.
- Schema columns declare their modes (`boolean`, `json`, timestamps) so a `pg-core` twin can be
  generated from the same declarations; `brandedRef` is written so a Postgres variant is a
  second export, not a rewrite.
- The one-time boot upgrades and `PRAGMA table_info` probes are retired, not ported.
- Sequence numbers in the sync repository come from `RETURNING`, never from rowid arithmetic.
- **The proof for this issue is the dual-backend vertical slice of step 3b** (rev 11, finding
  1): locks, one aggregate with joins and JSON, the sync append with feed-head allocation, boot
  and shutdown, running on real SQLite and real Postgres through the same executor interface,
  with the dialect-query strategy and the schema-twin technique chosen from that measured code.
  That is what "prepared for Postgres" means here. "Postgres-ready" in the B′ sense (a backend
  that boots a fresh database, upgrades and reopens one, runs the full store and service suites,
  shuts down cleanly, passes the tenant-isolation test for the chosen topology, the gap-free feed
  test with two independent pools, and a fenced cutover from SQLite) is the acceptance of the
  later Postgres epic, and it runs unconditionally there, not on the assumption that deploys
  never overlap.

## 7. Working rules for the conversion

Rules for whoever converts a repository. Each one is either a generic ORM-adoption rule made
specific to this codebase, or a trap found by checking such a rule against the code.

1. **Drizzle is the default, not a religion.** Ordinary select, insert, update, delete and
   expression composition use the query builder. `sql\`\`` fragments inside a builder query
   (a `coalesce`, a computed order key) are fine anywhere. Whole raw statements and anything
   dialect-specific live behind a named port (`SearchIndex` for FTS) and nowhere else. The
   Stage B lint forbids the §1.7 construct list, not the `sql` tag itself, and it scans
   `sql\`…\`` template bodies, because that is where a `rowid` or `PRAGMA` hides after
   conversion. Behind the port, parameters stay bound: `sql.raw` of a user string is the
   injection hazard the port would otherwise invite (rev 10.1, F11, F13).
2. **Drizzle stays inside persistence.** `drizzle-orm` is imported today only from
   `migrations/` (`index.ts`, `schema.ts`, `branded-ref.ts`). After conversion it may also be
   imported from `store/**`, `modules/operations/store.ts` and the sync SQLite adapter, and
   from nowhere else in `apps/server`; add that to `check-boundaries` beside the existing
   sync-kernel rule. Repositories keep returning the domain row types in `store/types.ts`;
   drizzle's inferred types are an implementation detail of the mapper.
3. **The schema is the type source of truth, and brands survive.** `$type<…>()` is already on
   134 columns, so select and insert inference carries `RepoId`, `SessionId` and the rest; the
   limit recorded in `branded-ref.ts` is about `references()` only. That is what lets the
   `Record<string, unknown>` reads, the 49-column hand-typed selects and the "SERIALIZATION
   EDGE" casts go. Duplicated row interfaces go with them; the domain type stays.
4. **`mode: 'json'` is not a drop-in for the quarantine.** Drizzle's JSON column does a bare
   `JSON.parse` and throws on a corrupt value. `helpers.ts` exists because one corrupt blob
   must not abort a whole table load or crash-loop boot, and eleven read sites depend on that.
   Columns with quarantine semantics keep `text` plus `parseJsonColumn`, or get a `customType`
   that quarantines; the 23 columns already declared `mode: 'json'` are only safe where a
   throw is the intended behaviour, and shipping's are all read leniently today. Decide per
   column, in a schema-only commit before the aggregate's conversion (step 6).
5. **Trust the database's types; enforce invariants in the database.** Do not re-validate every
   row with a schema parser. Where a value is genuinely constrained (roles, state enums), the
   CHECK constraint is the enforcement and `$type` is the annotation; 64 CHECKs already exist,
   add one when a `$type` has no constraint behind it. Keep validating actual external
   boundaries and JSON blobs.
6. **Mapping with semantics stays.** A mapper line that only existed because the driver
   returned `unknown` can go. A mapper line that is a decision (`requireUserId` failing closed,
   the `LockSessionKey` union that refuses to brand the operator sentinel, the legacy
   machine-id refusal) stays, and its comment stays with it. Deleting one needs a reason in
   the commit.
7. **Transaction semantics are preserved exactly, including the mode.** Drizzle's bun:sqlite
   transaction defaults to `deferred`; the store runs `BEGIN IMMEDIATE` today, and the §1.8
   probes show what deferred does under contention. The transact port issues `IMMEDIATE`
   explicitly. Boundaries, ordering, `INSERT OR REPLACE` cascades and `ON CONFLICT` targets are
   reviewed per statement, not assumed equivalent.
8. **Observability moves with the queries.** The `PODIUM_LOOP_PROFILE` attribution keys on SQL
   text and captures caller stacks at `prepare`; a drizzle `logger` sees the generated SQL and
   parameters synchronously in the same call path, so stacks can be captured there. Generated
   SQL text differs from the hand-written text, so historical top-query comparisons reset once.
9. **Builder only in Stage A; the relational API is a later, measured change.** Select,
   insert, update, delete, expressions, prepared statements and `sql`. Aggregate assembly
   keeps its current multi-query shape (issues read `issue_*` tables 29 times, shipping reads
   its child tables 36 times), batched with `IN` lists where a loop is an obvious N+1. The
   relational query API (v2, `defineRelations`) is the right form for those aggregates on a
   networked backend and is decided separately, after drizzle 1.0 and a remote benchmark, with
   §8.1's evidence and hazards. No generic base repository.
10. **Incremental, and no schema redesign in the same change.** One repository per commit with
    the existing tests as the oracle. The schema changes this plan does call for (mode
    declarations, an additive `ord` column where a table's `rowid` order is contractual, never a
    primary-key change on a parent table) are additive,
    each is its own migration, and none lands in the same commit as a query conversion.
11. **No synchronous-local-SQLite assumption in any contract.** Repository and port signatures
    are async and repositories are bound to an executor even while the driver underneath is
    synchronous, so Turso
    or Postgres is a driver substitution and not an architecture change. This is Stage B's
    whole reason, and it is the rule the frame caches, getters and constructor reads in §1.5
    violate today.

## 8. Alternatives considered for the query layer

| Option | For | Against | Verdict |
|---|---|---|---|
| Raw SQL over the `SqlDatabase` seam, made async with an executor | No new dependency; total control; the seam exists | No types from the schema; hand-written mappers stay; every dialect difference (`?` vs `$1`, upserts, returning) is hand-managed per site; nothing helps a Postgres twin | Rejected: it is the status quo with `await` added |
| Drizzle query builder (chosen) | Schema-as-code already exists and is the migration source; `$type` brands flow through inference; light runtime; the migrator is already drizzle | Release candidate; table objects are dialect-bound, so Postgres needs a schema twin; no pool or queue for SQLite (§1.9) | Chosen: it completes an adoption already half made |
| Drizzle relational API v2 on top | One statement per aggregate, dialect-generated JSON aggregation; removes the grouping code | Most-changed API across the release candidates; aggregations not supported in `extras` | Used where a repository assembles an aggregate (rule 9) |
| Kysely, with drizzle-kit kept for schema and migrations | Genuinely dialect-agnostic: one typed query, the dialect is a runtime plugin, so SQLite and Postgres run the same repository code; Bun dialects exist for `bun:sqlite` and `Bun.SQL` | Types come from an interface or codegen, not from `schema.ts`, so two type sources of truth; `drizzle-orm/kysely` does not exist at rc.4 to bridge them; a second library beside the one already adopted; community dialects for Bun | Not chosen now; the one option to revisit if Stage C's schema-twin cost proves too high, because it removes the twin at the query level |
| Prisma | Multi-dialect, generated client, its own migrations | Its own migration system beside drizzle-kit's; generated-client and engine packaging under `bun --compile`; heavy | Rejected |
| Decorator ORMs (TypeORM, MikroORM, Sequelize) | Unit-of-work, entity graphs | Runtime entity metadata, decorators, and a data model the kernel already owns differently | Rejected |

### 8.1 Builder versus relational API: the decision and its evidence

This is a conscious choice, so here is what it rests on (all measured 2026-09-02 against
`drizzle-orm@1.0.0-rc.4` and `bun:sqlite` with SQLite 3.53).

**What the relational API is.** A read API: `findMany` and `findFirst` with `with`, `where`,
`columns`, `orderBy`, `limit`, `offset` and `extras`. Every insert, update and delete is the
builder regardless. So the choice is only about reads, and the store's statement mix is
roughly 140 selects to 106 writes among the single-line sites, 284 `SELECT` lines in total.

**What it generates.** One statement per query. On SQLite each relation becomes a correlated
subquery `coalesce((select json_group_array(json_object(...)) from (...) t), json_array())`;
on Postgres each becomes `left join lateral (select coalesce(json_agg(row_to_json(t.*)), '[]')
...)`. The nesting is therefore generated per dialect from one definition, which is the
portability argument for it.

**What it cannot express.** Of the 284 select lines, about 65 use constructs outside its
reach: 11 `JOIN` for filtering rather than nesting, 4 `GROUP BY`, 38 aggregate calls
(`COUNT`, `MAX`, `MIN`, `SUM`), 9 `EXISTS`, 1 `UNION`, 2 FTS `MATCH`, 3 `CASE WHEN`. Its
`extras` clause does not support aggregations. Those stay on the builder or behind a port.

**Performance on local SQLite** (5,000 issues, 3 labels and 4 comments each, one repo of 7,
715 issues returned, mean of 5 runs):

| Shape | Time |
|---|---|
| Three flat selects with joins, grouped in JavaScript | 20.1 ms |
| Relational-API shape: JSON-aggregating subqueries plus `JSON.parse` | 13.6 ms |
| N+1: one prepared child select per issue | 8.4 ms |

Two lessons. The relational shape is not slower than today's grouping code on SQLite, so
adopting it for aggregates costs nothing locally. And N+1 is the fastest shape on a local
in-process database, because a prepared statement costs microseconds; the N+1 problem only
exists over a network, which is exactly the Turso and Postgres case. Query count per request
is the right gate (§6.1) because it is the number that changes meaning between backends.

**Hazards specific to the relational API.**

- **Undefined filter values.** In rc.4 a `where: { userId: maybeUndefined }` silently drops the
  field and returns every row (drizzle-orm #5636, filed as a security issue and still open);
  the rc.5 snapshots throw at runtime instead while the types still accept `undefined`
  (#6180). Podium scopes most reads by principal. The rule is that no possibly-undefined value
  ever reaches a `where` object; a typed lint rule as described in #6180 enforces it.
- **No prepared statements.** The relational query object has `findMany`, `findFirst` and
  `toSQL` only; the builder's `.prepare()` has no equivalent, so SQL is regenerated per call.
  Irrelevant for aggregate loads, relevant on a per-row hot path.
- **Version churn.** v1 relations removed from SQLite in rc.4; v2 switched to array mode in
  rc.3 and rc.4; the undefined semantics changed again for rc.5. Pin the version and budget one
  adjustment before 1.0.
- **Relations are a second definition beside the tables**, so a Postgres twin needs a twin
  relations file too, or generation from one source (Stage C step 18 already assumes that).
- It runs inside transactions (`tx.query.*` exists on the transaction object), so nothing in
  the executor model changes for it.

**Decision (revised in rev 9, Codex finding 13).** The relational API is the right tool for
aggregate-root reads (issues with labels, deps, comments and mail; sessions with pins, snoozes
and drafts; shipping orders with attempts, steps, holds and receipts; superagent threads with
messages) **but not in Stage A.** Stage A's job is to replace raw SQL with the builder while
keeping behaviour identical, and folding an aggregate-loading rewrite into the same commits
makes characterisation failures harder to localise, adds a second relations definition to any
future dialect twin, and takes on an API that changed in three consecutive release candidates
and still has the undefined-filter hazard. Its benefit is round trips on a networked backend,
which is not a Stage A requirement, and the benchmark above shows no local cost to keeping the
current grouping shape. So: Stage A keeps the explicit multi-query aggregate assembly on the
builder, batching obvious N+1 reads with `IN` lists. The relational API is revisited as its own
measured change after drizzle 1.0 ships and a remote-backend benchmark shows the round trips
are material, with the undefined-filter lint in place before its first use. The rest of this
section stands as the evidence for that later decision.

## 9. Staff review of revision 7 (2026-09-02) and what it changed

An independent reviewer with no prior context read revision 7 against the code; the author
verified every load-bearing claim separately. Verdict on revision 7: **replan, scoped** to
three design decisions. The investigation (§1, §1.8, §1.9, §8) stood. Revision 8 is the result.

| # | Finding | Severity | Change made |
|---|---|---|---|
| 1 | Stage A "awaitable form with call sites untouched" was self-contradictory: an awaiting body is an async method, which in Stage A trips the frame caches, the transaction helper's thenable guard and the Authority's async-write refusal | critical | Stage A uses sync forms only (§3.2, step 6) |
| 2 | "Reads stay unqueued" on one shared connection: a read during another task's open transaction sees uncommitted writes; a body awaiting a re-entrant `store.transact` waits on the queue for itself and parks every writer | critical | Queue owns the connection; `AsyncLocalStorage` re-entrancy → savepoint; watchdog; no non-DB I/O in a body (step 12) |
| 3 | Drizzle runs on the raw handle and bypasses the `SqlDatabase` wrapper in Stage A already: repos registry cache invalidation goes stale, query attribution goes dark, drizzle's own `deferred` transaction can be reached | high | Steps 5a–5d before the first conversion |
| 4 | "rowid → explicit PK": every affected table already has a PK, three composite | high | Insertion-ordinal column with hand-written backfill, per table (step 6); FTS tables exempt |
| 5 | `RETURNING` cannot replace the seq arithmetic as written: order unspecified, positional use downstream; `sqlite_sequence` read was unlisted | high | Step 16 rewritten |
| 6 | "Precompute the principal's view per request" contradicts ADR 9 D2 rule 4 / D16.1 (grants evaluated live) | high | Rights read on `tx` inside the applying transaction; feed snapshot validated by `visibilityRevision`; ADR 9 amendment (step 14) |
| 7 | `SessionRegistry` is `relay.ts`; its constructor reads eight aggregates; the POD-318 boot order must be reproduced | medium | Private constructor + `open()` in the current order (step 13); relay reads as their own sub-issue (step 14) |
| 8 | Ordered pipe and funnel assume appends arrive synchronously; a subscriber committing from inside a notification is the re-entrancy deadlock | medium | `onAppended` inside the span before release; ADR 2 amendment; test case (step 12, §6.1) |
| 9 | Executor parameter on ~620 methods is not the simplest design | medium | Bound repository set (`store.x` / `tx.x`), Stage 0 step 2 |
| 10 | Postgres spike: the sync repository is not self-contained | medium | `queued_messages`, `upstream_outbox`, sequence port added to the spike (§6.2) |
| 11 | 14 `INSERT OR REPLACE` sites, not 15; `grants.ts` depends on REPLACE re-stamping every column | low | Step 6 |
| 12 | The fixture's env channel does not go away: it is still the only synchronous path from `globalSetup` to the forks | low | Step 13 |

## 10. Second review (Codex gpt-5.6-sol, 2026-09-02) and revision 9

A second independent reviewer, on a different model with the falsification prompt, read
revision 8. Its full text is the issue artifact "Codex sol review of the drizzle plan". Verdict on
revision 8: **replan before decomposition.** The author verified each finding in the code; all
thirteen held. Revision 9 is the result, and it changes the plan's shape: a unit of work through
the kernel, shared repository state, publication after commit, a feed admission state machine,
a lifecycle-owning scheduler, a new backend-enablement stage, and the relational API out of
Stage A.

| # | Finding | Severity | Change made |
|---|---|---|---|
| 1 | A Postgres sequence is non-transactional; a rolled-back append burns values and the protocol reads `seq ≠ cursor + 1` as a gap | critical | Transactional `feed_head` row allocator; spike in step 3b; step 16 |
| 2 | Rev 8 moved publication inside the span; the code publishes in a post-commit tail (`authority.ts:452-488`) precisely so nothing observes a row that can roll back | critical | Three phases kept; subscribers stay sync; step 12 |
| 3 | `bootstrap`, `changesSince` and `serveWorld` are multi-call certified reads in one synchronous turn; an await between rows and head, or between world and registration, is ADR 2's invisible gap | critical | Snapshot unit of work for certified reads; `buffering → bootstrapped → live` admission; step 12a |
| 4 | The Authority appends through its root store and its callbacks take no executor; atomic today only because one handle is inside `BEGIN`; torn on a pool | critical | `TransactPort<Uow>` through the kernel; all storage-backed Authority methods async; step 11 |
| 5 | Repositories hold process state (grant revision and audiences, sync generation, caches); per-tx instances split it, giving stale authorisation after revoke | critical | Shared `RepositoryRuntimeState`; post-commit invalidation; callbacks bound within the set; Stage 0 step 2 |
| 6 | A closure or detached continuation retains the tx set and inherited async context past commit; nothing enforced "nothing runs after commit" | high | Active tx token checked per operation, invalidated before return; stale context rejects; step 12 |
| 7 | The queue did not own checkpoint, backup, fence, migration or close; shutdown does not await persistence | high | Exclusive operations through the scheduler; `open → accepting → draining → closed`; awaited `PersistStep`; step 12, §6.1 |
| 8 | "Shared multi-tenant database" claimed with a single-tenant schema and no topology | critical | Topology decision before any Postgres design; claim removed; Stage 0 step 3a |
| 9 | Stage B did not make any backend a configuration change; the three-repository spike cannot prove readiness before the pg schema exists | high | Stage B outcome narrowed; Stage B′ added; spike moved early; §6.2 |
| 10 | Drizzle's logger has no completion, rows, duration or errors | high | Attribution at the execution seam around the raw client; step 5a |
| 11 | "Ordinal column the writer fills" is not a mechanism in SQLite; rule 10 still said "explicit primary key" | high | Classify each rowid use; surrogate key or allocator where order is contractual; step 6, rule 10 |
| 12 | Opener "async" in step 11 and "stays synchronous" in step 13; the no-same-commit rule is impossible at the Stage B flip | medium | `Awaitable` opener; await-preparation pass; scoped exemption; steps 11, 11a |
| 13 | The relational API is an avoidable second migration inside Stage A | medium | Out of Stage A; decided later on a remote benchmark; §8.1, rule 9 |

## 11. Third review, Stage B design (Fable 5.1 high, 2026-09-02) and revision 10

A reviewer focused only on the Stage B design. Verdict on revision 9.1: **approve with
changes**: the size-one scheduler and the three-phase commit model are sound and nothing argues
for a different mechanism; the layer above them needed four decisions. All twelve findings were
verified in the code by the author. Its measurements: a sync point read costs 0.73 µs, the same
read through the queue 0.98 µs, so the hop is not the cost on the hot paths; losing the frame
cache and burst coalescing would be. Full text: issue artifact "Fable review: Stage B async
design".

| # | Finding | Severity | Change made |
|---|---|---|---|
| F1 | "Call sites keep their shape" and "root use inside a body fails loudly" contradict for every service reached from a write span (58 span sites, services hold the root store) | high | Ambient routing through the transaction context; token kept for stale contexts; Stage 0 step 2 |
| F2 | Phase 3 scoping calls the kernel's synchronous visibility port per row, and the server's implementation reads the store; step 11 did not list it | high | `forBatch` prefetch beside `forBootstrap`; predicates stay sync; step 11 |
| F3 | Snapshot reads plus an admission state machine were both mandated; on SQLite registering the peer inside the read unit of work closes the gap alone | high | Register inside the read unit of work; state machine recorded as the Postgres-lane alternative; step 12a |
| F4 | Microtask-driven flush regresses burst coalescing to one frame per commit | high | Scheduler-idle flush; frames per burst in the step 17 gate; step 12 |
| F5 | The scheduler was a SQLite mechanism, not a port; Postgres would inherit total serialisation | medium | `read`/`write`/`exclusive` lanes with stated isolation; deployment constraint in §5; step 12 |
| F6 | Two definitions of "live grant" and a third for the feed; ADR 9 has no D16.1 | medium | One definition: read under the lease that applies or publishes; ADR reference fixed; step 14 |
| F7 | Publication after commit is a call-site convention today (`announce: false`); `capture` and `reconcile` finalise with no span; `sendMail` runs inside a lock span | medium | `afterCommit(fn)` hook as the one mechanism for phase 3, side effects and invalidation; step 12 |
| F8 | Invalidate-at-commit breaks read-your-writes inside a span | medium | Tx set reads through or keeps a local cache; Stage 0 step 2 |
| F9 | The frame-cache replacement was undesigned and dropping it costs 13 s of CPU per fan-out | medium | Unit-of-work-scoped caches under the `read` lease; step 14 |
| F10 | The queue test did not assert the properties the design is chosen for | medium | Seven cases added, one interleaving harness; §6.1 |
| F11 | Drain policy for a parked body unstated | low | Roll back the holder, invalidate its token, proceed; step 12 |
| F12 | §1.4 and §4 still said `onAppended` fires inside the span | low | Fixed |

## 12. Fourth review, untouched layers and Stage A (Fable 5.1 high, 2026-09-02) and revision 10.1

A reviewer focused on what nobody had read: shipping, the outbox path, the other processes on
the database file, the test plumbing, and Stage A in detail. Verdict on revision 9.1:
**approve with changes**, none of which reopens the architecture. Thirteen findings, all
verified by the author; two of them corrected facts every earlier revision had wrong. Full
text: issue artifact "Fable review: untouched layers and Stage A".

| # | Finding | Severity | Change made |
|---|---|---|---|
| F1 | Services hold narrowed dependency lambdas, not the store, so a `uow` parameter would rewrite 45 deps interfaces and their fake-deps tests; confirms the Stage B review's F1 | high | Ambient routing (already in rev 10); `store.outsideTransaction`; cross-service span in the 3b prototype |
| F2 | The rev 9 rowid fix rebuilt `sessions`, `issues` and `messages`, parents of most cascade edges, to obtain a column `ADD COLUMN` provides | high | Additive `ord` filled under the write lane; full classification adopted; step 6, rule 10 |
| F3 | The await-preparation pass is the Stage B flip in production code, and in tests an `await` yields to the microtask that closes the frame caches | high | Tests and helpers only; frame-cache and fake-timer suites convert with step 14; step 11a |
| F4 | 23 json-mode columns, not five; shipping reads its own leniently and `claimTrain` would throw on one corrupt blob | high | Per-column schema commit before conversion; shipping keeps quarantine; corrupt-blob test per aggregate; step 6, rule 4 |
| F5 | The OR REPLACE cascade hazard applies to none of the 13 target tables; the real difference is unnamed-column reset | medium | Guidance rewritten; step 6, §1.7, §4 |
| F6 | `PRAGMA foreign_keys` is a no-op inside a transaction and drizzle migrates inside one, so only the store's own bracket protects the 13 rebuilds; the plan never named it | medium | Bracket travels with the migration operation on its connection; test; step 12, B′ |
| F7 | Drizzle uses bun's cached `query()`, not `prepare()`; the wrapper must forward the full surface and register as an alias; the statement cache is a behaviour and memory change | medium | Step 5a, step 17 |
| F8 | Post-commit in-memory mirrors and unguarded interval callbacks were a missing §1.5 category | medium | §1.5 item 8; single-flight and mirror-before-await rules |
| F9 | Shipping cannot convert as one commit | medium | Family slices; step 6a |
| F10 | The transfer fence is per connection and the plan implied the scheduler closes the gap | medium | Stated as in-process only until B′; step 12 |
| F11 | Boundary lint is feasible in the existing shape; it must scan `sql` template bodies; the writer guard needs the `sql\`UPDATE issues` pattern | low | Rule 1, step 5d |
| F12 | Step 13 is executable; three helper modules carry the fan-out; timers must `unref` | low | Step 13 |
| F13 | Janitor is co-hosted in a worker thread of the server; `conversations` and `upstream_outbox` do not belong on the rowid list; drizzle's transaction nests as a savepoint at depth > 0 so 5c's reason was overstated though the lint stands | low | §1.6, step 6 |

## 13. Fifth review, whole spec (Codex gpt-5.6-sol xhigh, 2026-09-02) and revision 11

A final reviewer read revision 10.1 end to end with every earlier finding marked untrusted.
Verdict: **replan before decomposition**: Stage A credible; the whole spec did not yet satisfy
either governing requirement. Eight findings, all verified by the author. Full text: issue
artifact "Codex sol final review of the whole spec".

| # | Finding | Severity | Change made |
|---|---|---|---|
| 1 | "Postgres-ready" had no executable path: B′ needs a backend only C builds, and no stage implements Postgres query bodies, which the SQLite drizzle tables cannot supply; "no rework of the store" contradicted §4 | critical | Outcome renamed "prepared for Postgres", proven by a dual-backend vertical slice that also chooses the dialect-query strategy; §5, §6.2, step 3b |
| 2 | Issue rows and sessions are mutable objects mutated before commit and restored by assignment on failure; an await on lease acquisition exposes uncommitted values and lets a rollback clobber a committed change | critical | §1.5 category 9; process-state audit with a model per registry and barrier tests; step 14a |
| 3 | One `afterCommit` list had no valid ambient context (dead token or self-deadlock) and no failure contract; durable mail is a nested write, not I/O | critical | Three mechanisms under a distinct post-commit context with separate failure contracts and failure injection; step 12 |
| 4 | Subscriber-initiated commit timing was a knowing semantic change under a "no behaviour change" definition of done | high | Parity chosen: ordered follow-up slot awaited before the outer operation resolves; §6.1 |
| 5 | Single-writer on Postgres was unenforced and its failure model missing; the feed-head update already row-locks | high | Advisory lease or multi-writer support, retries and idempotency, two-pool tests unconditionally; Stage C step 22 |
| 6 | SQLite-to-Postgres rollout was a one-sentence copy tool; the epoch lesson in `restore.ts` and the transfer proofs were ignored | high | Fenced restartable migration state machine; Stage C step 21 |
| 7 | Mechanically awaited tests cannot prove parity; a rewritten suite encodes the new timing by accident | high | Captured-trace conformance suite from the sync implementation, kept behind a test adapter; §6.1 |
| 8 | A generic dual-dialect table DSL is a premature third schema API | medium | No DSL mandated; technique chosen on the slice; Stage C step 18 |

For reference, Linear's engine, which Podium's kernel resembles in shape: Postgres is the
source of truth, every create, update and delete persists a model snapshot as a "SyncAction"
with a database-wide `lastSyncId`, a MongoDB cache serves bootstrap and delta packets at scale,
and the client hydrates IndexedDB into a MobX object pool with models registered by
decorators. Podium's Authority with its global `seq`, `bootstrap` and `changesSince` is the same
design; what Linear's server-side query layer is built on is not publicly documented.
