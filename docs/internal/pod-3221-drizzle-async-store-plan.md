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
| C. Postgres dialect | A shared multi-tenant database | A second schema (88 tables), a second migration journal, FTS port, a data-copy tool, and a rewrite of the backup/restore/transfer/snapshot subsystem, which is file-level |

A and B are worth doing and can be sequenced so that B is a decision gate rather than a
prerequisite. C should stay a spike until the cloud architecture decision changes, because the
cloud proposal on record is instance-per-tenant SQLite with no shared database
(`docs/cloud/multitenant-cloudflare-architecture.md`), and Turso is SQLite-dialect, so B alone
gets you Turso.

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
  `write()` explicitly (`authority.ts:211-217`). `onAppended` listeners fire inside the span.
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

### 1.6 Other processes on the same database file

| Who | Access | Consequence under Postgres |
|---|---|---|
| Janitor (`apps/janitor/src/janitor.ts:1250`) | second process, read-only handle, `query_only` | becomes a network client with its own role |
| `podium auth mint-session` (`packages/runtime/src/session-mint.ts:116`) | second **writer** | must go through the server, not the DB |
| Daemon transfer (`apps/daemon/src/server-transfer.ts:350`) | opens a staged candidate `podium.db` | file-level; no analogue |
| Migration ledger guard (`packages/runtime/src/migration-ledger.ts:58`) | reads `__drizzle_migrations` | needs a client |
| Backup, restore, snapshot verifier, `wal_checkpoint`, transfer fence, Litestream plan | copy the file, `PRAGMA quick_check` in a child | entire subsystem is per-backend |
| Harness caches (`packages/harness/src/discovery/cache.ts`, codex/opencode readers) | their own or foreign DBs | out of scope |

### 1.7 SQLite-only SQL in runtime queries

| Construct | Count | Portable? |
|---|---|---|
| `INSERT OR REPLACE` | 15 | No. And it is not an upsert: it deletes and re-inserts, firing `ON DELETE CASCADE` on children. Converting to `onConflictDoUpdate` changes behaviour. |
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
2. Decide the executor model up front, because it is the one thing that changes every
   repository signature once: **every repository method takes an executor** (`db` or `tx`) as
   an explicit parameter or is constructed per-transaction; ambient depth counting is retired.
   This is drizzle's own transaction model (`db.transaction(async (tx) => …)`) and the only one
   that survives a connection pool.
3. Decide whether B (async) ships with A or after it. Recommendation below.
4. Driver for the SQLite path: **keep `bun:sqlite`**. `Bun.SQL`'s SQLite mode is a Promise
   wrapper over the same engine on the same thread, ignores transaction modes, and has no queue
   (§1.8), so it buys nothing and loses `serialize/deserialize` (the fast test fixture) and the
   file-level backup path. Both are builtins and survive `--compile`.

### Stage A — drizzle query layer (sync driver, unchanged call sites)

5. Add a `Database` type = drizzle instance built from the schema
   (`drizzle(client, { schema })`), created in `store.ts` next to the migrator on the same raw
   handle. Keep the `SqlDatabase` seam alive for the non-store consumers in §1.6.
6. Convert repositories one aggregate at a time, smallest first (locks, accounts, read-watermarks,
   messaging-topics, approvals) to settle the patterns, then the five large ones last
   (shipping 2,683 lines, issues, sessions, messages, workflows). Each conversion:
   - queries against `schema.ts` tables; typed selects replace the `as Row` casts;
   - `mode: 'boolean'` / `mode: 'json'` on the schema so mappers shrink (schema-only change,
     no migration);
   - `INSERT OR REPLACE` → decide per site: real upsert (`onConflictDoUpdate`) or keep
     delete-then-insert explicitly when the cascade was the point;
   - `rowid` → explicit PK column (migration where the table lacks one);
   - `lastInsertRowid` → `RETURNING`;
   - keep FTS behind a small `SearchIndex` port with a SQLite implementation, raw `sql\`\``
     allowed there only.
7. Use the existing store tests as the oracle: they are 1,840 call sites of characterisation.
   Where a repository has thin coverage, add a golden test before converting it.
8. Replace the `PODIUM_LOOP_PROFILE` prepare-wrapper (`packages/runtime/src/sqlite/query-attribution.ts`)
   with a drizzle `logger` implementation so the attribution survives.
9. Retire the one-time boot upgrades that are past their deletion horizon instead of porting
   them (machine identity `store.ts:595`, repo identity `store.ts:349-391`, the
   `PRAGMA table_info` probes). Each is an introspection site that has no dialect-neutral form.
10. Add `bun run migration:check`-style CI that the schema file and the query layer agree
    (drizzle typecheck does this for free once queries use the tables).

Outcome of Stage A alone: typed queries, one schema truth, call sites untouched, tests
untouched, boot untouched. Reversible per aggregate.

### Stage B — async repositories and explicit transactions

11. Change the port types first and let typecheck drive the rest:
    `TransactPort` → `<T>(fn: (tx) => Promise<T>) => Promise<T>`, `AuthorityPort.commit` and
    `Ledger.commit` → Promise, `StoreDatabaseOpener` → async. Keep the kernel free of drizzle
    types (the lint rule); the `tx` type is opaque to the kernel.
12. Add a **size-one async pool** in front of the connection: top-level transactions queue,
    each gets exclusive use of the connection from `BEGIN IMMEDIATE` to `COMMIT`, nested calls
    become savepoints. This is what every async-SQLite ORM does internally (§1.9); drizzle's
    own bun:sqlite transaction cannot be used for an async body because its callback is
    synchronous. On SQLite the queue is mandatory (§1.8). On Postgres it keeps the Ledger's
    single-writer invariant (D10/D12.6) true without `SELECT … FOR UPDATE` while there is one
    server process per tenant. Reads stay unqueued.
13. `SessionStore` gets an async factory (`await SessionStore.open(path, …)`); the constructor
    stops doing work. Boot heals move into `open()`. Update the 8 non-test constructions and
    the test helpers; give tests one `openTestStore()` helper so the 475 `new SessionStore(`
    sites become one mechanical rewrite. The pre-migrated image fixture keeps working (the
    image is still `bun:sqlite`), but the env-passing hack for the sync constructor goes.
14. Fix the §1.5 list by design, not by sprinkling `await`:
    - frame caches (issues, users, relay closed-set): replace the microtask premise with an
      explicit per-request read scope (a `ReadContext` created at the request boundary and
      passed down), or drop the cache and measure;
    - `get rows()` and lazy hydration → explicit `await service.rows()` or hydrate at boot;
    - constructors that read → `static async create()`;
    - visibility and authz predicates → precompute the principal's view once per request
      (they already read the same rows per call), then the predicate stays sync;
    - array-callback store calls → batch reads (`WHERE id IN (…)`) before the loop, which is
      also the N+1 fix.
15. Convert services top-down: relay, then modules. ~750 sync method bodies in
    `apps/server/src/modules` become async; tRPC procedures (28 sync today) become async. Do it
    one module at a time behind a green typecheck; do not leave a half-async module.
16. The sync repository's seq-range arithmetic (§1.4) → `RETURNING seq` per row or a
    single-statement multi-row `RETURNING`.
17. Benchmarks before and after on the two paths that run thousands of queries per frame:
    feed bootstrap (`gateway/feed-serving.ts`) and issue frame reads
    (`store-issues-frame-cache.test.ts` shape). Assert the query count, not the duration.

Outcome of Stage B: the store runs on any SQLite-dialect driver drizzle supports. Turso remote,
`Bun.SQL`, D1 and DO-SQLite are configuration plus a driver adapter, not a rewrite.

### Stage C — Postgres (only if the cloud decision changes)

18. A second schema module against `pg-core` (88 tables), generated from one source. Do not
    hand-maintain two files: write a small dialect-neutral column DSL (extend the existing
    `brandedRef` helper layer) that emits both `sqliteTable` and `pgTable`, and a test that
    diffs column names and nullability between the two.
19. A second drizzle journal (`out: migrations/pg`). This is exactly the two-ordering-authorities
    problem POD-305 refused; the rule has to be "every schema change is authored for both
    dialects in one commit" with a CI check that both heads name the same logical change.
    Postgres starts from a fresh baseline; the 87 SQLite migrations do not replay.
20. FTS: `tsvector` implementation of the `SearchIndex` port.
21. A SQLite → Postgres data-copy tool for existing tenants, with the JSON-text and 0/1 columns
    mapped to `jsonb` and `boolean`.
22. Locking: every read-decide-write span that relies on SQLite's single writer
    (`BEGIN IMMEDIATE`) needs either the in-process mutex from step 12 (fine for one server
    process per tenant) or row locks / `SERIALIZABLE` if there is ever more than one writer
    process.
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
2. **Design the executor parameter into Stage A even though the driver is sync.** Repository
   methods take `(exec, …args)` from the start, and query bodies are written in drizzle's
   awaitable form rather than the sync `.all()` form. This is the one signature change worth
   paying for early: Stage B then changes return types and call sites, not query bodies.
   Stage B itself cannot be done per aggregate, because a transaction spans repositories (the
   Ledger spans an entity write and the change append), so the transact port flips for everyone
   at once. That is why A must be landable per aggregate and B must be short-lived.
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
- `INSERT OR REPLACE` is delete+insert. Converting it to an upsert silently stops cascading
  deletes and stops resetting columns not named in the statement. Read each of the 15 sites.
- Frame caches (§1.5.1) become wrong, not just useless, under async. Remove or redesign them
  before converting the code that relies on them.
- `onAppended` listeners currently fire inside the transaction; under async they must still
  run before the commit returns to the caller, or broadcast order can diverge from append order
  (the ordered pipe in `authority.ts:493-524` exists for exactly this).
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
   and are both in scope. Stage C remains a spike until the cloud architecture decision is
   revisited, but A and B are done so that C needs no rework of the store.
2. **The size-one transaction queue in front of `bun:sqlite` is the mechanism** for async
   transactions on SQLite (§1.8, §1.9). No driver switch: `bun:sqlite` stays.
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
  `INSERT OR REPLACE` site's cascade was load-bearing, the delete-then-insert stays explicit.
- **Landed per aggregate, on `main`, each commit revertible on its own.** No long-lived branch.
  A conversion that cannot land alone is split until it can.
- **The queue is proven, not assumed.** A test drives concurrent top-level transactions with
  awaits inside their bodies and asserts no lost update, no interleaved `BEGIN`, and that a
  throw rolls back only its own transaction. This test exists before the first async
  repository lands.
- **Nothing runs after its commit.** The Ledger's thenable guard is replaced by a test that
  fails if a transaction body can touch the connection after `COMMIT`; the `tx` handle is the
  only executor inside a body.
- **Hot paths do not regress.** Feed bootstrap and issue frame reads are measured before Stage
  B starts and after it lands; the gate is query count per request, and the budget is "no
  increase". The frame caches are removed only when their replacement holds that number.
- **The file-level subsystem is untouched by A and B.** Backup, restore, snapshot verification,
  transfer fence and WAL checkpoint keep working on `bun:sqlite` as they do now; the janitor's
  read-only handle and the CLI's `mint-session` writer keep working.
- **The pre-migrated test fixture keeps its speed.** Store construction in tests stays on the
  page-image path.
- **Boot order is preserved.** The async `open()` runs migrations, repository construction and
  the boot heals in the same order the constructor does today, and nothing reads the store
  before `open()` resolves.

### 6.2 "Ready for Postgres on the server"

Checkable at the end of Stage B, and the acceptance for this issue's tree:

- Every repository method takes an executor (`db` or `tx`) and returns a Promise. No
  repository closes over a connection. `SessionStore.transact` is the only way to open a
  transaction and it runs through the queue.
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
- **The proof:** the Stage C spike runs the store tests for three repositories (locks, accounts,
  sync) against a real Postgres through the same executor interface, with no change to the
  services above them. That spike is the acceptance test of "ready", and it is listed as the
  last sub-issue of Stage B rather than the first of Stage C.

## 7. Working rules for the conversion

Rules for whoever converts a repository. Each one is either a generic ORM-adoption rule made
specific to this codebase, or a trap found by checking such a rule against the code.

1. **Drizzle is the default, not a religion.** Ordinary select, insert, update, delete and
   expression composition use the query builder. `sql\`\`` fragments inside a builder query
   (a `coalesce`, a computed order key) are fine anywhere. Whole raw statements and anything
   dialect-specific live behind a named port (`SearchIndex` for FTS) and nowhere else. The
   Stage B lint forbids the §1.7 construct list, not the `sql` tag itself.
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
   that quarantines; the five columns already declared `mode: 'json'` are only safe where a
   throw is the intended behaviour. Decide per column, in the conversion commit.
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
9. **No ORM machinery beyond the builder.** Select, insert, update, delete, expressions,
   prepared statements and `sql`. No relational query API, no `defineRelations`, no
   eager-loading, no generic base repository. The relational API is the part of drizzle that
   changed most between release candidates.
10. **Incremental, and no schema redesign in the same change.** One repository per commit with
    the existing tests as the oracle. The schema changes this plan does call for (mode
    declarations, an explicit primary key where a table is addressed by `rowid`) are additive,
    each is its own migration, and none lands in the same commit as a query conversion.
11. **No synchronous-local-SQLite assumption in any contract.** Repository and port signatures
    are async and take an executor even while the driver underneath is synchronous, so Turso
    or Postgres is a driver substitution and not an architecture change. This is Stage B's
    whole reason, and it is the rule the frame caches, getters and constructor reads in §1.5
    violate today.
