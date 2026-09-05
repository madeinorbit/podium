# Async store on drizzle, SQLite locally and Turso remotely — specification (POD-3221)

Status: decided and ready to execute, 2026-09-03. This is the current design. The path that led
here, including five independent reviews and the Postgres, Kysely and PGlite analyses, is
preserved verbatim in `pod-3221-history-spec-and-reviews.md` and
`pod-3221-history-execution-method.md`. Nothing in those files is authoritative where it
disagrees with this one. How the work is sequenced and executed is in
`pod-3221-execution-method.md`; how a coordinator runs it is in `pod-3221-coordinator-brief.md`.

## 1. Decision and outcome

**Decision.** SQLite dialect everywhere. bun:sqlite for self-hosted installs and the desktop
sidecar, exactly as today. Hosted Turso for the server, through the libsql remote client (pure
JavaScript, hrana over HTTP or WebSocket), so the platform owns replication, backup and
point-in-time restore. drizzle stays the query layer, with two drivers
(`drizzle-orm/bun-sqlite`, `drizzle-orm/libsql`) over the schema file that already exists.
Postgres is not pursued. If a second dialect is ever needed, the Kysely path in the history
document is the recorded fallback.

**Two requirements govern every step.**

1. Podium as it exists keeps running exactly as it does today on SQLite.
2. The hosted server runs on a Turso database end to end with the same store code.

**What is built.**

- Every database call becomes asynchronous, behind an explicit unit of work handed to the code
  that runs inside it.
- Writes are serialised deliberately by a scheduler with read, write and exclusive lanes, an
  active-transaction token, and ambient routing, instead of by the accident of one thread.
- Everything that is not a database write moves out of the transaction into three named
  post-commit mechanisms with their own failure rules.
- Every place that silently relied on "nothing can happen between two lines" gets an explicit
  model that is correct with awaits in it.
- Hand-written SQL strings and row casts become typed drizzle queries fed from the schema file,
  with the existing tests as the oracle.
- The feed protocol is unchanged: gap-free sequence numbers per feed, publication order equals
  commit order, certified reads from one snapshot.
- The file-level durability subsystem goes behind a port the Turso backend leaves empty; the
  operator paths become clients; the Turso backend is enabled and accepted.

**Tenancy is postponed.** Multi-tenancy is a later epic; the direction on record is
workspace-keyed tables with the workspace as the feed boundary, and Turso's database-per-tenant
model matches the instance-per-tenant architecture on record. Two seams stay open so that later
work is a column and a context value, not a redesign: the feed head is keyed by feed, never a
singleton, and the executor carries a context slot, empty today.

## 2. The system as it is

### 2.1 Runtime and driver

- Bun is the only shipped runtime; the release is one `bun --compile` binary
  (`scripts/build-bun.ts`, four targets). Since PDM-25 on `dev/mw` there is no Node SQLite
  driver at all: `openDatabase` refuses a non-Bun runtime. No native addon may enter the
  binary; the libsql *remote* client is pure JavaScript, the default `@libsql/client` entry
  loads a native package and must not be used.
- The persistence seam is `SqlDatabase` (`packages/runtime/src/sqlite/types.ts`): sync
  `prepare`/`run`/`get`/`all`/`exec`/`close` with positional parameters. One shared connection
  per process. The nesting-safe `transaction(db, fn)` helper
  (`packages/runtime/src/sqlite/transaction.ts`) keys depth on the handle object, issues
  `BEGIN IMMEDIATE` at depth 0 and savepoints below, and throws if `fn` returns a thenable.
- The migrator (`apps/server/src/migrations/index.ts:228-258`) runs drizzle's bun-sqlite
  migrator on the raw handle and refuses any other handle; `PRAGMA foreign_keys` is a no-op
  inside a transaction and drizzle migrates inside one, so the store's own OFF/ON bracket
  (`store.ts:199-216`) is the only protection for the 13 table-rebuild migrations.

### 2.2 Query surface

| What | Count | Where |
|---|---|---|
| Repository classes | 34 | `apps/server/src/store/*.ts`, `store/conversations/*`, `modules/operations/store.ts`, `packages/sync/src/adapters/sqlite/sync-repository.ts` |
| `.prepare(` sites in repositories (non-test) | about 570 on `dev/mw` as of 2026-09-03 (529 at the 2026-09-02 audit) | shipping 77, issues 59, sessions 42, workflows 33, messages 33, repos 28 at the audit |
| Repository method signatures | ~620 | |
| `transaction(this.db, …)` inside repositories | 41 | shipping 19 |
| Store call sites from services (non-test) | 574 | 45 files; relay.ts 56, superagent/service.ts 56, issues/service/reads.ts 43 |
| Store call sites in tests | 1,840 | 92 test files |
| `new SessionStore(` | 475 | 107 test files plus server.ts, relay.ts, the daemon recovery worker, scripts |

No base class, no shared query helper, no prepared-statement cache; every site is
`this.db.prepare(sql).get(...) as Row` plus a hand-written mapper. Services do not hold the store:
they hold narrowed dependency lambdas built in `relay.ts`.

### 2.3 Drizzle today

drizzle-orm and drizzle-kit `1.0.0-rc.4`, pinned. Only the migrator runs at runtime. Schema-as-code
is complete: 84 `sqliteTable` in `apps/server/src/migrations/schema.ts` and 4 in
`packages/sync/src/adapters/sqlite/schema.ts`; text ISO timestamps, integer 0/1 booleans, JSON as
text with 23 `mode: 'json'` columns, 64 CHECK constraints, 36 `brandedRef()` calls; `$type<…>()`
on 134 columns so brands flow through inference (the limit in `branded-ref.ts` concerns
`references()` only). 97 migrations on `dev/mw` as of 2026-09-03 (87 at the audit), all
generated, inlined into `drizzle-manifest.generated.ts`;
FTS5 tables are created per boot (`store/conversations/index.ts:17`), not in migrations. The
snapshots do not record column `mode`, so mode changes need no migration. ADR 6 D5.3 currently
says repositories keep raw SQL; it is amended by this epic.

Verified drizzle facts: the bun-sqlite driver's `transaction()` callback is synchronous (an async
callback commits before its body runs); its logger sees `logQuery(query, params)` only, no
timing or rows; it calls the client's cached `query()`, never `prepare()`; the bun-sql and
sqlite-proxy drivers do not serialise concurrent transactions either. No drizzle-level answer to
async SQLite transactions exists or is signalled (drizzle-orm #2275, #1472). The relational query
API is a read-only API that changed in three consecutive release candidates and silently drops
`undefined` filter values in rc.4 (#5636); it is not used in this epic.

### 2.4 The sync kernel is synchronous by decision

`TransactPort = <T>(fn: () => T) => T` (`packages/sync/src/authority/ports.ts:106`).
`Authority.commit` runs zero-argument `authorize`, `arbitrate.current` and `write` callbacks and
appends through its root change store (`authority.ts:183-224, 444-451`), rejecting an async
`write()`; it is atomic today only because one handle is inside the open `BEGIN`. Publication is a
post-commit tail: `finalize` folds the baseline and broadcasts after `transact` returns
(`authority.ts:452-488`), each subscriber isolated; the ordered pipe (`:493-528`) lets a
subscriber commit re-entrantly, durably before its call returns, with delivery queued behind the
current batch. `capture` and `reconcile` finalise with no span of their own (`:226-255`); the
`announce: false` convention (`issues/service/core.ts:990, 1019`) keeps a feed event from
publishing inside a span. `bootstrap` reads `latestChangeStates()` then `cursor()` in one
synchronous pass (`:300-339`); `readChangesSince` pages to `max` relying on the synchronous single
writer (`change-log.ts:274-319`); `FeedServing.serveWorld` reads the world and installs the peer
at that head in one turn (`feed-serving.ts:377`). Scoping calls the synchronous
`policy.decide` and `anchors.visibilityEdge` per row (`scoping.ts:122-128, 210, 234`), whose
server implementations read the store per row (`feed-visibility.ts:171, 218`) and load the whole
sessions table (`:464-469`). The sync repository derives sequence numbers by arithmetic from
`lastInsertRowid` (`sync-repository.ts:71-77`) and reads the head from `sqlite_sequence` (`:131`).
The kernel lint forbids drizzle, `bun:*` and the runtime sqlite module outside
`packages/sync/src/adapters/`.

Client replicas (IndexedDB, expo-sqlite, Tauri SQL) share no server queries and are out of scope.

### 2.5 Code that relies on "no yield between two lines"

1. Frame caches keyed on the microtask boundary: `store/issues.ts:33-97` (5,163 reads and 13 s
   of CPU in the profile that created it), `store/users.ts:49-82`, `relay.ts:1153-1161`.
2. The repos registry cache invalidated by a proxy that inspects SQL text
   (`store/repos.ts:27-123`), plus a second unwrapped handle because transaction depth is keyed
   on handle identity (`:64-77`).
3. Constructors and getters that read the store: `relay.ts` `SessionRegistry` (`:431-1210`,
   eight aggregates), `modules/superagent/service.ts:264`, `modules/memory/service.ts:67`
   (writes), `modules/issues/service/core.ts:207-210` and `:130-135`.
4. Synchronous predicates handed to the kernel: `feed-visibility.ts:171-219, 464-469`,
   `modules/sessions/session-authz.ts:79-85`, and the resolver lambdas at
   `modules/operations/engine.ts:162`, `modules/machines/login-propagation.ts:83`,
   `modules/sessions/launch-config.ts:60`, `modules/sessions/workspace.ts:43`.
5. Store calls inside array callbacks: `modules/issues/service/mail-pending.ts:38`,
   `modules/issues/service/core.ts:960`.
6. Read-decide-write spans: `modules/lock/service.ts:339-549` (seven), `modules/messages/service.ts:225, 846`.
7. Boot is synchronous end to end: `new SessionStore()` opens, sets PRAGMAs, migrates, builds 34
   repositories and runs the boot heals in the constructor (`store.ts:199-330`), with the
   machine-identity upgrade before any reader (POD-318); the pre-migrated test fixture depends on
   the synchronous constructor (`test-support/pre-migrated-store.ts:50-52`).
8. In-memory mirrors written in the same frame as a store write, and timers without a
   single-flight guard: `shipping/service.ts:1792, 2311`, `sessions/inbox.ts:688-700`,
   `messages/service.ts:850-861`; `messages/scheduler.ts:345`, `relay.ts:2690`; `inbox.drain`
   already has a guard.
9. Mutable process-owned objects mutated before commit and restored by assignment on failure:
   issue rows (`issues/service/crud.ts:959-1007`, `core.ts:875-924`), sessions
   (`session-meta-ops.ts:323-332`, `sessions/repository.ts:326-359`).

### 2.6 Other users of the database file

| Who | Access | Under Turso |
|---|---|---|
| Janitor (worker thread in the server process since POD-2505, `janitor-host.ts`, `janitor.ts:1250`) | second connection, read-only | a second remote connection with its own read-only token |
| `podium auth mint-session` (`packages/runtime/src/session-mint.ts:116`) | second process, writer | goes through the server |
| Daemon transfer validation (`apps/daemon/src/server-transfer.ts:320-379`) | opens a candidate file; checks integrity, feed identity, epoch, migration head | through the durability port |
| Migration ledger guard (`packages/runtime/src/migration-ledger.ts:58`) | reads `__drizzle_migrations` | through the driver |
| Backup, restore, snapshot verifier, `wal_checkpoint`, transfer fence (`migrations/backup.ts`, `restore.ts`, `snapshot-verifier.ts`, `store.ts:400-540`) | file-level | behind the durability port, platform-managed |
| Harness caches and the codex and opencode readers | their own or foreign databases | out of scope |

### 2.7 SQLite constructs in the repositories, under one dialect

Both drivers accept rowid ordering, `INSERT OR REPLACE`, `INSERT OR IGNORE`, `ON CONFLICT`,
`RETURNING`, `GLOB`, `lastInsertRowid` and the JSON functions, so none of these is removed for
portability. What leaves the repositories is what a remote connection cannot rely on or what
belongs to the driver and migrations: `PRAGMA` (10 runtime sites, including `table_info`
introspection at `store.ts:585` and `store/sessions.ts:887`), `sqlite_master` reads,
`ATTACH`. `INSERT OR REPLACE` (13 statements plus `session-mint.ts:186`) deletes and re-inserts:
none of its targets is a foreign-key parent, so no cascade is involved, but every column not
named resets to its default; a conversion to an upsert must name every column. FTS5 stays behind
the search port. The boot upgrades in `store.ts` (machine identity, repo identity, worktree
machine identity) are retired rather than ported.

### 2.8 Verified driver facts

- Bun's own async SQL client runs SQLite on the event-loop thread, has no transaction queue,
  ignores transaction modes, and behaves the same on Bun 1.4.0. It is not used.
- SQLite's busy wait is synchronous: on one thread a second connection waiting for the write
  lock blocks the loop the first connection's `await` needs. Engine-level locking cannot
  serialise async transactions inside one process. Serialisation is done by whoever hands out
  the connection: an in-process queue for bun:sqlite, the platform for Turso.
- Async over an in-process synchronous engine adds interleaving risk without adding concurrency;
  the hop costs about a quarter of a microsecond. What it buys is driver independence, which is
  the Turso backend.
- On Turso each statement is a network round trip; the platform serialises writers per database
  and a concurrent writer receives a busy error; reads may run concurrently on separate
  connections; an interactive transaction is held open on the server across awaits. The exact
  timeouts, error shapes and PRAGMA behaviour are measured by the remote spike before the flip.

## 3. Target design

### 3.1 The executor and the repository set

Every repository is bound to an executor. `store.x` is the set bound to the root executor,
`tx.x` the same classes bound to a transaction, and the root set routes ambiently: with no
transaction context in `AsyncLocalStorage` a call runs on the root through the scheduler; with a
live context it runs on that transaction; with a dead token it rejects. Services keep their
narrowed dependency lambdas and their call shapes; `tx.x` is the explicit form inside the store
and the kernel; `store.outsideTransaction(fn)` is the one explicit committed-view read from inside
a body. The executor object is `{ drizzle, transact, read, legacy, context }`: `transact` and
`read` are methods (the raw handle is never exposed), `legacy` is the raw handle for unconverted
repositories and is deleted at the end of Stage A, `context` is the tenant seam, empty today.

Repository state is process-scoped and shared between the root and every transaction-bound set:
the grants repository's visibility audiences and revision counter (`grants.ts:87-112`) that the
feed cache validates against, the sync repository's latest-state cache and generation
(`sync-repository.ts:29-38`) that keys the feed-visibility cache, and the issues, users and
repos caches. Executor-bound query operations are separated from one `RepositoryRuntimeState`
graph. The transaction-bound set never serves from shared caches: it reads through, or keeps a
transaction-local cache discarded at the end. Shared caches are invalidated in the after-commit
mechanism; rollback discards the local cache and may invalidate the shared one. The three
cross-aggregate callbacks (sessions to observation checkpoints, issues to repos, repos to issues,
`store.ts:227-236`) are bound within the set being built.

### 3.2 The scheduler

A port with three lanes and a stated isolation each: `read` is a consistent snapshot at one
head; `write` is serialised with all writes and sees its own writes; `exclusive` runs alone. The
bun:sqlite implementation maps all three onto one lane: a size-one async queue owns the
connection, a top-level transaction holds it from `BEGIN IMMEDIATE` to `COMMIT` or `ROLLBACK`,
reads outside a transaction wait behind an open one. This reproduces today's semantics exactly.
The libsql implementation keeps one in-process write lane (Turso's single writer per database
means a second lane would only produce busy errors, and a bounded retry handles the busy error a
second process would cause) and may run the read lane concurrently.

Re-entrancy is by `AsyncLocalStorage`, not handle identity: a `store.transact` call from inside a
body becomes a savepoint on the open transaction, never a queue wait on itself. An active
transaction token is checked on every operation and invalidated before the callback's result is
returned and before the connection is released; a stale context rejects; parallel nested
transaction branches reject; an `exclusive` request from a lease holder rejects. A watchdog
reports a body that has gone SILENT past a budget — the gap since its last statement, not
its total duration — through an injectable sink. No I/O other
than the database runs inside a body.

Lifecycle: `open → accepting → draining → closed`. Intake and background producers stop,
persistence steps are awaited in order (`PersistStep` becomes awaitable; `shutdown.ts:33-48`
runs them without awaiting today), queued work drains, then close. Drain policy for a parked body:
after the grace period roll back the holder, invalidate its token, proceed. Every use of the
handle goes through the scheduler: migration (carrying the `foreign_keys` OFF/ON bracket on its
own connection), `wal_checkpoint`, backup, the transfer fence and `close` are exclusive
operations on bun:sqlite; on the remote driver the file-level ones do not exist. The transfer
fence (`PRAGMA query_only`) is per connection and therefore in-process only until the mint-session
writer goes through the server.

### 3.3 Post-commit work

Publication stays on the far side of commit, as today. Three phases: the database transaction;
commit; then the ordered baseline update and publication. The scheduler may keep its lease
through phase 3 so a later commit cannot overtake publication, but the SQL transaction is closed
first. Phase 3 runs under a distinct post-commit context value that routes to the root, inside
the scheduler's ordered operation, and consists of three mechanisms with separate failure
contracts:

1. **Internal commit application**: the baseline fold and mandatory cache invalidation, in a
   defined order, not skippable; an invariant failure marks the store unhealthy and forces a
   reseed or restart, which is today's contract.
2. **Durable follow-up writes**: each nested write inside a span today (`LockService.steal`
   calls `sendMail`, `lock/service.ts:500-539`; `IssueService.sendMail` is a durable write plus a
   nudge, `issues/service/mail.ts:57-79`; `capture` and `reconcile` finalise with no span) is
   decided individually: it stays in the unit of work as a durable nested write, or becomes an
   idempotent reaction enqueued as a scheduler follow-up or a transactional outbox row. Durable
   mail is never reclassified as best-effort.
3. **External effects**: sockets, notifications, process callbacks; independent, caught per
   effect, with stated retry or demotion.

The spec states which of the three the outer promise waits for. A subscriber-initiated durable
commit completes before the outer caller's `await` resolves, while batch N still reaches every
subscriber before batch N+1 (an ordered follow-up slot the outer operation awaits); the durable
re-entrant subscribers are enumerated with caller-visible tests. Publication flush is driven by
the scheduler going idle, bounded by a maximum batch or delay, because the microtask flush
(`funnel.ts:311`, `feed-serving.ts:652`) would turn a burst of N commits into N frames per
connection. Failure injection at every hook position: an ambient root-store call from a tail, an
async visibility-prefetch rejection (demote or retry the subscriber, never corrupt the baseline
or report a committed write as rolled back), a durable follow-up rejection, a subscriber that
throws.

### 3.4 The kernel's unit of work

`TransactPort<Uow>` passes a unit of work; `UnitOfWorkPort = { write, read }`;
`AuthorityCommit<Uow, T>` hands it to `authorize`, `current` and `write`; the Authority resolves
its change store from the same unit of work, so the entity write and the change append are
provably on one connection. Every storage-backed Authority method is async: baseline seed,
`capture`, `reconcile`, `changesSince`, `cursor`, `bootstrap`, the retention reads. The kernel
stays free of drizzle types. `StoreDatabaseOpener` becomes awaitable; the test fixture's
synchronous clone opener is wrapped in `Promise.resolve` and its env channel from `globalSetup`
stays, because it is still the only synchronous channel to the forks.

Sequence numbers keep today's mechanism: the AUTOINCREMENT counter is transactional on SQLite,
so a rolled-back append rolls back the counter, and the feed stays gap-free on both drivers.
The remote spike and the sync-append proof confirm this on Turso, including the busy-error
shape a second writer receives and the retry policy for it.

### 3.5 Certified reads, admission, scoping, live grants

`bootstrap`, `changesSince`, the cursor and floor checks and every paged certified read run in
one `read` unit of work and return the rows with the head and floor from that same snapshot.
Feed admission registers the peer (`publisher.connect`, `retainPrincipal`) inside that same unit
of work, before it releases, so no commit can land between the world read and the registration;
the authorisation revision is read inside the same scope. Phase 3 scoping gets a per-batch
visibility prefetch: `FeedVisibilityPolicy` gains `forBatch(refs)` beside the existing
`forBootstrap` (`feed/visibility.ts:236, 311`); the server prefetches every issue, session and
grant list the batch's subjects reach in one batched read under the writer's lease, and `decide`
and `mayRead` stay synchronous over that snapshot, which also replaces the whole-table session
read. Live grant, one definition: **live means read under the lease that applies or publishes
the decision**. A command reads rights under its write lease; phase 3 reads them under the
writer's lease at the committed head; bootstrap under its read lease; the `worldFor` cache
validates on `(cursor, authorizationRevision)` read under the same lease. ADR 9 D2 rule 4 is
amended with that sentence (the code's "D16.1" comments at `grants.ts:25, 114` name a decision
that does not exist and are corrected).

### 3.6 Removing the hidden dependencies on synchronous execution

- Frame caches become unit-of-work-scoped caches in `RepositoryRuntimeState`, valid for a read
  lease: the fan-out passes (the publish flush, the bootstrap read) run inside one `read` scope.
  Dropping them is not an option (13 s of CPU per fan-out); the query-count gate is the proof.
- Constructors that read become `static create()` factories called in the store's current boot
  order; getters become methods with an explicit hydrate step; a constructor that writes moves
  the write to a boot step.
- Store calls inside array callbacks become one batched read before the loop (respecting the
  999-variable chunking), then a map lookup.
- Timer callbacks that reach the store get a single-flight guard (skip or coalesce, recorded
  per site).
- Mutable process-owned objects get one explicit model per registry: acquire the write unit of
  work before reading or mutating and make every reader take the read lease; or build an
  immutable draft from a committed snapshot, persist it, and install the new object only after
  commit (for issues, drafts plus a revision check replace rollback-by-assignment); or a
  versioned mutex independent of the database scheduler. Sessions separate the durable metadata
  snapshot from live terminal state and say which fields may change while persistence is
  awaiting. Barrier tests: two updates to the same issue and the same session, a rollback
  racing a successful update, an in-memory read while a write is parked, all over an injected
  async persistence fake.
- Boot: `SessionStore.open()` is the async factory with a private constructor, running
  migrations, repository construction and the boot heals in the constructor's current order;
  the 9 non-test constructions and one `openTestStore()` helper replace the 475 test sites;
  timers `unref` so tests never hang.

### 3.7 The two drivers and the Turso backend

**Driver facts settled by the query-layer confirmation (issue 0.0, 2026-09-03).**

- The libsql client's transaction modes map to SQL as `write` = `BEGIN IMMEDIATE`, `read` =
  `BEGIN TRANSACTION READONLY`, `deferred` = `BEGIN DEFERRED` (`@libsql/core/util`
  `transactionModeToBegin`). drizzle's libsql driver calls `client.transaction()` with no mode
  and relies on the client's default of `write`, which the client marks deprecated and will
  remove. So the scheduler's libsql implementation calls `client.transaction("write")`
  explicitly and never relies on drizzle's own transaction method, which the lint forbids
  anyway. Write-lock-first semantics are therefore identical on both drivers.
- Remote interactive transactions lock the database for writing until committed or rolled back,
  **with a 5-second server-side timeout** (Turso client reference). THAT TIMEOUT BOUNDS THE GAP
  BETWEEN STATEMENTS, NOT THE TRANSACTION'S TOTAL DURATION — it is an idle timeout, and POD-3345
  measured both arms against the engine to be sure: a 20-second transaction with a statement every
  2 seconds commits untouched, while a single 12-second silence is reaped. So on the Turso backend
  the watchdog budget is below it and measures the same quantity, no body may await anything but
  the database, and the sync-append proof measures how many round trips fit. A
  batch (`client.batch`) runs its statements in one implicit server-side transaction with a
  full rollback on failure and is the preferred form for multi-statement writes that need no
  read-decide-write.
- A client performs up to 20 concurrent requests by default; the read lane's concurrency on
  Turso is bounded by that and by what the spike measures.
- Savepoints are ordinary statements inside the open transaction; the spike confirms nesting
  over hrana. The error shape a concurrent writer receives, and behaviour on network loss
  mid-transaction, are not documented and are measured by the spike (issue 0.9, gate 3).
- Only the `/web` entry of `@libsql/client` is pure JavaScript; the default entry loads the
  native `libsql` package and must not be imported anywhere.
- Typecheck cost of drizzle's generics on `apps/server` is measured on real code by the first
  conversion wave, scoped and with concurrency 1, and recorded at checkpoint R2.

The executor takes a driver interface. bun:sqlite: synchronous, in-process, the queue owns the
connection, attribution wraps the raw client's `query` and `prepare` (forwarding `exec`,
`transaction`, `serialize`, `values`) and registers with `aliasBunSqliteClient` so the migrator
still resolves the handle; one cached statement per distinct SQL text results and is measured.
libsql remote: asynchronous, one in-process write lane, optional concurrent read lane,
attribution wraps `execute` and `batch`, the busy-error retry policy from the sync-append proof,
`drizzle-orm/libsql`'s migrator for open-and-migrate with the same downgrade guard, out-of-order
guard and boot logging (backup is platform-managed), the migration-ledger guard reading
`__drizzle_migrations` through the driver, FTS5 objects created per boot over the remote
connection, the connection string and auth token from the instance config and never from the
settings blob that round-trips to the browser.

Durability is a port: the bun:sqlite implementation is the current code moved behind it,
unchanged and running through the exclusive lane; the Turso implementation reports
platform-managed for backup and snapshot, rejects the transfer fence and candidate-file
validation as not applicable, and exposes migration head and feed identity through ordinary
queries so the update flow's proofs still work; the update operation branches on the port's
capability, never on the driver name. Moving a hosted tenant is a platform import of its SQLite
file into its own Turso database, with the migration ledger and the feed identity (`feed_id`,
`epoch`) verified intact or a new epoch minted deliberately (`migrations/restore.ts:1-65` records
why the epoch must move with the data), the FTS objects recreated on first boot, the source
fenced from snapshot to switch, and the rollback boundary at the first accepted write.

## 4. Stages

Stage 0 decides the interfaces and makes every shared edit once. Stage A converts repositories
to drizzle on the synchronous driver, one package per worker in waves. Stage B-prep removes the
hidden dependencies on synchronous execution while everything is still synchronous. Stage B is
the minimal async flip under a freeze, then the post-flip list. Stage E enables the Turso backend.
Five coordinator checkpoints sit between the stages and review the subtree, the state of the
work and the measurements, and replan. The exact steps, gates and issue tree are in
`pod-3221-execution-method.md`.

## 5. Definition of done

### 5.1 "Keeps running stably as it is today"

- **No behaviour change on SQLite.** The existing store and service tests are the oracle. For
  Stage B the oracle is that same suite as awaited before the flip, green on the synchronous
  implementation before and on the asynchronous one after, with no assertion changed between;
  the reviewer rule at the flip is mechanical: changed test lines differ only by `await`,
  `async` or the helper rename. Where an `INSERT OR REPLACE` named only some columns, the reset
  of the others stays explicit.
- **Landed per package on the epic's integration branch, each commit revertible alone.** The
  integration branch starts from `dev/mw`; `main` and `dev/mw` are not touched until the epic's
  close checkpoint, after the whole result has been tested, when the integration branch is
  merged back into `dev/mw`. No long-lived worker branch except the flip, which is days under a
  freeze.
- **The queue is proven, not assumed.** Deterministic interleaving tests: serialisation, no
  interleaved `BEGIN`, rollback isolation, a reader during an open body sees only committed
  rows, re-entrant transact becomes a savepoint, a subscriber-initiated commit completes before
  the outer await resolves while batch N reaches every subscriber before N+1, a stale token
  rejects, parallel nested transactions reject, read-your-writes inside a body for every cached
  aggregate, an exclusive request from a lease holder rejects, one commit batch certifies exactly
  one frame per connection on the boot-reconcile and bind-storm fixtures, the watchdog reports
  through an injectable sink. Plus the mutable-state model tests. These exist before the first
  async repository lands.

  AMENDED 2026-09-03 (POD-3243, coordinator). This clause read "frames per burst equal one for
  the boot reconcile and a bind-storm fixture" and was read as a claim about today's production
  paths. It is not: it is a property of the SCHEDULER's own fixtures — one commit batch, one
  certified frame. Today's production bind storm measures **two** frames per burst, a leading
  immediate run plus one coalesced trailing flush, which `relay.bind-storm.test.ts` already pins
  as 1..3. That leading run is existing behaviour and removing it is out of scope: the first
  clause of this section is "no behaviour change on SQLite". The production arm is governed by
  "hot paths do not regress" below, whose budget is no increase against the recorded baseline —
  so a bind-storm baseline of two is correct as recorded and must not be tightened to one.
- **Nothing runs after its commit.** The token, not the callback boundary, enforces it.
- **Hot paths do not regress.** Query count per request on feed bootstrap and issue frame reads,
  and frames per burst, measured before and after; budget "no increase"; on Turso, query count
  per request is round trips per request. The instrument is `scripts/measure-hot-paths.ts`
  (POD-3243), run with `--conditions=@podium/source`; baselines are issue artifacts, never
  committed. BASELINE RECORDED 2026-09-03 at fixture scale 50 sessions / 30 issues:
  `feedBootstrap.queriesPerRequest` 44, `issueFrameReads.queriesPerRequest` 371,
  `bootReconcile.framesPerBurst` 1, `bindStorm.framesPerBurst` 2. Reproduced independently by
  the coordinator before landing; the gate was proven able to fail four ways.
  What the numbers are: the 44 bootstrap reads are 27 single-row machine lookups and 9 grant
  reads; the 371 issue-frame reads for 80 rows are the child-table N+1 (issue_deps 240,
  issue_labels 80, issue_comments 51) while the issues table itself is read zero times because
  the frame cache holds. Those are the targets of issues B0.2 and B0.6, and the first `await`
  anywhere in the issue read fan-out drops the frame cache, which is the exact mechanism by
  which the conversion could move the 371.
- **The file-level subsystem behaves as today.** Its code goes through the scheduler and
  behind the durability port; its behaviour does not change; the janitor's and the CLI's paths
  keep working on SQLite.
- **Shutdown is ordered and awaited**, tested with a parked transaction.
- **Boot order is preserved** and nothing reads the store before `open()` resolves.
- **The pre-migrated test fixture keeps its speed.**

### 5.2 "The hosted server runs on Turso"

- Every repository method returns a promise and every repository instance is bound to an
  executor; no repository closes over a connection; `SessionStore.transact` and `read` are the
  only entry points and run through the scheduler.
- No `PRAGMA`, `sqlite_master` or `ATTACH` in a repository query body; no raw handle; no
  drizzle transaction outside the store's port; a boundaries lint enforces it with a fixture
  proving it fires. The `// DECISION POD-<n>` marker is its only unanswered-site allowlist and
  must be zero at Stage A exit; rule 1's permanent UPDATE-conflict token is accepted only with
  the matching statement shape.
- Full-text search sits behind a `SearchIndex` port with the FTS5 implementation; whole raw
  statements are allowed there with parameters bound. The only repository-side exception is
  rule 1's marked SQLite UPDATE conflict clause, which drizzle's update builder cannot express.

  OUT OF SCOPE FOR THIS EPIC (human decision, 2026-09-03). Full-text search is treated as
  unsupported on the cloud version for now, and the CLOUD epic is putting it behind a flag. This
  epic therefore does not need a non-MVCC Turso database and does not redesign hosted search; E.5's
  full-text arm is out of scope rather than blocked, and POD-3272 no longer waits on it. The
  measured facts below stay on record for whoever implements that flag.

  FTS5 does not exist on Turso as provisioned (POD-3251, 2026-09-03). **FTS5 does not exist on
  Turso as provisioned.** Both databases report `PRAGMA journal_mode = mvcc` and refuse every
  virtual table: `Tursodb error: Parse error: Virtual tables are not supported in MVCC mode`.
  Verified independently by the coordinator with a control — a plain `CREATE TABLE` on the same
  connection succeeds, a `CREATE VIRTUAL TABLE ... USING fts5` is refused. So `conversations_fts`
  and `transcript_fts` cannot be created on the hosted backend.

  It does not break the boot: `store/conversations/index.ts` catches and falls back to `LIKE`. That
  fallback is the problem, not the safety net — on Turso it becomes a remote `LIKE` scan over 3,528
  conversations and 32,697 transcript rows, so command-palette and transcript search would be
  unusable rather than merely slower.

  Also refused on the same databases: `PRAGMA journal_mode = WAL`, `wal_checkpoint`,
  `busy_timeout`. Accepted: `foreign_keys` (per connection, reads back), `defer_foreign_keys`,
  `synchronous`, `user_version`, `table_info`. And the WebSocket transport does not exist at all —
  a `wss` upgrade is answered `400 protocol upgrade not supported`, so hrana over HTTP is the only
  transport and the spec's "HTTP and WebSocket transports" has one arm that cannot be measured.

  THE OPEN QUESTION, which is a platform question before it is a design one: is a non-MVCC or
  legacy sqld Turso database available on this plan? If yes, this clause stands unchanged and the
  spike re-runs against one. If no, E.5 needs a different `SearchIndex` implementation for the
  Turso backend, and that is a scope change the human must take, not the coordinator. Until it is
  answered, treat E.5's full-text arm as unspecified. The good news either way: the migration chain
  applies clean to a fresh remote database — 97 migrations, 587 statements, 685 round trips, 0
  failures, 136 s — and `__drizzle_migrations` reads back remotely at 97/97.
- The Turso backend boots a fresh database, upgrades and reopens an imported one, runs the full
  store and service suites against the local Turso server in CI and once against a real Turso
  database, shuts down cleanly with a parked transaction, survives network loss
  mid-transaction, and stays within the round-trip budget set by the spike. The sync-append
  proof and the remote spike are its early evidence.
- ADR 2 D10 and D12.6, ADR 6 D5.3 and ADR 9 D2 rule 4 are amended to describe the landed
  mechanism.

## 6. Working rules for the conversion

1. **drizzle is the default, not a religion.** Builder queries by default; `sql` fragments inside
   builder queries anywhere; whole raw statements behind the search port, parameters bound,
   never `sql.raw` of user input. The one repository-side exception is an SQLite
   `UPDATE OR <conflict-algorithm>` clause, because drizzle's SQLite update builder exposes no
   conflict clause: keep the whole update atomic through the query layer, write every identifier
   literally, interpolate every runtime value as a bound parameter, and mark the call span
   `// UPDATE-CONFLICT STATEMENT POD-3406`. The lint requires both that token and a statement whose
   first tokens are `UPDATE OR ROLLBACK|ABORT|FAIL|IGNORE|REPLACE`; the token cannot exempt another
   raw statement. Do not replace the conflict clause with a read-then-write guard: the first await
   introduced at the async flip would open a race between them. Inserts still use
   `onConflictDoNothing` / `onConflictDoUpdate`; this exception is for the update-builder gap only.
   (POD-3406, decided 2026-09-05.) The lint bans the constructs in §2.7, not the `sql` tag.
2. **drizzle stays inside persistence.** Imported only from the store, the operations store,
   the migrations and the sync SQLite adapter; repositories return the domain row types in
   `store/types.ts`.

   PLACEMENT DECIDED 2026-09-03 (POD-3248, landed as 5dce237f3). The executor lives in
   `apps/server/src/store/executor/`, NOT in `packages/runtime`. The executor's drizzle field is
   the query layer, and this rule keeps drizzle inside persistence; splitting the scheduler out
   would put half these interfaces outside the directories the 0.10 lint family watches, for no
   second consumer. `packages/runtime` keeps `SqlDatabase`, imported by three files in the driver seam
   (`store/executor/bun-driver.ts`, plus `driver.ts` for the `SqlParam`/`SqlRunResult` vocabulary
   any driver needs including libsql, and `harness.ts` which opens a real database), so the lint
   family has a small named exemption rather than a package boundary to reason about. Corrected
   2026-09-03 from "exactly one file" — POD-3252 checked against the landed code; the count moved,
   the shape did not.

   CONTRACT WIDENED 2026-09-03 (POD-3310, after V1's review) so E.5 inherits an interface built for
   the remote path instead of having to change a settled one. `StoreDriver` gains required `limits:
   DriverLimits` (`writeBudgetMs`, `busyRetry`) and an optional `classify(error)`; `client(route,
   routeBatch)` and `QueryClient.batch()` carry batching; `DriverSession` gains a required
   `executeBatch`; `Lease.begin(lane)` MUST be called instead of `session.begin(lane)` or the busy
   retry does not apply. `SchedulerOptions` gains `sleep`, `StoreExecutorOptions` gains
   `onReportFailure`. New exports: `TransactionPoisonedError`, `StoreDiagnostics`,
   `TransactionUnit`, `BatchRouter`, `BusyRetryPolicy`, `DriverLimits`, `FailureClass`,
   `NO_BUSY_RETRY`, `UNBOUNDED_WRITE_BUDGET_MS`. Two refusals callers can now see:
   `TransactionPoisonedError` (a savepoint boundary failed, so the unit refuses and the top level
   rolls back rather than committing) and `StaleTransactionError` from a post-commit continuation
   that outlived its drain.

   AND THE TESTING LESSON, which applies past this issue: V1 found two token-timing mutations that
   survived all 36 harness tests. The gap was not the assertions — it was that bun:sqlite's COMMIT
   is SYNCHRONOUS and INFALLIBLE, so no test could place anything between the token closing and the
   commit finishing. The fix was a fake driver that PARKS the commit on a barrier. Any harness that
   only ever drives a synchronous local driver is blind to the entire class of async-boundary
   defect this epic exists to introduce; build the parking fake before trusting a green.

   DO NOT DELETE `SessionStore.tableWrites` AS DEAD CODE (POD-3247, landed 2026-09-03). The
   per-table write announcement has NO production caller, because POD-3246 retired the one writer it
   was built for — the boot machine-identity upgrade, which wrote `repos` on the raw handle. The
   writer went; the SHAPE did not. Every statement the query layer runs through the executor is the
   same shape: a write to a table some repository holds a cached read of, issued by something that
   does not know which caches exist. Its two behavioural tests construct a repository directly and
   raise the announcement with no caller involved, so it is exercised rather than merely present.
   A reviewer meeting an uncalled mechanism should read this paragraph before proposing its removal;
   the conversion waves are what will call it.

   CORRECTED 2026-09-04 BY POD-3362, after POD-3292 checked the claim: THE ANNOUNCEMENT IS A
   COOPERATIVE SEAM, NOT AN INVARIANT, and the paragraph above (and the comments it was written
   from) read as though it were one. "The conversion waves are what will call it" describes an
   intention, not a mechanism — nothing obliged a wave to call it, so a converted writer that
   omitted `tableWrites.wrote(...)` would leave `listRepos()` serving pre-write rows indefinitely,
   silently, and through review. The two claims are separate and only the first was true of the
   code: the seam WORKS WHEN CALLED (replacing the subscribed callback with a no-op fails both
   writer tests in `store/repos-read-cost.test.ts`), and the announcement WAS NOT GUARANTEED (the
   same file asserts, immediately before `wrote('repos')`, that a bypassing write has left the read
   stale).

   WHAT NOW HOLDS IT UP IS A CHECK, and it is deliberately not a construction. The boundary lint
   family gains `cache-table-announcement` (`scripts/check-boundaries.ts`): every file under `apps/`
   and `packages/`, excluding tests, the migrations (which run before any cache holds a read) and
   `store/repos.ts` (held to the OPPOSITE ordering by its own source scan), must follow a write to
   `repos` or `repo_prefixes` — in SQL text or through drizzle's builder — with an announcement
   naming that table. Its correct count on this tree is ZERO, so `scripts/check-boundaries.test.ts`
   drives it against a forgetting writer in each spelling rather than resting on a clean tree. Its
   ceiling is source text and is stated in the rule: a table name assembled at runtime is invisible
   to it. Say "guarded" here, never "cannot be bypassed".

   THE STRONG VERSION IS REFUSED, NOT DEFERRED FOR WANT OF TIME. Putting affected tables on
   `Statement` so the executor announces them was weighed against the shape rule 2 already settled
   and rejected on three grounds. Write intent belongs on that object because its domain is CLOSED
   (two values), it costs the caller NOTHING (the `QueryClient` method chosen is the declaration —
   `run`/`writeGet`/`writeAll` versus `get`/`all`), and a wrong value is LOUD (wrong lane, a busy
   error, a read-only connection). An affected-table list is open-ended, must be hand-authored per
   statement, must be COMPLETE to be worth anything, and an incomplete one fails exactly as
   silently as the omission it was meant to prevent — so it would move one forgettable call to one
   forgettable field at every write in the store, and call the result enforcement. It also has no
   slot under drizzle: the sqlite-proxy callback is fixed at `(sql, params, method)`, so the only
   way to recover tables there is to inspect SQL text, which is the mechanism POD-3247 deleted.
   Deriving tables instead of declaring them is that same inspection. POD-3263 does not need to
   carry this.

   WRITE INTENT IS NOT `method === 'run'` (POD-3316 / POD-3318, 2026-09-03). This is the most
   consequential finding of the three executor reviews, because it is not an executor bug — it is a
   wrong assumption that Stage A would have built on top of.

   `executor.ts:220` selects the lane with `statement.method === 'run' ? 'write' : 'read'`, and
   `batchLane` does the same. But `method` is a RESULT-DECODING instruction, not write intent.
   drizzle's async sqlite-proxy path prepares every `INSERT`, `UPDATE` and `DELETE` that carries a
   `RETURNING` clause with method `all` — verified in
   `node_modules/drizzle-orm/sqlite-core/async/{insert,update,delete}.js:12`, where the argument is
   literally `this.config.returning ? "all" : "run"`. So under the query layer this epic is
   adopting, a `RETURNING` write is classified as a READ.

   The consequences are exactly the ones the scheduler exists to prevent: such writes bypass the
   single write slot, may run concurrently with a real writer, and on a driver with `openReader`
   may be handed a read-only connection. This is not hypothetical syntax — the store already has an
   atomic `INSERT ... RETURNING` claim in `store/notification-facts.ts:38`.

   THE RULE: the driver contract must carry EXPLICIT write intent from the caller, and read
   capability must be a separate declaration from result shape. No conversion may rely on `method`
   to mean anything about whether a statement writes. Until POD-3318 lands, treat any `RETURNING`
   write as a site that needs the coordinator, not a judgement call.

   THE INTERFACE SHAPE THAT MATTERS DOWNSTREAM: the query client is built from a ROUTER, one
   async callback per statement. That is the only shape both drizzle drivers accept — sqlite-proxy
   takes exactly sql/params/method — and it is what makes ambient routing possible at all. E.5's
   libsql driver implements the same router. `openReader` is an optional CAPABILITY: a
   committed-view read from inside an open body needs a second connection, so a driver without one
   refuses `outsideTransaction` rather than deadlocking.

   THE WAITING RULE, which every caller depends on: `transact`'s promise resolves after COMMIT,
   after every commit application, and after every durable follow-up including those a follow-up
   itself registers. It does NOT wait for external effects. A failure in a commit application or a
   follow-up rejects with `committed: true`, so a caller can never read the rejection as a
   rollback.
3. **The schema file is the type source of truth, and brands survive** through `$type`; the
   `Record<string, unknown>` reads, the hand-typed selects and the re-entry casts go.
4. **`mode: 'json'` is not a drop-in for the quarantine.** drizzle's JSON column throws on a
   corrupt value; `helpers.ts` and shipping's readers quarantine, and the corrupt-blob oracle
   records which columns must keep doing so. Decided per column, before the conversion. The
   oracle's findings (issue 0.3, 2026-09-03, 26 cases: all 23 `mode: 'json'` columns plus the
   three superagent text columns read through the parsers) settle the decisions: five columns
   throw today and the throw is intended (`ship_steps.input_fence`,
   `ship_train_manifests.provider_ref` and `.validation_profile`,
   `ship_train_members.delivery_depends_on`, `ship_orders.validation_profile`), so
   `mode: 'json'` is acceptable for them; every other column keeps its quarantine or its
   passthrough exactly as pinned, including `ship_orders.descendant_manifest` and
   `.current_integration_receipt`, whose behaviour depends on the row (plain orders quarantine,
   stacked orders throw through the binding refinement) and is pinned per case; the three
   columns that pass a wrong-shape value straight through (`settings_audit_events.detail_json`
   and `.redacted_paths`, `podium_events.payload`) keep passing it through, because tightening
   them is a behaviour change; `workflow_events.payload_json` has no store reader by design
   (`listRunEvents` projects only the attribution pair) and the conversion must not add one,
   since that would be a redaction decision. `ship_holds.actions` throws by accident (the
   quarantine yields `[]` and the hold parser then refuses an empty list, so one corrupt hold
   makes every hold unreadable); the conversion preserves that behaviour, and the fix is filed
   as a separate bug outside this epic.
5. **Trust the database's types; enforce invariants in the database** with CHECK constraints;
   keep validating external boundaries and JSON blobs.
6. **Mapping with semantics stays.** A mapper line that only existed because the driver returned
   `unknown` goes; a mapper line that is a decision (`requireUserId` failing closed, the
   `LockSessionKey` union, the legacy machine-id refusal) stays with its comment.
7. **Transaction semantics are preserved exactly, including the immediate mode.** drizzle's
   bun-sqlite transaction defaults to deferred and its libsql transaction relies on a deprecated
   default; neither is used. The scheduler issues `BEGIN IMMEDIATE` on bun:sqlite and
   `client.transaction("write")` on libsql. Boundaries, ordering and `ON CONFLICT` targets are
   reviewed per statement.

   MEASURED ON TURSO (POD-3251, 2026-09-03). The write-transaction budget is about **9 seconds**,
   not the 5 this spec assumed: alive at an 8 s gap, dead at 10. Four constraints follow, and they
   bind the flip and E.5, not just the Turso backend:
   - **No slow await inside a transaction body.** THE BUDGET BOUNDS THE GAP BETWEEN STATEMENTS, NOT
     THE TRANSACTION'S TOTAL DURATION — corrected 2026-09-03 by POD-3250, which measured it: a
     21.6 s transaction with a statement every 2 s COMMITS, while a 12.2 s one with a single idle
     gap is reaped. My earlier wording, "the budget is wall-clock on the server", was wrong and
     would have made the 250-row append (27.8 s of continuous statements) look impossible.
     CONSEQUENCE FOR B2.2: a watchdog derived from `writeBudgetMs` must measure time SINCE THE LAST
     STATEMENT, not elapsed time since BEGIN. A duration-based watchdog would kill healthy long
     appends and miss the idle ones that actually die.

   - **There is no fast busy error.** POD-3250 drove it: a second writer against a held write
     transaction BLOCKS (5.0 s local, 10.6 s hosted) and then WINS, and the holder loses everything.
     `driver.ts`'s header says a concurrent writer gets a busy error; it does not. Any retry policy
     must be written against blocking, not against a fast refusal.

   - **A raw batch inside an open transaction is NOT atomic.** Driving `tx.batch` with a failing
     second statement leaves the first APPLIED, on both the local and hosted engines. So the
     savepoint POD-3313 wraps around a batch is load-bearing rather than a precaution, and it costs
     two round trips per batch — priced in POD-3250's document.

   - **drizzle's builder emits PHYSICAL column names, and only drizzle's own execution path maps
     them back.** A router-based driver that returns rows keyed by physical name hands the caller
     objects whose fields do not match the schema's TypeScript names. Found by being bitten by it;
     it bears directly on E.5's driver and on every converted repository that reads a returned row.
   - **`BEGIN IMMEDIATE` is available ONLY through `client.transaction("write")`.** A raw `BEGIN`
     executes successfully and is then silently useless, because each `execute()` is its own
     stream. A silent no-op is the worst failure mode available here, so the executor's libsql
     driver must never issue a bare BEGIN and the boundary lint should be able to say so.
   - **`busy_timeout` cannot be raised** — it is a hard SQL parse error, as are
     `journal_mode` and `wal_checkpoint`. A concurrent writer does not get a fast busy error: it
     blocks the FULL window and then wins. Measured at 10.2 s.
   - **A network blip closes the transaction permanently** (`TRANSACTION_CLOSED`, work lost),
     although the client itself recovers with no manual reconnect. Retry belongs above the
     transaction, not inside it.
   Savepoints work, so re-entrant transact is unaffected.

   MIGRATIONS ARE A BOOT-TIMEOUT FACT. The 97-migration chain applies clean to a fresh remote
   database — 587 statements, 685 round trips, 0 failures — but takes **136 s** against 1.5 s on a
   local twin built the same way, with one single migration taking 19 s. Any boot timeout, health
   check or CI provisioning step that assumes migrations are fast is wrong on Turso.
8. **Observability moves with the queries**, at the execution seam, not the logger; stack
   capture stays gated behind `PODIUM_LOOP_PROFILE`.
9. **Builder only; no relational API, no generic base repository.** Aggregate assembly keeps
   its multi-query shape, batched with `IN` lists where a loop is an obvious N+1.

   READ THE GEOGRAPHY BEFORE THE NUMBERS. The measurements below were taken from a box in GERMANY
   against Turso databases in AWS us-east-1. That distance is deliberate and correct: the databases
   sit next to CI and next to where the server will run (Fly IAD), not next to the developer. So
   the ~95 ms round trip is a measuring artefact of where the measurement was taken, and the honest
   same-metro figure is roughly 3-5 ms per statement, which makes an unbatched issue frame about
   1.5 s rather than 37 s. Do not quote the German numbers as production latency.

   WHAT SURVIVES THE CORRECTION, and it is the whole point: ROUND TRIPS PER REQUEST is a property
   of the CODE, not of geography. 371 of them is 371 wherever the server stands. At same-metro
   latency an unbatched issue frame is still ~1.5 s against 5 ms for the IN-list rewrite — a 300x
   difference that no amount of co-location fixes. Geography changes the constant; batching changes
   the exponent.

   PRICED 2026-09-03 (POD-3251), and the price changes what this rule is. Replayed against an
   imported production dataset on a real Turso database: the issue frame's 371 statements run
   sequentially cost **37.6 s**; the same 371 as one batch cost **0.22 s**; the same fan-out
   rewritten as the four `IN`-list queries this rule asks for cost **114 ms — one round trip**.
   Feed bootstrap: 44 sequential 4.63 s, one batch 0.40 s. Batch size is not a constraint (20,000
   statements in one batch took 2.75 s). The coordinator reproduced the headline independently:
   37.05 s sequential against 0.877 s batched on a warm connection, a 42x difference.

   SO B0.2 AND B0.6 ARE PRECONDITIONS FOR THE TURSO BACKEND, NOT OPTIMISATIONS. A rule that reads
   as hygiene on SQLite is the difference between 114 ms and 37 s on Turso.

   AND THE RISK BESIDE IT (POD-3251, quantified). Rule 6.9's mechanism is not 13 s of CPU on
   Turso, it is **8.5 minutes**: the first await in the issue read fan-out drops the
   microtask-keyed frame cache, 371 becomes 5,163 statements, and unbatched that is 512 s.
   `scripts/measure-hot-paths.ts` gates exactly this, and it must stay in the flip's gate.

   MEASURED 2026-09-03 (POD-3243). The N+1s this rule exists for are located, and they are the
   whole of the issue-frame cost. Of 371 queries per issue-frame read over 80 issue rows: 160
   `issue_deps` by `from_id` plus 80 by `to_id`, 80 `issue_labels`, 50 `issue_comments` counts —
   one query per row in every case — and one grouped comment count that is already batched and
   shows the shape the rest should take. The `issues` table itself is read ZERO times in that
   window: the POD-1931 frame cache works. Feed bootstrap's 44 is 27 single-row `machines`
   lookups plus 9 `grants` reads. On Turso each of these is a round trip.

   THE MECHANISM THAT CAN LOSE THIS: the frame cache is invalidated by `queueMicrotask`, so the
   FIRST AWAIT anywhere in that read fan-out drops it and the `issues` reads come back. This is
   the specific way the flip can move 371 upward, and it is why the read-scope work (B0.6) and
   the array-callback batching (B0.2) land BEFORE the flip, not after.
10. **Incremental, no schema redesign in the same change.** One package per commit; the schema
    edits this epic needs (column modes, JSON decisions) are made once by the coordinator and
    need no migration; no ordinal columns, no primary-key changes.
11. **No synchronous-local-SQLite assumption in any contract.** Signatures are async and
    repositories are bound to an executor even while the driver is synchronous.
12. **An interval or timer callback that becomes async gets a single-flight guard; a mirror
    update happens before the first `await` after the commit resolves, or inside the
    post-commit tail of the same lease.**
13. **A site no rule covers stops the worker** and becomes a decision issue for the coordinator
    (method §4); the coordinator answers with a rule, never a site edit.

14. **Test the arm the passing test does not walk, and assert the mechanism rather than the
    outcome.** Added 2026-09-03 from POD-3313's audit, and it is the sharpest thing this epic has
    learned about its own testing. Four rounds of review found guards whose removal changed
    nothing a test could see; every one of the gaps was on an arm the happy case never reaches —
    a rollback arm, a teardown after the interesting work is done, a refusal branch — and every one
    was invisible for the same reason: the OUTCOME was still correct (the promise rejected, the
    rows were right) while the MECHANISM was absent. Concretely, for every guard: ask which arm a
    passing test walks, write the test for the other one, and assert the driver call sequence,
    because on both arms the returned value is identical.

    The corollary, also from POD-3313: **a fake that self-heals hides the thing under test.**
    bun:sqlite refuses a statement on a closed session by itself, so a token test running over it
    passes whether or not the token does any work — the engine refuses on the executor's behalf.
    Both of that issue's new tests run on a driver whose sessions do NOT self-invalidate and assert
    the statement never REACHED the session. Any test of a guard whose real backend enforces the
    same property anyway must do this, or it proves nothing.

16. **Statement intent is DECLARED at the client, never inferred, and the default is `write`.**
    Decided 2026-09-03 answering POD-3323, which POD-3321 correctly refused to decide for itself.

    THE MECHANISM: the executor hands a repository a client that carries its intent, and the
    sqlite-proxy adapter closes over that intent rather than deriving one. drizzle's callback
    receives only `(sql, params, method)`, so the adapter has nothing to derive from — which is the
    point. A repository that wants the read lane binds a reading client explicitly.

    THE DEFAULT IS `write`, INCLUDING FOR ANYTHING UNMARKED. The two errors are not symmetric, and
    that asymmetry is the whole argument. A write mistaken for a read escapes the single write slot,
    can run beside a real writer, and on a driver with `openReader` can be handed a read-only
    connection — silent, and exactly the defect POD-3318 just fixed. A read mistaken for a write
    takes the write slot: slower, visible in the hot-path measurements, and harmless to
    correctness. So the unsafe direction must be the one somebody has to type.

    THIS COSTS NOTHING TODAY. On bun:sqlite `readConcurrency` is 0, so reads take the write slot
    anyway — a `write` default is the current behaviour exactly. Read concurrency only pays on the
    remote driver, so the opt-in can be made per repository during its conversion wave, by someone
    reasoning about that repository, against the measurement script, instead of guessed for all 38
    up front.

    SQL TEXT PARSING IS BANNED. Deriving intent from the leading keyword was candidate 1 in
    POD-3323 and it is refused: it is the same move that produced the defect — reading semantics
    out of a field that was not defined to carry them — relocated one layer down, where CTEs,
    `PRAGMA`, `EXPLAIN` and `sql.raw` make it wrong in ways nothing would catch. Cheap and total is
    not the test; failing safe is.

    Candidate 2 (ambient intent through the ALS) was not chosen: it makes intent invisible at the
    call site, and its unmarked case is precisely the silent-write hazard above.

17. **B-prep may use a TRANSITIONAL post-commit bridge, and the coordinator owns its store.ts
    edit.** Decided 2026-09-03 answering POD-3260, which was right to stop before moving any site.

    THE PROBLEM: `postCommit()` throws without an executor transaction scope, and NOTHING outside
    `apps/server/src/store/executor/` imports the executor — verified, zero importers. Production
    spans are `SessionStore.transact` (`apps/server/src/store.ts:507`) delegating to
    `@podium/runtime`'s `transaction`. So a span body cannot call the mechanisms' API today, and
    B0.5 could otherwise only produce a ledger while every side effect stayed where it is.

    THE BRIDGE: `SessionStore.transact` opens a transaction scope carrying a `PostCommitRegistry`
    and, after the OUTERMOST commit, drains it SYNCHRONOUSLY, refusing any step that returns a
    thenable. Savepoint-depth spans merge into the parent registry via the existing
    `PostCommitRegistry.mergeInto`. Nothing inside a span is async today, so this preserves current
    ordering exactly — a durable follow-up stays durable by the time `transact` returns, which
    callers like `LockService.steal` rely on. At the flip the bridge is deleted and the executor's
    real runner takes over with the call sites unchanged.

    IT MUST CARRY THE COMMITTED GUARANTEE. A follow-up that throws runs after the transaction has
    committed, so it must not surface as a rollback — the same property POD-3310 gave mechanism 1.
    The bridge rejects with `committed: true` semantics, or the flip inherits a worse contract than
    the one it replaces.

    It is an INSTRUMENT: it lands with its deletion issue filed, per the method's §7.

    WHO WRITES WHAT: the worker writes the bridge as its own module under `store/executor`; the
    COORDINATOR applies the `store.ts` edit. Not ceremony — POD-3254 owns `store.ts:227-262` (the 34
    constructor lines) in the same window, and one hand on that file is how the two stay orderable.

18. **Batching may not change WHEN an authorization input is read. Split the site.** Decided
    2026-09-03 answering POD-3325, which was right that this is a rule and not a local judgement.

    TAKE THE HALF THAT HAS NO SEMANTIC QUESTION, NOW: `authorize` at `relay.ts:1153` calls
    `store.users.get(ownerUserId)` with the SAME id on every iteration. That is an unambiguous
    defect with no liveness dimension — hoist it. Verified: the id does not vary in the loop.

    LEAVE THE GRANT READ PER DECISION until the question below is answered. `ownershipFromMachines`
    reads grants once per machine because ADR 9 D2 rule 4 evaluates a grant LIVE, so a revoked share
    stops the next apply with no invalidation step. Batching it makes an authorization pass
    snapshot-consistent instead, and TODAY those are indistinguishable — the loop is synchronous, so
    nothing can commit between two iterations. AFTER THE FLIP they diverge: the pass acquires awaits
    and a revocation committed mid-pass is honoured by the live form and missed by the snapshot one.
    So the safe-today answer and the safe-after-the-flip answer differ, which is exactly why this is
    not a hoist.

    THE GENERAL RULE, which applies past these two sites: a batched read is a mechanical improvement
    only when the values it batches cannot change during the batch's window. Where they can, and
    where the answer is an authorization decision, the batch changes the semantics and needs the
    rule that governs those semantics amended first — never a conversion commit deciding it in
    passing. `modules/messages/mailbox.ts:446` is the same shape on the write side and inherits this.

    THE OPEN QUESTION, escalated because ADR 9 D2 rule 4 is a decision on record and amending it is
    the human's: is the LIVE obligation per DECISION or per PASS? Per-pass is arguably the more
    defensible semantics — every machine in one answer judged against one state, rather than an
    answer stitched from two states that never coexisted — and it is what makes the batch legal. It
    must be settled before B1, because that is when the two forms stop being equivalent. It is on
    the R3 pre-flip checkpoint. B0.6 must state what consistency its read scope provides, since a
    read scope is the natural home for "what state does this pass see" — but B0.6 inheriting the
    question is not an answer to it.

19. **A diagnostic log inside a span STAYS. Anything a caller can observe does not.** Decided
    2026-09-03 answering POD-3260, which kept one and asked for the rule rather than leaving its
    judgement in a ledger.

    THE LINE: a call inside a transaction body is a side effect this epic must move only if
    something outside the process can OBSERVE it or DEPEND on it. A `log.warn` recording that a
    corrupt column was quarantined has no observer inside the system: no subscriber, no ordering
    guarantee, no caller branching on it. Moving it post-commit would make it arrive AFTER the
    rollback it is describing, or not at all — strictly worse diagnostics for a strictly notional
    purity win. The store's quarantine warnings (`store/helpers.ts`, `store/issues.ts`) stay where
    they are.

    WHAT DOES NOT QUALIFY, and the distinction is observability rather than kind: an event
    published to subscribers, a mail nudge, a cache mirror another reader consults, a metric a test
    asserts on, anything whose absence changes what a caller sees. Those move to the post-commit
    mechanisms even when they look like "just a notification" — POD-3260 found all seven lock spans
    sending mail nudges inside their transaction, and mail is durable and observed.

    THE TEST TO APPLY at a site: if the transaction rolled back, would anything outside this process
    be wrong for having seen this? A log line: no. Everything else: probably yes, and it moves.

20. **The sync adapter gets a NARROW PORT, not an exception and not a relocated executor.** Decided
    2026-09-03 answering POD-3334.

    `SyncRepository` is the one of the 34 constructor lines still taking the raw connection, because
    it lives in `packages/sync` and the executor lives in `apps/server` — a package may not import
    an app, and rule 2 deliberately keeps the executor inside persistence rather than in
    `packages/runtime`.

    THE ANSWER IS CANDIDATE 3, and it is not "a second vocabulary for the same object": a package
    declaring the narrow interface it requires, satisfied structurally by the app, IS dependency
    inversion, and it is the pattern this epic ALREADY set — POD-3249 injected that same
    repository's two server-owned tables through exactly such a port, for exactly this reason. The
    precedent is one file away.

    Candidate 2 is refused: relocating the executor reverses POD-3248's placement decision and puts
    half the interfaces outside the boundary lint's watched directories, which is what that decision
    existed to prevent. Candidate 1 — a permanent stated exception — is refused as an END STATE
    because its cost is two corrupted gates: `STAGE_A_UNCONVERTED` could never empty, and POD-3267
    would have a legacy reader it cannot delete. A gate that cannot pass stops being read; that
    lesson is already in the method.

    CORRECTED 2026-09-03 BY POD-3338, which checked the claim instead of executing it. THE PORT
    DOES NOT EMPTY THE LEDGER, and my original wording said it would. A port changes what
    `SyncRepository` is HANDED; it does not change what it DOES — the file still calls `.prepare()`
    on 22 lines and still imports `@podium/runtime/sqlite` (both verified), so rule 13's raw-handle
    clauses still fail it, and deleting its ledger line would make the LINT fire, not the
    listed-but-clean guard.

    WHAT EMPTIES THE LEDGER IS THE DRIZZLE CONVERSION, which is Phase A wave work (POD-3255) and
    cannot happen yet: the executor's client is still the prototype QueryClient and is fully async,
    so there is nothing a synchronous Stage A repository could be converted onto today. The
    tracker's own edges already say so — POD-3255 waits on the port, not the other way round.

    SO THE PORT'S JUSTIFICATION IS NARROWER THAN I FIRST WROTE, and it still stands: it removes the
    raw `SqlDatabase` from the CONSTRUCTOR, which is what dependency direction requires and what
    [0.12] is about, and it removes a reader of the executor's legacy field so POD-3267 can delete
    it. It does not, and was never able to, make the Stage A ledger empty. Both
    `sync-repository.ts` and `test-support.ts` stay on the ledger until their conversion wave.

    A port shape that emptied the ledger without converting would be worse than useless: renaming
    `prepare` to something the regex misses would pass the lint while the file still built SQL
    strings by hand — the exact false progress the ledger exists to prevent.

    SEQUENCE: the port lands AFTER [0.12] (POD-3254), which creates the executor field it needs.

21. **Applying a recorded decision MAY replace the assertion it falsifies, under three conditions.**
    Decided 2026-09-03 answering POD-3335, which reported rather than asked and was right to.

    The bar on modifying an existing test assertion exists to stop someone weakening an oracle to
    fit their implementation. That purpose is not engaged when a decision was recorded FIRST and
    applying it falsifies an assertion BY CONSTRUCTION — there, refusing the change means the
    decision can never be applied. The conditions: the replacement must pin the DECISION itself, it
    must be mutation-checked with the mutation named, and the owning issue must be told even when
    closed, so the record lands where the next reader looks.

    [0.12]'s change qualifies and stands. The coordinator verified it independently: demoting
    `ship_steps.input_fence` from `mode: 'json'` reddens "keeps mode: 'json' only where the throw is
    intended" by name, and the replacement catches a case the original could not — the original
    compared two sets both derived from column type, so a quiet demotion was invisible to it.

    THE GENERAL SHAPE, which is the valuable part and applies past this site: a Phase 0 artefact
    that pins TODAY'S behaviour and a later issue that APPLIES a decision are two sides of one
    assertion. The coverage census (0.2), the hot-path baseline (0.1) and the flip's measurement
    gate are all in this position. WRITE THE ORACLE AGAINST THE CLASSIFICATION, NOT THE MECHANISM:
    pin what each column's behaviour IS, not which drizzle mode implements it, and the decision
    stops being able to falsify it.

22. **The transaction-port lint exempts DRIVER FILES BY NAME, never a directory and never a
    marker.** Decided 2026-09-03 answering POD-3342, which spotted that the rule flags the one site
    that must make the call.

    The rule keeps transactions on the store's port. A driver IS that port's implementation, so
    `client.transaction("write")` inside a `DriverSession.begin` is the rule being obeyed, not
    broken. `bun-driver.ts` escapes today only by accident — bun:sqlite's `BEGIN IMMEDIATE` is a raw
    statement rather than a `client.transaction()` call — and E.5's real libsql driver trips it on
    day one.

    THE EXEMPTION IS A NAMED FILE LIST, following the precedent rule 2 already sets for the
    `SqlDatabase` driver seam (three files, named). Not candidate (a)'s directory: `store/executor/`
    also holds the scheduler and the executor itself, and none of those may open a raw transaction —
    a directory exemption would stop the rule watching the files it most needs to watch. Not
    candidate (c)'s `DECISION` markers: Stage A's exit gate requires zero markers, so E.5 would need
    a permanent one, which turns a completeness gate into a standing exception.

    Candidate (b), exempting by symbol, is the theoretically right answer and is refused on
    checkability: it needs the callee's declaring TYPE, and this epic has already learned (execution
    method, POD-3257) that a name-matching scan cannot carry that weight. A named file list is
    honest about being a list.

    A SPIKE GETS NO BLANKET EXEMPTION. `store/spike/turso-append/` is an instrument: nothing imports
    it and the composition root does not know it exists. Its driver file is named in the list like
    any other; its measurement harness drives raw transactions deliberately and is exempted the same
    way. It lands with a deletion issue, per the method's §7.

23. **`@libsql/client` is a devDependency of `@podium/server`.** Decided 2026-09-03 on POD-3250's
    explicit recommendation. Version 0.18.0. It is what makes the Turso proof's 17 integration
    assertions runnable rather than a document; the coordinator ran them against the hosted database
    before accepting. It is NOT a runtime dependency — E.5 adding one is a separate decision.

    CARRY FORWARD: the install tree pulls `libsql@0.5.29` with two `.node` binaries. That costs
    install size and CI time and does NOT reach the bundle, because the slice imports
    `@libsql/client/web`. E.5's driver inherits the fact and the constraint.

24. **Quote ROUND-TRIP COUNTS first and latency second.** Corrected 2026-09-03 by POD-3250, against
    the coordinator's own instruction to prefer same-metro milliseconds.

    Counts are the durable finding: they are a property of the code and do not improve with
    distance. 254 round trips for a literal 250-row append is 254 in IAD as much as in Germany —
    about 0.8-1.3 s at same-metro 3-5 ms, better than the 27.5 s measured here and still the wrong
    shape for a hot path. Latency is the multiplier and moves with deployment; the count is the
    defect. Every conclusion in this epic about whether work is a precondition or an optimisation
    rests on the count, and survives the move to production.

25. **Do not put backticks in a `podium mail --body` or `session send --text`.** A backticked
    identifier is shell command substitution and vanishes silently, taking part of the message with
    it. Quote the body from a heredoc file, or write without backticks. Costs a round trip every
    time; it has already cost two.

## 7. Decisions on record

1. Postgres was the original direction; this epic was its preparation. On 2026-09-03 the
   direction became SQLite everywhere with hosted Turso (decision 5 above). The Postgres
   analysis, the Kysely alternative and the PGlite evaluation are preserved in the history
   document.
2. The size-one transaction queue in front of bun:sqlite is the mechanism for async
   transactions on SQLite; no driver switch. On Turso, the platform's single writer per database
   plus a bounded busy retry is the multi-writer answer.
3. Podium keeps running exactly as today on SQLite; the hosted server runs on Turso end to end.
4. Tenant topology is postponed; the feed head is keyed by feed and the executor carries a
   context slot.
5. SQLite dialect everywhere, bun:sqlite locally, hosted Turso remotely through the pure
   JavaScript libsql client; drizzle with two drivers.

ADR amendments this epic lands: ADR 2 D10 and D12.6 (the scheduler's write lane and the
post-commit tail as the single-writer and publication mechanism; the Turso multi-writer answer),
ADR 6 D5.3 (drizzle is the query layer), ADR 9 D2 rule 4 (live means read under the lease that
applies or publishes).

### Rule 26 — a draft may not outlive a suspension it will be persisted after

[POD-3375 / POD-3373, ruled 2026-09-04.] Two workers disagreed and the broader rule wins.

POD-3373 established that a draft is stranded when the awaited callee cuts its OWN draft and commits
it: the caller's draft is then stale AND missing the fields the callee established, so persisting it
silently writes them back to their previous values. That is the worst case.

POD-3375 showed it is not the whole case. Its counter-example needs no such callee: a draft pinned at
revision 5, a suspension, a THIRD party committing revision 6, and the caller's persist refused. The
re-pin `installDraft` performs (core.ts:307) records `row.revision` as of that write, so it answers
"did my last write land", not "is this row still the one I read". Nothing serialises issue writes and
the suspensions here are cross-machine round trips with a 35-second timeout.

SO THE RULE IS: a draft may not outlive a suspension after which it is persisted. Cut it after the
await, or hoist the VALUES the suspended work needs and cut the draft at the write — POD-3375 used
hoisting at five of its seven sites, because the git operations needed values rather than a row.

The shape distinction survives as a description of CONSEQUENCE rather than of licence: a callee that
cuts its own draft loses fields SILENTLY; a third-party commit THROWS. Both are defects and only one
is loud, which is the wrong reason to treat the quiet one as the only one.

Corollary, from POD-3373: a draft living across a public sub-operation is the long-lived mutable
object this model exists to remove. That argument never depended on who writes in the gap.

### Rule 27 — Stage A converts onto `drizzle-orm/bun-sqlite`, not onto the executor's client

[POD-3393, ruled 2026-09-04. My Stage A briefs said "the executor's client" and were wrong.]

Every `QueryClient` member returns a Promise (`store/executor/driver.ts:246-267`), so a SYNCHRONOUS
Stage A repository has nothing there to call. Rule 20's own correction already said this — "there is
nothing a synchronous Stage A repository could be converted onto today" — and I wrote briefs against
it anyway. POD-3393 found the contradiction before writing a line of conversion.

THE DECISION WAS ALREADY ON RECORD in section 3.7, from POD-3242: drizzle stays the query layer with
TWO drivers, `drizzle-orm/bun-sqlite` and `drizzle-orm/libsql`. The bun-sqlite driver is SYNCHRONOUS
and the migrator already uses it.

So Stage A builds a drizzle instance over the store's existing handle and writes ordinary drizzle —
`db.select().from(t).where(...).get()`, `db.insert(t).values(r).run()` — synchronously. The
executor's async `QueryClient` is the POST-FLIP path and Stage A does not touch it.

THIS IS ALSO WHY THE ROW-MAPPING QUESTION DOES NOT ARISE. A builder → `toSQL()` → raw-client route
returns rows keyed by PHYSICAL column names, so repositories would lose rule 3's TypeScript names and
the `$type` brands and every wave would hand-map. Drizzle's own execution path does that mapping, so
there are no mappers to write and none for B1 to unpick.

B1 then swaps the drizzle instance to the async driver and adds `await` at the call sites; the query
BODIES do not change. That is exactly the edit POD-3262's await pass performs, which is what makes the
existing suite the flip's oracle.

Intent is still declared, through drizzle's terminal methods: `.get()`/`.all()` on a select are reads;
`.run()`/`.returning()` on insert/update/delete are writes. POD-3391's lint derives intent from the
SQL and checks the call site either way.

### Rule 27a — the executor OWNS the synchronous drizzle instance; a repository never holds a handle

[Corrects rule 27 within the hour, on objections from waves 1, 3, 5 and 7. 2026-09-04.]

Rule 27 said Stage A converts onto `drizzle-orm/bun-sqlite`. Right driver, wrong owner. As written it
implied a REPOSITORY builds the instance over the store's handle — and a repository that holds a
handle has not converted: rule 13 bans the runtime-sqlite import, and `STAGE_A_UNCONVERTED`'s own
definition is that a file is unconverted until it holds no raw handle at all. So a wave converting
that way could delete no ledger line, and Stage A's exit gate is that array being empty. Wave 1 put it
exactly: it would empty the ledger without moving anything, which is the failure rule 20 already names.

**AMENDED AT R2 (coordinator decision, 2026-09-05).** "That array being empty" is unreachable while
Stage A owns it, and the V3 review (finding H1) was right to say so. `STAGE_A_UNCONVERTED`'s last two
entries are `legacy-handle-probe.ts` and the executor's `legacy` field, and POD-3326 MEASURED that
converted repositories still execute on the raw handle through `clientOverWrapper` until B1 rebinds
`syncQueries` onto the driver. Deleting either before the flip would take the probe's four named
consumers to zero and leave three query-count tests asserting `toBeGreaterThan(0)` red, so the gate as
written asked for a change that Stage A cannot safely make.

STAGE A'S EXIT GATE IS THEREFORE: zero `DECISION` markers in production, and `STAGE_A_UNCONVERTED`
containing NOTHING BUT entries that also appear in `FLIP_UNDELETED`. Both hold at the tip — markers
are zero, and both remaining entries are listed in B1's deletion ledger. The obligation is not waived:
it MOVES to B1, where `FLIP_UNDELETED` already fails if an entry's construct is gone early, and B1's
exit gate is both ledgers empty. Nothing is deferred out of the epic; one phase boundary moved.

I did not escalate this. It is an ordering defect in a plan I wrote, the fix is reversible, and
holding the epic for a week of ticks to ask about it was the wrong call.

SO THE EXECUTOR BUILDS IT ONCE AND EXPOSES IT. The executor already holds the handle; it constructs
`drizzle({ client })` — the same call the migrator makes at `migrations/index.ts:277`, with
`bunSqliteClient` — and exposes it as a synchronous drizzle database. A repository imports
`drizzle-orm` and the schema, nothing else. It never sees `SqlDatabase`, never calls `.prepare(`, and
its ledger line comes off legitimately.

What each party gets: repositories write real drizzle and receive rule 3's TypeScript names and the
`$type` brands through drizzle's own execution path, so no wave hand-maps physical column names. The
boundary lint stays satisfied by construction rather than by exemption. And B1 rebinds that one field
from the synchronous driver to the asynchronous one and the await pass adds the awaits; the query
BODIES do not change, which is what makes the existing suite the flip's oracle.

INTENT under this shape is declared by drizzle's terminal method — `.get()`/`.all()` on a select read;
`.run()`/`.returning()` on insert/update/delete write. That is a DECLARATION at the call site, not
inference from SQL text, so rule 16 holds. POD-3391's lint derives intent from the emitted SQL and
fails where the two disagree.

Building this instance is an executor edit and therefore the coordinator's, not a wave's.

### Rule 27b — the seam is INJECTED, never referenced inside a repository

[2026-09-04, prompted by the operator asking whether the seam made the flip harder. It did.]

Rule 27a put the synchronous drizzle instance on `executor.stageA`. A repository that reads
`this.stage.db.select()...` forces B1 to rewrite that receiver to `this.db` in all 39 files AND add
the awaits — TWO mechanical passes over every file, where the whole justification for splitting Stage
A from B1 is that the second pass is a single codemod.

So a repository takes the drizzle instance in its CONSTRUCTOR, in the slot the `SqlDatabase` used to
occupy, and calls `this.db`. `executor.stageA` then appears in exactly one place in the tree —
`store.ts`, where repositories are constructed — and B1 changes that one line to pass the async
instance.

The difference inside a converted file across the flip is then exactly `async`, `await` and the return
type. That is what makes the existing suite the flip's oracle, and it is what I claimed while the
`stageA` path quietly made it false.

The undefined-check moves with the construction: `store.ts` asserts the seam once, so no repository
carries a branch for a case its own constructor cannot produce.

### Rule 28 — drizzle returns the schema's TYPES, and the wrong answer is the common answer

[POD-3397, 2026-09-04. Cross-wave, silent, and green under an ordinary fixture.]

A conversion changes what a read RETURNS, not only how it is issued. Drizzle's execution path applies
the schema's declared modes, so a column declared `integer({ mode: 'boolean' })` comes back `true` or
`false` — not `0` or `1`. There are SIXTEEN such columns, including `issues.archived`,
`issues.needs_human`, `issues.draft`, `sessions.headless`, and `subscriptions.deliver_nudge`,
`deliver_notify` and `enabled`.

Today's mappers read the raw integer: `r.archived === 1`, `Number(r.enabled) !== 0`. After conversion
those comparisons are against a boolean, and `true === 1` is `false`. So every issue reads as not
archived, not a draft and not needing a human; every subscription reads as disabled. No error, no type
error — the comparison still typechecks where the row is `unknown`.

WHAT MAKES IT DANGEROUS IS THAT THE WRONG ANSWER IS THE COMMON ANSWER. Most issues are not archived
and not drafts, so a fixture that seeds an ordinary row and reads it back is green either way. This is
the "a fixture must produce the thing" failure in its purest form: the test cannot distinguish the two
worlds because it never exercises the value that differs.

RULE, TWO PARTS. A converted mapper reads the DECLARED type — use the boolean, never compare it to a
number, and never wrap it in `Number()`. And every `mode: 'boolean'` column a wave touches must have a
golden test covering the NON-DEFAULT value, because the default value proves nothing. State in the
handoff which boolean columns your files read and that each has a true-case test.

The same reasoning covers any mode the schema declares. Read the column's declaration before writing
its mapper; do not infer the runtime type from what the old raw-handle code compared against.

### Rule 29 — a wave owns its OWN construction lines in `store.ts`, and nothing else in that file

[POD-3395 asked; ratified 2026-09-04 because it was already the practice on four branches.]

Rule 27b requires a converted repository to take the query capability in the constructor slot its
`SqlDatabase` occupied. That is not achievable without changing the matching line in `store.ts`, so
"nobody but the coordinator touches `store.ts` during Stage A" and rule 27b contradicted each other
for every wave. Waves 1, 3, 6 and 7 each resolved it the same way independently, and their four sets
of lines are disjoint.

THE EXEMPTION IS NARROW. In `apps/server/src/store.ts` a wave may change ONLY the constructor
argument on the lines constructing ITS OWN repositories — `this.executor` becomes `this.queries`,
argument positions and every other argument unchanged. Not an import, not a field, not a
neighbouring line, not a formatting pass. Any other edit in that file is a finding to mail, not a
task to do.

WHY IT DOES NOT REINTRODUCE THE COLLISION the ownership rule exists to prevent: the lines are
disjoint per wave, and the coordinator lands branches one at a time behind the merge lock, so two
waves never write the file concurrently. A wave states the exact lines it changed in its handoff and
the coordinator checks them against the ledger when landing.

### Rule 30 — the ambient transaction is bun:sqlite's gift, not drizzle's, and it does not survive Turso

[Coordinator, 2026-09-04. Corrects a claim the coordinator made twice; established by probe, not by
reading.]

Do not justify Podium's own transaction mechanism with "drizzle only supports lexical transactions".
That is false on the driver we run today, and believing it will produce the wrong design for Stage B.

MEASURED, on `drizzle-orm/bun-sqlite` — `db.transaction()` nested inside `db.transaction()`:

    db.transaction inside db.transaction: OK      rows: [ outer, inner ]

It works, because drizzle's bun `transaction()` delegates to `this.client.transaction(...)`, which is
bun:sqlite's better-sqlite3-compatible wrapper; that wrapper tracks depth ON THE CONNECTION and emits
savepoints. The nesting is ambient, and it is bun:sqlite doing it.

MEASURED, the same code on `drizzle-orm/libsql` — the Stage E target:

    db.transaction inside db.transaction: THREW -> Failed query: insert into t ...   rows: []
    tx.transaction inside db.transaction: OK                                          rows: [ outer, inner ]

Not even the OUTER row survived. libsql's `transaction()` opens a brand new transaction from the
client every time (`const libsqlTx = await this.client.transaction()`) and binds a NEW session to it;
it never asks whether one is already open, and a statement issued on the root `db` while a
transaction is open goes to the client rather than the transaction.

THE CONSEQUENCE FOR STAGE B, and it is the whole argument for ambient routing. Post-flip, a
repository reached from inside a write span that resolves its query object to the ROOT instance does
not merely bypass the span — on libsql it FAILS, and it can fail the enclosing statement too. Something
must route it to the enclosing transaction. Threading a `tx` object to 57 write spans is refused (the
services hold narrowed dependency lambdas, not the store); rebinding repositories per transaction is
refused (it splits the frame and grant cache state). AsyncLocalStorage ambient routing is therefore a
CHOSEN design with two rejected alternatives, not a forced one — say it that way.

WHAT PODIUM'S OWN HELPER STILL EARNS, separately from nesting: `BEGIN IMMEDIATE` at depth 0 (drizzle
defaults to `deferred`, which takes a read lock and cannot always upgrade it), and the thenable guard
that refuses an async callback. Its savepoint nesting is redundant on bun:sqlite today.

### Rule 31 — a DECISION marker is for a site you CANNOT answer, not one you have answered

[POD-3394 asked, 2026-09-04. The same shape will reach waves 1, 6 and 7 on their OR IGNORE and
OR REPLACE sites.]

Wave 3 converted an `INSERT OR IGNORE` to `onConflictDoNothing`, proved the two equivalent for that
table, and still marked the line `// DECISION POD-3403` because the earlier ruling said to. That
marker is INERT — nothing flags a legal builder call — and it would have arrived at Stage A's
zero-marker exit gate representing a question that had already been answered with evidence.

THE RULE. A marker means "I could not decide this; a human must, before it ships." If you HAVE
decided it and can show the reasoning, that is a conversion, not a decision: drop the marker and put
the enumeration in the commit message and the handoff. Keep the marker only where the answer is
genuinely open.

THE EQUIVALENCE TEST for `INSERT OR IGNORE` to `onConflictDoNothing`, measured rather than reasoned
(coordinator probe, bun:sqlite, `pragma foreign_keys = 1`):

    INSERT OR IGNORE suppresses:  UNIQUE, PRIMARY KEY, NOT NULL, CHECK
    INSERT OR IGNORE does NOT suppress:  FOREIGN KEY  (it throws, exactly as the plain form does)
    onConflictDoNothing suppresses:  uniqueness conflicts only (UNIQUE / PRIMARY KEY)

So the two are equivalent at a site IF AND ONLY IF no NOT NULL violation and no CHECK violation is
reachable there. Foreign keys do not enter it: neither form suppresses them, so behaviour is
unchanged either way. Establish it on the SHIPPED TABLE with `PRAGMA foreign_key_list`,
`PRAGMA index_list` and the table's SQL — not by reading `schema.ts`, which is the map and not the
territory — and show that every NOT NULL column in the statement is supplied from a non-nullable
source. State that enumeration in your handoff. If any CHECK exists or any NOT NULL column can
receive a null, the forms differ and the marker stays.

REFINEMENT TO RULE 28, from the same wave. `Number(...)` is not itself the hazard; a comparison to a
SPECIFIC NUMBER is. `Number(r.enabled) !== 0` is redundant after conversion but not wrong, because
`Number(true) !== 0` holds. The defect shape is `=== 1`. Delete the redundant conversions when you
see them, but do not report a surviving `Number(x) !== 0` mutation as a defect — classify it.

### Rule 32 — a SQL-TEXT matcher does not survive conversion; widen it, never replace it

[Waves 4, 6 and 7 each hit this separately, 2026-09-04. It is the most common non-obvious breakage in
Stage A and it has three distinct failure modes.]

Drizzle emits lowercase keywords and quoted identifiers. An instrument written against hand-written
SQL is matching a spelling that no longer occurs:

    hand-written   SELECT machine_id, path FROM repos ORDER BY rowid ASC
    drizzle        select "machine_id", "path" from "repos" order by rowid ASC

`sql.includes('FROM repos') && sql.startsWith('SELECT')` matches the first and not the second.

THE THREE FAILURE MODES, all observed:

1. LOUD. The instrument carries a lower bound on its own arming — `expect(writes).toBeGreaterThanOrEqual(10)`
   — and fails with "expected 2 to be greater than or equal to 10". This is the good case and it is
   why those lower bounds exist. Keep writing them.
2. VACUOUS. A cache-hit assertion of the form `expect(reads()).toBe(afterFirst)` passes at `0 === 0`.
   A count that has gone to zero looks exactly like a perfect cache. POD-3397 found two of these
   passing in a file where two others were failing loudly.
3. MISDIAGNOSIS. Two different defects produce one symptom. POD-3395 reported the seam as the cause
   of its zero counts; the seam WAS broken and was fixed, and its own file was still at zero
   afterwards because of the matcher. Fixing one cause does not clear the other — re-check by
   PRINTING what the instrument observes, not by re-reading the code.

THE RULE.

WIDEN, DO NOT REPLACE. Converted and unconverted files coexist until the ledger empties, so an
instrument that matches only the builder spelling goes blind to every file not yet converted. Accept
BOTH spellings for the whole of Stage A.

INSTRUMENTS ARE THE COORDINATOR'S TO REPAIR. A wave that finds one reports it and may hand back a
PATCH; it does not land the edit on its conversion branch. Three waves asked before touching one,
which is right — a count instrument shared by other waves is not a file a conversion commit may
quietly change.

MUTATION-CHECK THE WIDENING AGAINST THE REAL FILE, not against fixtures. The check is that removing
the behaviour the instrument guards still reddens it AFTER the widening, with the isolating reason
code. POD-3395's writer-guard patch is the model: three removals, three different and correct reason
codes.

### Rule 31a — the constraint COUNT matters for DO UPDATE and is irrelevant for DO NOTHING

[POD-3395 spotted that rule 31 might be wider than it needs to be, and declined to act on it because
it is a judgement about the rule. Measured by the coordinator, 2026-09-04. It narrows rule 31 and it
sharpens what POD-3403 is actually about.]

The two conflict clauses behave completely differently, and lumping them together as "the OR REPLACE /
OR IGNORE question" was my error.

DO NOTHING — TARGETLESS, SO EVERY UNIQUENESS CONSTRAINT IS COVERED. Drizzle's `onConflictDoNothing()`
with no argument emits a bare `on conflict do nothing`, and SQLite applies that to ANY uniqueness
conflict. Measured on a table with a PRIMARY KEY and a separate UNIQUE:

    onConflictDoNothing()  conflict on the PRIMARY KEY   -> suppressed
    onConflictDoNothing()  conflict on the OTHER UNIQUE  -> suppressed
    INSERT OR IGNORE       both                          -> suppressed

So for `INSERT OR IGNORE` the number of uniqueness constraints is IRRELEVANT. Rule 31's test is
complete as written: no CHECK, and no reachable NOT NULL violation. Do not count indexes for an
OR IGNORE site.

DO UPDATE — TARGETED, SO A SECOND UNIQUENESS CONSTRAINT IS A REAL DEFECT. `onConflictDoUpdate` REQUIRES
a target and emits `on conflict ("t"."id") do update set ...`. A conflict arriving on a DIFFERENT
uniqueness constraint is not covered:

    onConflictDoUpdate({target: id})  conflict on the TARGETED pk       -> applied
    onConflictDoUpdate({target: id})  conflict on the UNTARGETED unique -> THREW
    INSERT OR REPLACE                 the same untargeted conflict      -> applied

That is POD-3403's actual subject, and it is a conversion that starts REFUSING a write which currently
succeeds. Note also what OR REPLACE does in that row: it DELETES the conflicting row and reinserts, so
a table with inbound foreign keys can cascade — a second question the builder form never asks.

WHAT THIS CHANGES. An `INSERT OR IGNORE` site needs the rule 31 enumeration and nothing more. An
`INSERT OR REPLACE` site needs the enumeration AND a count of the table's uniqueness constraints AND a
check for inbound foreign keys, exactly as POD-3392 performed it with `pragma_index_list` against the
migrated database.


### Rule 31b — `client_sessions` keeps its atomic `INSERT OR REPLACE`, pinned to that one site

[Ruling on POD-3403, 2026-09-04, closing the question rule 31a opened. The audit is POD-3403's; the
exemption mechanism and its path pin are mine, and the reason they are mine is in the last paragraph.]

The site is `AuthRepository.recordSession` (`apps/server/src/store/auth.ts`). `client_sessions` carries
a PRIMARY KEY on `token_hash` AND a separate unique index `idx_client_sessions_session_id`. That is
exactly rule 31a's DO UPDATE row: a mobile re-pair reusing a `session_id` under a new `token_hash`
conflicts on the UNTARGETED constraint, which `INSERT OR REPLACE` applies today and
`onConflictDoUpdate` would throw on. Converting it starts refusing a write that currently succeeds, on
the auth path, so the statement STAYS.

THE EXEMPTION IS THREE CONDITIONS, NOT A TOKEN. Like rule 31a's UPDATE-conflict exemption, the token
alone grants nothing. `check-boundaries.ts` requires ALL of:

    the file is exactly apps/server/src/store/auth.ts
    the statement's span carries `// REPLACE-STATEMENT POD-3403`
    the statement body opens `INSERT OR REPLACE`

IT IS PATH-PINNED AND POD-3406's IS NOT, DELIBERATELY. An `UPDATE OR IGNORE` that loses a race leaves
the row alone. `INSERT OR REPLACE` DELETES the conflicting row and reinserts it, so it fires
`ON DELETE CASCADE` on every inbound foreign key — rule 31a's own closing sentence. A token-plus-shape
exemption would let any future site adopt that behaviour by typing the token. Pinning the path forces
the next `INSERT OR REPLACE` back here for its own ruling with its own foreign-key audit, which is the
answer we want it to have to produce.

NOT A `DECISION` MARKER. The policy is answered, and Stage A's exit gate counts UNANSWERED markers to
zero (rule 33). A `DECISION` token here would block the gate forever.

WHAT I GOT WRONG. POD-3403 wrote all three halves — spec rule, lint exemption, site comment. I told it
to revert every shared-file edit after it collided with POD-3406 in the same two files, and kept only
its site work. The site work DEPENDS on the other two halves, so what came back cited a rule that did
not exist and used a token nothing recognised, and `lint:boundaries` reddened on `auth.ts:91` at the
trial merge. The redirect was mine and so was the gap. When a worker's change spans a site and the
rule that permits it, splitting them leaves the site indefensible; either take both halves or take
neither.


### Rule 34 — the capability object is a CONSTRUCTOR detail; call sites read `this.db` and `this.transact`

[Operator decision, 2026-09-04, on seeing `this.queries.db.insert(...)` at call sites. My error in
rule 27b, not the waves' — they implemented what I wrote.]

`this.queries.db.insert(...)` has two levels of nesting where one carries meaning. `SyncQueries` is
WIRING; it must be named in the constructor and nowhere else. Destructure it:

    constructor(queries: SyncQueries) {
      this.db = queries.db
      this.transact = queries.transact
    }

Call sites then read `this.transact(() => ...)` and `this.db.insert(...)`: a span and a query, each
self-explanatory, no nesting, and IDENTICAL before and after the flip except for async/await. The
construction lines in `store.ts` do NOT change — they still pass the one capability object.

### Rule 35b — drizzle's savepoints are NOT namespaced, and rule 35a loses a defence because of it

[Found by following POD-3263's question about which transaction-spec assertions may die with the
`podium_sp_` deletion, 2026-09-05. This is a regression in MY rule 35a, not in the worker's work.]

`transaction-spec.ts:176` pins a real safety property, not a mechanism detail: *a callback-created
savepoint cannot hijack the helper boundary*. Callback code that runs `SAVEPOINT sp_1` — "a name the
helper once used at depth 1" — must not be able to steal the helper's rollback boundary, and today it
cannot, because our savepoints are namespaced `podium_sp_${depth}`.

DRIZZLE'S ARE NOT NAMESPACED. Its sessions emit ``const savepointName = `sp${this.nestedIndex}` ``,
so nesting produces `sp1`, `sp2`, … Callback code inside a transaction that runs `RELEASE SAVEPOINT
sp1` would release DRIZZLE's savepoint at that depth and collapse the boundary the outer arm depends
on. Rule 35a hands the nested arm to drizzle, so it hands away this defence with it.

**MEASURED 2026-09-05, AND I WAS WRONG. THE DEFENCE HOLDS.** POD-3263 ported the test to
`executor.test.ts` and it PASSES, with the callback running `SAVEPOINT sp1` inside the span. I ran it
myself, varied the colliding name across `sp0`/`sp1`/`sp2`/`sp3` — all pass — and confirmed the
assertion is live rather than vacuous by flipping its expectation, which reds it with
`expected [ 'outer' ] to deeply equal [ 'outer', 'inner' ]`.

WHY I WAS WRONG, and it is a premise error worth keeping. Drizzle emits `sp${nestedIndex}` in ITS OWN
session implementations (`d1`, `tursodatabase-sync`). The bun executor does not take that path: it
names its own boundaries in `bun-driver.ts` as ``const boundary = `podium_batch_${nextBatchBoundary++}` ``
— monotonic, per session, and namespaced. So the namespacing defence was never drizzle's to lose; it
moved from `podium_sp_<depth>` to `podium_batch_<n>` and still holds. I reasoned from a grep of
node_modules instead of from the path that actually issues the savepoint.

The rule below stands as a WARNING for the driver paths that DO use drizzle's own transaction
implementation — Turso in E.5 — where `sp<n>` is what gets emitted and the collision is real. Re-run
that ported test against the libsql/Turso driver before enabling it.

ORIGINAL TEXT, kept for the record:

THIS IS A MEASUREMENT, NOT YET A DECISION. Port that exact test to the executor's transaction path and
RUN it. I expect it to fail. Report the result before deleting anything:

- If it PASSES, the property survived by some other means and the assertion transfers as-is.
- If it FAILS, we have narrowed a safety contract and must choose deliberately — either document that
  raw savepoint statements inside a transaction callback are out of contract (and add a lint that
  says so), or keep a thin namespacing wrapper on the nested arm. That choice is mine, not the
  worker's; bring me the failure.

WHAT DIES AND WHAT TRANSFERS, for the rest of that spec file. The assertions naming
`podium_sp_${depth}` or the `depths` WeakMap are MECHANISM and die with the implementation. The
assertions on OBSERVABLE behaviour transfer to the executor's transaction tests unchanged: commits at
depth 0 returning the callback result, rollback at depth 0 rethrowing the original error, nested
savepoints committing when everything succeeds, and — the load-bearing one — rolling back ONLY the
inner savepoint when the outer catches the throw.

### Rule 48a — the sync-to-rejects spelling is authorized GLOBALLY; stop asking per site

[POD-3263 has now raised this class three times — the awaitify ledger, `engine.test.ts`'s capture
helper, and `relay.issue-session-delete.test.ts`'s rollback canaries. Standing authorization,
2026-09-05, so the flip is not serialized behind a coordinator round-trip per file.]

`expect(() => fn()).toThrow(X)` becoming `await expect(fn()).rejects.toThrow(X)` is NOT a change to
what is asserted. Same matcher, same expectation, async spelling — it is `await` plus the call moving
inside, which is exactly what the flip's mechanical rule permits. **Apply it wherever the callee
became async. No further permission needed.**

TWO CONDITIONS, and they are the whole reason this is a rule rather than a shrug:

1. THE AWAIT IS MANDATORY AND ITS ABSENCE IS SILENT. `expect(p).rejects.toThrow()` without `await`
   asserts nothing and passes forever. Canary each batch: break the subject, watch a named case red.
   This is the opposite hazard to rule 48's capture helper, where a missed await leaves
   `expect(Promise).toBe(string)` and fails LOUDLY. Same flip, inverted risk — do not carry the
   confidence from one to the other.

2. WHATEVER FOLLOWS THE THROW IS THE REAL GUARD AND TRANSFERS UNTOUCHED. At the
   `relay.issue-session-delete.test.ts` sites the `toThrow` is only the trigger; each is followed by
   four awaited state assertions — `deletedAt` still unset, the session still listed, the row still
   present — which are what actually prove the rollback happened. Those do not change. And note the
   second reason the await is mandatory there: without it the operation may not have SETTLED when
   those state assertions run, so dropping it buys a flaky pass rather than an honest one.

IF A SITE HAS NO POST-THROW ASSERTIONS, say so in the handoff rather than adding some. A bare
converted `rejects.toThrow` is acceptable where that is all the original pinned; inventing new
assertions mid-flip is a different change and needs its own ruling.

### Rule 49 — a cached RETENTION bound resolves PER PASS, and its fail-closed answer is re-bootstrap

[Ruling on POD-3263's fifth boundary, 2026-09-05. Refines rule 47, which covers a synchronous reader
over an async store. `FeedRetentionPort.minAvailableSeq` and `authorizationRevision` look like the
same shape as feed identity. They are not, and caching them the identity way is unsafe.]

IDENTITY IS EFFECTIVELY IMMUTABLE; A RETENTION BOUND ONLY RISES. `minAvailableSeq` increases every
time retention prunes, so a cached copy is not merely possibly-stale — it is stale in ONE direction,
and that direction is the dangerous one. `change-log.ts` states the servability rule: a cursor is
servable iff `cursor + 1 >= minAvailableSeq`. With a stale-LOW cached bound the server computes
servable for a cursor whose changes it has already pruned, and serves a gap. The same file already
warns of the identical failure for the degenerate value: "a 0 would claim it can serve a cursor it
cannot."

SO: RESOLVE PER SERVING PASS, not once at boot. Rule 47's resolve-once is correct for identity and
wrong here.

AND THE FAIL-CLOSED ANSWER IS ALREADY WRITTEN DOWN. When the bound is unresolved or in doubt, answer
RE-BOOTSTRAP, because `change-log.ts` certifies that direction as always safe: "the authority's answer
is authoritative either way; a needless bootstrap is always legal". Never default to serving. The
same reasoning gives `authorizationRevision` its default: an unresolved revision means re-check or
refuse, never authorize on a cached one.

GENERALLY: before caching a value behind a synchronous reader, ask which way it drifts. If it drifts
toward permitting more, it may not be cached across the operation it permits.

### Rule 48 — an exact-error capture helper goes async; the expected strings transfer VERBATIM

[Ruling on POD-3263's fourth assertion boundary, 2026-09-05. The site is
`modules/workflows/engine.test.ts`, whose `thrown(fn)` helper captures a throw as the exact string
`` `${name}: ${message} | code=${code}` `` and returns `'NO THROW'` otherwise. 84 call sites; 15 now
call commands that return promises.]

CUSTODY TRANSFERS TO AN ASYNC CAPTURE HELPER. `await fn()` inside the same try/catch catches a
synchronous throw AND a rejection, so ONE helper serves all 84 sites and the sync ones need no split.
The returned string format and the `'NO THROW'` sentinel are preserved exactly, so every expected
string in every assertion transfers UNCHANGED. Under the flip's mechanical rule that is await plus a
helper rename and nothing else. **If any expected string has to change, that is a finding — stop and
report it, do not adjust the expectation.**

THE OTHER ARM IS IMPOSSIBLE, not merely undesirable. "Keep synchronous validation before returning a
promise" cannot work where validation READS THE STORE, and these do: `'unknown workflow revision:
wfr_nope'` can only be known by looking the revision up, and that read is async after the flip.
Splitting the 15 into sync-validatable and not would also give one error class two failure modes,
which is worse than either alone. It is an API redesign and the flip is not the place for it.

THIS MIGRATION IS SAFE-BY-CONSTRUCTION, unlike the `rejects.toThrow` one in the awaitify ledger. A
missed `await` here leaves `expect(Promise).toBe('Error: …')`, which FAILS LOUDLY. A missed `await` on
`rejects.toThrow` passes silently. Same flip, opposite hazard — do not carry the caution from one to
the other, and do not "harden" this helper into something that swallows the difference.

PRESERVE THE COUNTERFACTUALS. Several of these tests pair a refusal with the same call by a
higher-grade principal, explicitly so the refusal is known to be the rule firing rather than an
incidental failure. Those are arming canaries. They transfer with the assertions they guard.

### Rule 47 — a synchronous reader over an async store LOADS AT AN ASYNC ENTRY POINT, never at composition

[Ruling on POD-3263's no-rule boundary, 2026-09-05. The site is `FeedIdentityRegistry.current()`,
which must stay synchronous because `FeedPublisher` drain/connect and the conformance getters call it
on a path that may not yield (§2.5). Its store's reads are async after the flip.]

B1 proposed loading and minting in an async `open(store, mint)` before composition. REFUSED, because
`identity.ts` documents two properties that construction-time loading destroys, and both have stated
reasons:

    Constructing this does NOT write. The identity is minted lazily on the first `current()`, so a
    read-only consumer of a fresh database does not silently create a feed — and, more usefully, so a
    test can observe the "no identity persisted yet" state that a first-boot replica actually meets.

and `current()` reads THROUGH on a cache miss, "which is what makes 'survives a restart' a property a
test can assert by building a second registry over the same store".

THE RULE. Where a synchronous reader sits over a now-async store, add an EXPLICIT async resolve step
and call it at the async entry points that already precede the synchronous path — not in the
constructor, and not in composition. Three conditions:

1. CONSTRUCTION STILL WRITES NOTHING. The resolve step is a separate call, so a read-only consumer
   that never enters the write path still never mints. That is the property being preserved.
2. THE SYNCHRONOUS READER THROWS IF UNRESOLVED. It must not lazily mint, return null, or return a
   stale value. A missed call site has to fail loudly at the first read: for feed identity the silent
   alternative is a replica applying a foreign timeline, which `bump()`'s own guard exists to prevent.
3. RESOLVE IS IDEMPOTENT AND READS THROUGH ONCE. Building a second registry over the same store and
   resolving must still observe the persisted value, so the restart property keeps its test.

WHY NOT THE OTHER ARM. Making `current()` async and widening the publisher/connection API pushes a
yield into the transport drain, which is exactly the class §2.5 exists to forbid: a drain that can
yield mid-loop lets frames interleave. The registry is not the place to discover that.

GENERALLY: when the flip makes a dependency async under a caller that may not yield, the fix is to
move the await EARLIER to a boundary that already exists, never to make the non-yielding path yield
and never to hide the await behind a cache that can be stale.

### Rule 35 — transaction routing is AMBIENT, and drizzle's transaction is the mechanism

[Operator decision on record, 2026-09-04. Supersedes the framing in rule 30, which described ambient
routing as a choice with two rejected alternatives without picking one.]

DECIDED: option 2, ambient. Threading a transaction object through the write paths was rejected as
"just ugly" and because its cost is not the 57 write spans but every read reachable from them.

THE SHAPE. A repository's `db` is a GETTER, so the Turso problem is confined to one place and no call
site changes:

    private get db() {
      return currentTransaction() ?? this.root   // inside a span → the span; otherwise → the root
    }

AND OUR OWN TRANSACTION MACHINERY GOES. `transact` becomes a thin adapter over DRIZZLE's transaction
rather than a reimplementation of it:

    transact(fn) {
      const tx = currentTransaction()
      return tx
        ? tx.transaction((inner) => scope.run(inner, fn))   // drizzle's savepoint
        : this.root.transaction((t) => scope.run(t, fn), { behavior: 'immediate' })
    }

**RULE 35a — THE OUTER ARM IS THE EXECUTOR'S, NOT DRIZZLE'S (POD-3263 correction, 2026-09-05).**
The snippet above says `this.root.transaction(...)`. That is right for bun:sqlite, where the
size-one queue owns one shared connection, and WRONG for the async driver. Over `sqlite-proxy`,
drizzle implements `transaction()` as BEGIN, body, COMMIT issued through its callback — three
ordinary statements that the root `QueryClient` scheduler would lease INDEPENDENTLY, so nothing
holds one connection across the body. `driver.ts` states the contract the other way round: the
queue owns the connection, and an interactive transaction is held open on the server across awaits
under a declared lease budget. So the outer arm must be the executor's `transact`, which pins that
lease; drizzle's own `transaction` is correct ONLY for the nested arm, where a connection is already
pinned and all it adds is a savepoint:

    // outer: the executor pins the lease, and the span runs on the pinned connection
    executor.transact((tx) => scope.run(buildStoreDrizzle(tx.drizzle), fn))
    // nested: a savepoint inside the already-pinned connection
    currentTransaction().transaction((inner) => scope.run(inner, fn))

The ambient getter, the `behavior: 'immediate'` intent and the savepoint deletions are all
unchanged; only WHO opens the outermost span moves, from drizzle to the executor. Found by POD-3263
before wiring it rather than after, which is why it costs a paragraph instead of a phase.

DELETED by this: the `podium_sp_${depth}` savepoint construction and the `depths` WeakMap in
`packages/runtime/src/sqlite/transaction.ts`. Drizzle nests via its own savepoints and we stop having
a second tally. That is POD-3327 / POD-3267 and it is now a deletion with a named replacement rather
than a deletion with a gap.

WHAT LEGITIMATELY REMAINS IN THE ADAPTER, four things, each with a reason:
1. `scope.run` — putting the transaction where repositories find it. This IS option 2.
2. `behavior: 'immediate'` — drizzle defaults to `deferred`, which takes a read lock and cannot always
   upgrade it. One wrapper applies it once; 57 call sites would each have to remember a config object.
3. Choosing nested vs root — four lines, using drizzle's own two entry points.
4. Post-commit registration. Drizzle's transaction has no after-commit hook, and publication must be
   registered DURING the span and run AFTER it. This is the only genuine addition.

THE COST, stated plainly because it is real: the compiler cannot see which connection a statement goes
to. A `this.db` captured into a variable and used after an `await` that left the span silently gets the
root. That is narrow enough to lint for and the lint is owed before the flip.

### Rule 36 — a `sql` fragment in the SELECT LIST of a join-free query loses its table qualifier

[Found by POD-3398 converting workflows.ts, where every workflow reported `latestVersion` 0. POD-3397
reproduced it independently with a WRONG VALUE, identified the trigger as POSITION rather than
correlation, and verified the `sql.identifier` fix. POD-3396 named the mechanism in drizzle's source,
isolated the join-free condition, and found the composition subtlety below. Verified by the coordinator against drizzle's source and all six
positions, after a first attempt that tested the WRONG position and found nothing. The most dangerous
class in this epic: silent, valid SQL, plausible answer.]

THE TRIGGER IS POSITION, not correlation and not "one FROM table" on its own. Measured, same fragment
in six shapes:

    a  projection / 1 table / no subquery   select "id" from "parent"
    b  projection / 1 table / SUBQUERY      select (... where c.parent_id = "id") from "parent"   <-- BUG
    c  projection / 2 tables / subquery     select (... where c.parent_id = "parent"."id") ...    safe
    d  WHERE / 1 table / subquery           select "id" from "parent" where (... "parent"."id")   safe
    f  b's fragment COMPOSED one level deep select (... where c.parent_id = "parent"."id")        safe
    e  fix, sql.identifier                  select (... where c.parent_id = "parent"."id")        safe

THE MECHANISM, named: `sqlite-core/dialect.js`. `isSingleTable = !joins || joins.length === 0`, and
`buildSelection` — ONLY `buildSelection` — then does

    query.queryChunks.map((c) => is(c, Column) ? sql.identifier(c.name) : c)

a blind map that replaces every Column with a BARE identifier. It does not know some chunks sit inside
a nested FROM, so it strips the qualifier off the OUTER query's column while it sits in a subquery
whose own table is the first thing that name now resolves against. The WHERE clause never goes through
this code, which is why (d) is safe — and why my first reproduction attempt, which used a WHERE clause,
found nothing and nearly produced a rule naming the wrong trigger.

(a) IS THE SAME REWRITE AND IS HARMLESS, because there is no inner FROM for the bare name to bind to.
The harm needs the fragment to carry its own FROM. Trigger and harm are different conditions.

WHY YOU CANNOT ANSWER THIS BY READING. `queryChunks.map` walks only the TOP LEVEL. A Column one level
deeper — a fragment built from a fragment — is never a top-level chunk and is never rewritten. So (b)
and (f) are the SAME logical fragment: broken written inline, silently correct when composed. Knowing
the rule and eyeballing your fragments will still miss it.

THE RULE.
- PRINT, do not look. `toSQL()` on every query with a `sql` fragment in its projection. Nothing else
  shows this, and composing the fragment differently changes the answer.
- FIX with `sql.identifier` for the outer table and column: identifier chunks are not Column chunks, so
  the map leaves them alone. Caveat from POD-3397: `sql.identifier` of an out-of-scope table throws at
  prepare — loud, where the bare form is silent, which is the trade you want.
- SEVERITY, from POD-3396's site: the bare form was CORRECT until someone adds a column.
  `ship_train_active_claims` has no `id`, so the bare name fell through to the outer query and counted
  right. Give that table an `id` and the same code counts 0 — measured, bare 0 against qualified 2. No
  error, no log, a plausible number, and every train reads as unclaimed. POD-3398's site was already
  wrong: every workflow reported `latestVersion` 0.
- Neither typecheck nor the intent lint can see any of it. The SQL is valid and it reads correctly.

### Rule 37 — a byte-for-byte custody check reads its column as TEXT, whatever mode the schema declares

[POD-3396 asked; ruled 2026-09-04. Rule 4 permits `mode: 'json'` for a column; it does not oblige a
READER to take it.]

`trainManifestForAttempt` compares the STORED TEXT of two columns byte for byte against a re-serialised
manifest, as a train custody check, and the member check does the same for a third. Read through
`mode: 'json'` those comparisons are between an object and a string and are ALWAYS unequal, so every
train fails its authority check — it reddened two of POD-3396's own golden tests. It also moves the
throw point and the message for six corrupt-blob oracle cases, from the model's refusal to drizzle's
raw parse error, BEFORE the method's own fences.

RULED: read those columns as TEXT. POD-3396's choice stands and needs no marker.

WHY, and it is not merely "no behaviour change". Comparing structurally instead would be a WEAKENING,
not a fix: byte equality REJECTS a re-serialised blob and structural equality ACCEPTS it. A custody
check exists precisely to notice that the bytes are not the ones that were stored. Converting it to a
structural comparison would silently retire the property the check is named for, inside a commit whose
stated purpose is a mechanical conversion — which is the exact shape §5.1 forbids.

THE GENERAL FORM. The schema's declared mode describes how a column is USUALLY read, not how every
reader must. Where a reader's contract is about the STORED REPRESENTATION — custody, digests, signature
payloads, anything compared byte-for-byte or hashed — it reads text and says so at the site. Where the
contract is about the VALUE, take the declared mode (rule 28). Decide by asking what the comparison
means, never by what the column declaration says.

This also leaves the corrupt-blob oracle's six throw cases exactly as POD-3245 classified them, which
is the answer to whether that shared file needed rewriting: it did not.

### Rule 34a — `db` is a GETTER, not an assigned field, or rule 35 cannot work

[POD-3396 spotted the analogous hazard for `transact` and wrapped it rather than assigning straight
across. The same reasoning applies with more force to `db`, and nobody had applied it — including me,
when I wrote rule 34's snippet. Corrected 2026-09-04, while five waves were mid-rename.]

Rule 34's snippet said `this.db = queries.db`. That FREEZES `db` to the root drizzle instance at
construction time. Rule 35 requires `db` to resolve the ENCLOSING TRANSACTION on every access:

    private get db() { return currentTransaction() ?? this.queries.db }

A field assigned once in a constructor can never do that. Landing rule 34 as written would mean
touching all 39 repositories a THIRD time at B1 to convert each field into a getter — after touching
them for the conversion and again for the destructure.

THE SHAPE, and it is what every wave should be renaming to right now:

    constructor(private readonly queries: SyncQueries) {}

    protected get db() {
      return this.queries.db          // B1 changes THIS LINE ONLY, in one place
    }
    protected transact = <T>(fn: () => T): T => this.queries.transact(fn)

CALL SITES ARE IDENTICAL to rule 34 — `this.db.select(...)` and `this.transact(() => ...)`. This is a
change to the two declarations, not to any method body, and not to `store.ts`.

WHY `transact` IS AN ARROW FIELD RATHER THAN A STRAIGHT ASSIGNMENT, which is POD-3396's argument and I
am adopting it as the standard: `syncQueriesOver` returns an arrow closing over the handle, so
`this.transact = queries.transact` happens to work TODAY. It stops working the moment the
implementation uses `this` — which is exactly what rule 35's adapter does — and it stops working
SILENTLY, as a detached method. Costs one closure per repository instance. Silent is the failure mode
this epic keeps paying for, so we pay the closure.

THE POINT OF BOTH: after this, a repository is touched ONCE more in the whole epic, and that touch is
`async`/`await`. The connection question resolves in one getter body, in one place.

### Rule 38 — do NOT unwrap drizzle's error in the seam; unwrap at the two sites that CLASSIFY

[POD-3397, POD-3398 and POD-3396 all independently proposed "unwrap once at `syncQueriesOver`, rather
than at 39 call sites". It is the right instinct and it cannot be done there. Measured 2026-09-04.]

WHERE IT CANNOT GO. `clientOverWrapper` is BELOW drizzle: our client throws the raw error and drizzle
wraps it afterwards. Measured with a client-level catch in place —

    [client saw]  SQLiteError        SQLITE_CONSTRAINT_PRIMARYKEY
    [caller saw]  DrizzleQueryError  code undefined, cause SQLiteError

— so the seam as it exists cannot see the wrapper, let alone remove it.

WHERE IT WOULD HAVE TO GO, AND WHY WE ARE NOT PUTTING IT THERE. A Proxy over the drizzle instance does
work for a direct call:

    db.run(sql`…`)                          proxy unwraps -> SQLiteError, code intact

but NOT for the chained builder, which is what every converted repository writes, because the error is
thrown at `.run()` on the builder and not at `db.insert()`:

    db.insert(t).values({...}).run()        proxy does nothing -> DrizzleQueryError, code undefined

Making it work means a DEEP proxy wrapping every builder object returned at every link of every chain,
on the hottest path in the system. That is a large amount of magic and a per-query allocation cost, to
serve two call sites.

THE RULE: unwrap where the error is CLASSIFIED, not where it is raised.

Two production sites read a driver error, and both are already the right place:
  - `store/spike/turso-append/libsql-driver.ts` `classify()` — reads `error.code`, then falls back to
    a `/SQLITE_BUSY|database is locked/i` message regex. This is the one that matters: a wrapped busy
    error classifies as FATAL and the bounded retry never runs (driver.ts:119-159). E.5 inherits it.
  - `packages/sync/src/adapters/mobile-sqlite/sql.ts` — the same shape for disk-full.

Each unwraps `.cause` TRANSITIVELY before classifying — do not assume one level — and each gets a test
that a WRAPPED error still classifies correctly, not only a raw one. That preserves every production
behaviour, because zero production sites match on error TEXT (checked).

WHAT GENUINELY CHANGES, and it is accepted rather than papered over: a caller that catches and reads
`.message` now sees "Failed query: …". One test asserts on that message
(`modules/shipping/service.test.ts`, "rolls back cancellation state when its durable issue event cannot
commit"). The rollback it actually tests still works; only the message moved. A conversion commit may
not modify an assertion, so the COORDINATOR updates that one to assert on the cause — it is a real and
accepted behaviour change at the boundary, not a wave's bookkeeping.

### Rule 39 — a conversion may not WIDEN a projection; count the columns, do not spread them

[POD-3396, 2026-09-04, found by running rule 36's print rather than by reading. No test could have
caught it. Every wave that used a `getTableColumns` spread for an AD-HOC select has the same exposure.]

Spreading `getTableColumns(table)` into a select is exact for a MAPPER shape, because a hand-written
mapper select names exactly its table's columns — POD-3396 proved that for five of its shapes by
derivation, 25/25, 16/16, 15/15, 11/11, 12/12. It is NOT exact for an ad-hoc projection that named a
subset. Two of POD-3396's did:

    manifest authority read   named 19 of 25 columns   spread read 25   -> 6 extra
    member read               named 10 of 12 columns   spread read 12   -> 2 extra

WHY NO TEST CATCHES IT. Both readers build an explicit object from named fields, so the extra columns
are read, returned, and ignored. Nothing observable changes. The row count is right, the values are
right, every assertion passes.

WHY IT IS NOT HARMLESS. This is the epic's own criterion: on a remote driver those are bytes over a
network, on every row of every call. It is also simply not the literal conversion the method asks for
— §5.1 says behaviour-preserving, and reading six columns nobody asked for is a change made silently
under cover of a mechanical pass.

THE RULE. Before spreading `getTableColumns`, COUNT the columns the original statement named and
compare with the table's column count. Equal — spread, and state the derivation (n/n) in your handoff,
as POD-3396 did. Unequal — name the columns explicitly, column by column, and verify by PRINTING the
emitted SQL rather than by reading the builder.

This is the second thing on one file that printing found and reading could not, which is rule 36's
argument arriving from a different direction: `toSQL()` is not only for the qualifier bug. Print any
projection a conversion touched.

### Rule 40 — never `reset --hard` the integration branch; trial-merge in a detached worktree

[Coordinator error, 2026-09-04. Caught and absorbed by POD-3398, which is the only reason it cost one
wave an hour instead of several waves a day.]

WHAT I DID. I merged POD-3393 onto the integration branch to evaluate it, found the merge textually
clean and semantically wrong, and backed it out with `git reset --hard HEAD^`. I reasoned that this
was safe because the merge had never been PUSHED.

WHY THAT REASONING IS WRONG, and it is the part worth keeping. Every wave's worktree on this machine
shares ONE object store and ONE set of refs with the coordinator's. The moment I committed the merge,
`issue/3221-…` pointed at it for every session simultaneously — no push required. POD-3398 rebased onto
it in that window. When I reset, four commits vanished from under a branch that had already replayed
onto them. Push has nothing to do with visibility here; local IS shared.

HOW IT SURFACED, which is the dangerous part: POD-3398's branch went red with EIGHT typecheck errors in
`store.ts`, every one on ANOTHER WAVE's constructor lines and none on its own. The obvious way to make
your branch green in that situation is to "fix" the other wave's lines — the exact cross-wave edit rule
29 exists to forbid. It reported instead, which is the right move and the only one that keeps this
recoverable.

THE RULE.
- To EVALUATE a merge, do it in a detached scratch worktree: `git worktree add --detach <path> <tip>`,
  merge there, run the gates, throw it away. The shared branch never moves.
- To UNDO something already on the shared branch, `git revert`. It moves the branch FORWARD, so a
  worktree that rebased onto the old tip still has a valid base.
- `reset --hard` on a branch other sessions rebase onto is a history rewrite for all of them,
  regardless of push state.

FOR WAVES, the general form: if your branch goes red on lines you did not write, do not fix them.
Check whether your base moved (`git log <tip>..HEAD` should be your commits and nothing else) and mail
the coordinator. A red on someone else's line is a base problem, not a code problem.

### Rule 36a — the TRIGGER is far more common than the HARM, and the harm arrives later

[POD-3395 printed its six projection fragments and found the mechanism ACTIVE in three of them,
harmless today. POD-3397 contributed the method. 2026-09-04.]

POD-3395's audit found `max("sequence")` emitted as a BARE identifier where the qualified form would be
`max("conversation_segment_incarnations"."sequence")`. That IS buildSelection's rewrite, firing, in
shipped code. It is harmless only because none of those queries has a join or a correlated subquery, so
the bare name binds to the single FROM table.

WHICH MEANS THE BUG IS LATENT, NOT ABSENT. Any of those three inherits the defect the day someone adds
a join — and at that moment nothing looks wrong: the fragment is not being edited, the join is a normal
change, no test fails, and the person adding the join has no reason to run `toSQL()` on a projection
they did not touch. The failure is planted now and detonates on an unrelated future edit by someone
else.

CONSEQUENCE FOR THE PLAN. A per-wave print catches today's harm and cannot catch tomorrow's. The lint
shape to want is "a bare identifier in the projection of a query that later grows a join", and the
hard part — noted here so nobody rediscovers it — is that the dangerous moment is invisible: it is the
join being added, in a query whose projection nobody is looking at. Filed as a B-prep item rather than
solved here.

DERIVE THE SITE LIST, DO NOT RECALL IT. POD-3397's method, and it is the difference between an audit
and a recollection: grep both files for a `sql` fragment appearing inside a `.select({...})`
projection, which returned exactly two sites out of 86 statements, then print those two. A wave that
reports "I reviewed my fragments" has done something much weaker than a wave that reports "there are
two, here they are". State the DENOMINATOR — n sites out of m statements — so the audit is checkable.

### Rule 36b — CORRECTS 36a: a join FIXES the bare identifier; a same-named inner column is what breaks it

[POD-3395 retracted its own inference and I re-measured before amending. 2026-09-04. Rule 36a as I
first wrote it had the latency pointing the wrong way, and POD-3414's defeat test could not have
failed.]

I wrote in 36a that a bare identifier "inherits the defect the day someone adds a join". Measured, that
is false in both directions:

    max / 1 table          select max("n") from "a"
    max / joined           select max("a"."n") from "a" inner join "b" ...        <- RE-QUALIFIED
    countDistinct / 1      select count(distinct "id") from "a"
    countDistinct / joined select count(distinct "a"."id") from "a" inner join …  <- RE-QUALIFIED
    hand-written / 1 table select (select count(*) from b where b.a_id = "id") from "a"
    hand-written / joined  select (select count(*) from b where b.a_id = "a"."id") …  <- RE-QUALIFIED

Adding a join RE-QUALIFIES. It is the fix, not the trigger. A defeat test that adds a join to a bare
site is green whether the check works or not — the vacuous-guard shape this epic has now hit five
times, and POD-3395 caught this one before I built it.

WHEN THE BUG ACTUALLY BITES. A hand-written fragment carrying its OWN FROM, in a single-table query,
emits the outer table's column bare INSIDE the subquery. SQLite resolves that name against the INNER
table first. So it is:

  - WRONG NOW, silently, when the inner table has a column of that name;
  - CORRECT BY ACCIDENT when the inner table does not.

AND THE REAL LATENCY IS THE OTHER EDIT ENTIRELY: the accident ends when someone adds a same-named
column TO THE INNER TABLE. Nobody touches the fragment, nobody touches the query, and there is no join
involved. POD-3396's `ship_train_active_claims` case is exactly this — bare because that table has no
`id`, and it would start counting 0 the day it gained one.

DRIZZLE'S OWN HELPERS ARE NOT AT RISK, and that is the distinction I collapsed: `max()`,
`countDistinct()` and a plain column are re-rendered per query shape, so bare output from them is
normal and self-correcting. A hand-written `sql` fragment's chunks are mapped ONCE and blindly. Only
the hand-written fragment with an inner FROM has the defect.

WHAT CARRIES OVER FROM 36a UNCHANGED: derive the site list rather than recalling it, state the
denominator, and print rather than read.

### Rule 34b — a getter is only worth having if nothing routes around it

[POD-3396, 2026-09-04, and it is the check that makes rule 34a meaningful rather than decorative.
ATTRIBUTION CORRECTED: I first wrote POD-3395 here and in the commit. POD-3395 flagged it and had not
done this check at the time — it has since run it over its own eight classes and reports 90/90 by AST.]

`private get db()` resolves the enclosing transaction ON EVERY ACCESS. That property is destroyed by
binding it to a local:

    const db = this.db          // resolves ONCE
    db.insert(...)              // ...and every use after this serves a STALE instance,
    await something()           //    including across an await that left the span
    db.update(...)              // <- wrong connection, silently

Every `this.db` must chain a query IMMEDIATELY. POD-3396 verified all 71 of its occurrences do, and
POD-3395 has since verified 90/90 across its eight classes, asserting through the TypeScript AST that
each occurrence's parent node is a property access on the `this.db` node itself.

TWO WARNINGS FROM ITS DOING IT.

The naive grep is WRONG. `const row = this.db` looks like a capture and is usually the first line of a
multi-line chain whose variable holds the RESULT, not the instance. POD-3396's first grep misread its
own code; it re-checked by parsing. POD-3395 then hit the SAME hazard from the other side while
counting rule 34a compliance: its grep reported five files still assigning `transact`, and all five
were files whose COMMENT quotes the anti-pattern. Strip comments before counting, in both directions. Any wave running this check by grep is running a check that does
not work.

AND THE HONEST LIMIT ON THE EVIDENCE, which POD-3396 stated rather than let stand: no test can
distinguish the getter from the assigned field today, because ambient routing does not exist yet. The
lane is green either way. Rule 34a's change is verified as NOT-A-REGRESSION, not as a fix, and it is
the pre-flip lint (already owed) that turns this from a convention into something checkable.

### Rule 39a — the derivation is the right instrument; its RAW OUTPUT is not the answer

[POD-3397, 2026-09-04. Its first rule-39 pass flagged four mismatches and all four were the script.]

Rule 39 says derive the column counts rather than eyeball them, and that stands. But a script that
pairs each converted projection against the FIRST SELECT in its enclosing method MIS-PAIRS every method
that issues several statements. POD-3397's four false positives, all resolved by reading the original
SQL:

    upsertIssue                    read 1/?   original is SELECT revision          -> 1/1
    assignRepoIdToIssuesUnder      read 1/2   twice; the other originals are
                                              SELECT MAX(seq) AS m and a seq lookup -> 1/1 each
    listRuntimeTranscriptEvents    read 2/1   the INNER subquery really is
                                              SELECT id, payload                    -> 2/2

RESOLVE EVERY MISMATCH INDIVIDUALLY AGAINST THE ORIGINAL SQL before reporting one. A wave that reports
a script's raw mismatch count has reported defects it does not have — which is the MIRROR of the
failure rule 39 exists to prevent, and just as misleading to whoever reads the handoff.

AND ANSWER THE RULE'S REAL QUESTION, NOT ITS STATED ROUTE. POD-3397 spreads `getTableColumns` nowhere,
so rule 39's literal trigger cannot arise in its files — and it derived the n/n counts anyway, because
the question is whether ANY converted read returns more columns than the statement it replaced. It
reported 16 bare `.select()` sites each replacing an original `SELECT *` (exact by construction) and 38
explicit projections all n/n, widest 5/5. That is the shape of a complete answer: a checked negative
with its denominator, not "the rule does not apply to me".

### Rule 41 — the coordinator regenerates the shard manifest at LAND time, every time

[POD-3392 found three of POD-3398's golden test files in no lane at all, at the tip, AFTER I had
landed and closed that wave. 2026-09-04.]

`apps/server/test-shards.json` is an explicit file list that `vitest.shard.ts` reads. A test file
missing from it RUNS NOWHERE and the lane still reports green. POD-3398 added
`store/{messages,sessions,workflows}-golden.test.ts` — 103 tests — and none of the three was in the
manifest at the tip. Its own lane runs were real, and my landing verification was real because I named
the three files explicitly, but in the LANES those 103 tests did not exist.

THE RULE. Landing a wave includes `bun scripts/server-test-shards.ts --write`, in the landing commit,
every time, whether or not the wave says it regenerated. NEVER hand-merge the manifest: a textual merge
drops entries silently and a short shard cannot fail.

WHY IT IS THE COORDINATOR'S AND NOT THE WAVE'S: the manifest is one shared generated file that every
wave's branch touches, so it conflicts on every merge and each wave regenerates against a base that
does not yet contain the other waves. Only the landing sees the union. A wave regenerating it is not
wrong; it is just not sufficient, and this is exactly the case where a clean merge is not a correct one.

VERIFY BY COUNTING, not by regenerating and assuming. After the write, grep the manifest for each test
file the wave added and assert a non-zero count — the same discipline as rule 32's instruments, and for
the same reason: absence is what a broken manifest looks like.


### Rule 42 — verify a control arm was APPLIED before you trust what it says

[POD-3395, 2026-09-04. The sixth finding in this epic whose shape is reading an ABSENCE as an answer.]

POD-3395 built a control arm by checking the base out over its files, ran both arms, and got 51 = 51.
The control had NEVER BEEN APPLIED: `git checkout <base> -- <paths>` ABORTS THE WHOLE CHECKOUT when any
one path is absent from the base — which happens constantly here, because the integration branch keeps
gaining new files. So the "control" run was the treatment a second time.

AND IT AGREED WITH ITSELF PERFECTLY, which is exactly what a correct result looks like. An A/B whose
two arms are the same tree cannot report a regression, and the empty symmetric difference reads as
proof rather than as the tell it is.

THE RULE, and it costs one command: after building the arm and BEFORE running it, assert
`git diff --stat <base>` over the arm's paths is EMPTY. An arm that was never applied fails that check
immediately. Then check `git status --porcelain` is empty after restoring — not just the diff — because
the same checkout STRANDS files the base has and your branch does not, as untracked leftovers that the
next `git add -A` sweeps in. POD-3395 hit that twice in one sitting, with wave 6's two golden tests and
then wave 7's three.

Related: rule 40 (the shared ref store is why the base keeps moving under you).

### Rule 43 — a converted INSERT binds NULL where the original OMITTED; that overrides column DEFAULTs

[POD-3394 spotted the shape; I measured it and the mechanism is not the one it guessed. 2026-09-04.]

A drizzle insert NAMES EVERY COLUMN IT KNOWS and binds `null` for the ones you did not supply.
POD-3394's machines upsert prints as 18 columns where the hand-written original named eight. That is
harmless for a nullable column with no default, and it is NOT harmless otherwise. Measured:

    create table d (id integer primary key, label text default 'login' not null, n integer)

    insert into d (id, n)            values (1, 10)          -> label = 'login'      (the DEFAULT applies)
    insert into d (id, label, n)     values (2, null, 20)    -> THREW: NOT NULL constraint failed

AN EXPLICIT NULL IS NOT AN OMISSION. It defeats the DEFAULT clause: on a NOT NULL column with a default
the write throws, and on a NULLABLE column with a default it silently stores NULL where the original
stored the default. The second is the dangerous one — no error, wrong value.

THE CHECK, on every converted INSERT: list the target table's columns that have a DEFAULT, and confirm
the conversion still OMITS each one the original omitted. `pragma table_info` gives you the defaults
from the shipped table. POD-3393 already found the one instance in its wave —
`client_sessions.label text DEFAULT 'login' NOT NULL`, migration 20260802111446 — while checking a
different rule.

NOT A DEFECT, checked so nobody re-checks it: an explicit `null` into an INTEGER PRIMARY KEY
AUTOINCREMENT behaves EXACTLY like omitting the column — both auto-assign. POD-3394 offered that as a
lead for the shipping red and it is measured false:

    insert into ev (ts)       values ('a')     -> id 1
    insert into ev (id, ts)   values (null,'b')-> id 2

THE SHIPPING RED IS THE ERROR WRAPPING, NOT THE NULL ID. `Failed query: insert into "podium_events" …`
is DrizzleQueryError's message format; the trigger's 'event refused' is on `.cause`. That is rule 38
and POD-3412, already filed, and it arrived with wave 6's events.ts as POD-3394 correctly determined
by name set.

### Rule 42a — PREVENT the unapplied arm, then prove it positively

[POD-3394 supplied the prevention and the positive probe; POD-3393 supplied the marker form. 2026-09-04.
Rule 42 only DETECTS the failure. These remove it.]

PARTITION THE PATHS FIRST — POD-3394's fix, and it costs nothing:

    while read -r f; do
      if git cat-file -e "$BASE:$f" 2>/dev/null; then echo "$f" >> modified.txt
      else echo "$f" >> added.txt; fi
    done < changed.txt
    xargs -a modified.txt git checkout $BASE --     # every path provably present
    xargs -a added.txt rm -f                        # the rest removed instead

`git checkout <base> -- <paths>` aborts the WHOLE checkout when any one path is absent. Partitioning
means it is never handed one. On POD-3394's own branch that split 12 present against 6 added — the five
golden tests plus a test-support file — which is exactly the set that would have aborted it as one list.

THEN PROVE THE ARM POSITIVELY, because an empty diff is itself an absence. Assert a token that exists
only in the TREATMENT is ABSENT from the control, and ideally that the OLD code is PRESENT.
POD-3394's probe is the model:

                                  treatment   control   restored
    locks.ts .prepare( count           0         12          0
    locks.ts 'protected get db'        1          0          1
    golden test files present          5          0          5
    ledger still lists locks.ts        0          1          0

Four signals flipping in the direction the conversion goes, and flipping back on restore. A tree
compared with itself cannot produce that table. POD-3393's lighter form is the same idea: grep the arm
for one treatment-only token — `SyncQueries` in its case — and require it absent.

AND ONE CONSISTENCY TELL, from POD-3394: if you ADD a test file to the lane you are measuring, then
identical TOTALS across the two arms are themselves the tell, because the control should have run fewer
tests. Its totals matched legitimately only because all five of its added files are in a different lane.

THE STRANDED-FILE HALF only arises for a branch that DELETES a file the base has; `git diff
--diff-filter=D <base>..HEAD` empty means it cannot happen to you. Check it rather than assume it.

### Rule 44 — a check whose PASS is SILENCE must be shown to fail before its silence counts

[POD-3394, 2026-09-04. The seventh absence-read-as-answer finding in this epic, and the one that names
the class. It applies to every other one.]

POD-3394 wrote a typecheck probe to prove no nullable field feeds a default-bearing column. It printed
nothing, which is what success looks like. It had actually refused to run: invoked outside the package,
tsgo reported `TS5112: tsconfig.json is present but will not be loaded if files are specified on
commandline` and did no work at all.

IT CAUGHT THIS WITH A CANARY: it fed the probe `a.repoPath`, a field that IS nullable and therefore
MUST error. It did not. Moved inside `apps/server` the canary errors correctly
(`TS2322: 'string | null' is not assignable to 'string'`), and only THEN did the real run's silence
mean anything.

THE RULE. Before you accept a silent pass as evidence, feed the check a case it MUST reject and watch
it reject that case. A tool that errored out before doing the work is silent in exactly the same way as
a tool that did the work and found nothing, and nothing downstream can tell the two apart.

THIS IS THE GENERAL FORM OF SEVEN FINDINGS IN THIS EPIC, and reading them together is the point:

  the probe that observed a converted repository at 0            (POD-3397)
  the two cache assertions passing at 0 === 0                    (POD-3397)
  the widened projection no test could see                       (POD-3396)
  the bash script truncated mid-run, exit 0, control skipped     (POD-3396)
  the control arm that was never applied and agreed with itself  (POD-3395)
  the defeat test that could not fail because a join re-qualifies (POD-3395, before it was built)
  the typecheck probe that refused to run                        (POD-3394)

Every one is a mechanism whose failure output and whose success output are the SAME OUTPUT. The gate
that can only say nothing cannot say no. Where a check reports by absence, the canary is not optional
diligence — it is the only thing that distinguishes the two states.

### Rule 45 — the throwing stub must DIE at B1, and be replaced by type-level removal

[Found by the operator asking what we had done about hiding drizzle's transaction, 2026-09-04.
Measured, not reasoned.]

`clientOverWrapper` currently gives drizzle a client whose `transaction()` THROWS, to stop a repository
calling `db.transaction(...)` and issuing BEGIN inside a span the store already opened. That works today
only because `syncQueriesOver` uses the runtime savepoint helper and never reaches it.

RULE 35'S ADAPTER CALLS DRIZZLE'S TRANSACTION. `root.transaction(fn, { behavior: 'immediate' })`
delegates to `this.client.transaction(...)` — which is the stub. Measured with the seam's exact shape:

    db.transaction((tx) => …, { behavior: 'immediate' })   ->  THREW: the seam refuses drizzle transactions

So the stub does not merely become redundant at B1. IT BLOCKS THE CHOSEN DESIGN. Anyone implementing
rule 35 without removing it first will conclude that drizzle's transaction cannot be used at all, and
will rebuild our own savepoint machinery — the exact thing rule 35 deletes.

THE REPLACEMENT IS STRONGER AND SITS OUT OF THE EXECUTION PATH:

    export type SyncDrizzle = Omit<ReturnType<typeof buildSyncDrizzle>, 'transaction'>

`this.db.transaction(...)` becomes a COMPILE ERROR rather than a lint finding plus a runtime throw. The
adapter holds the un-omitted type internally, so it can still call it; repositories cannot see it. A
name convention and a lint are both weaker than a member that does not exist — and unlike the stub, a
type has no behaviour to collide with.

KEEP the `store-transaction-port` lint: it still catches the raw handle and the migration paths, which
are not typed through `SyncDrizzle`. Verify the `Omit` does not disturb builder chaining before landing
it.

### Rule 46 — a grant is read PER PASS, under the lease that applies or publishes the answer

[POD-3365's recommendation, accepted by the coordinator 2026-09-04. Three marked sites: relay.ts (two)
and modules/accounts/native-login.ts (one).]

RULED: per pass. All grant-dependent checks within one pass use the snapshot taken under the lease that
applies or publishes the authorization result; the next pass re-reads.

WHY THIS DOES NOT WEAKEN ADR 9 D2 RULE 4, which is the whole question. That rule exists to answer one
named risk, stated in the ADR's own table: "grants frozen at ISSUE TIME survive the granter's
revocation." The mitigation is that grants evaluate LIVE. A per-pass snapshot is not the thing that
rule forbids — it is frozen for the milliseconds of one operation, not for the lifetime of an issued
credential. So this amendment says HOW live, not WHETHER.

WHAT PER PASS BUYS: one coherent linearization point for one externally observed answer. Under
per-decision, a single logical operation can authorize step A against the old grants and step B against
the new ones, and afterwards nobody can say which state the operation ran under. That is worse to
reason about than a snapshot with a stated boundary.

WHAT IT COSTS, stated so the trade is on the record: a revocation committed DURING a pass is not seen
by that pass. A revocation committed before the lease is acquired IS seen, and a later one governs the
next apply. Independent applies still take independent leases.

MECHANISM: B0.6's read scope already supports either shape — machine grant reads stay outside slots,
and a site may opt into one snapshot slot per pass. So this is a site opting in, not new machinery.

CARRY-OVER: the ADR 9 D2 rule 4 wording is amended by POD-3266, which already owns this epic's ADR
amendments. The three markers come off when the sites opt in; that is R3-side work, not Stage A's.

REVERSIBLE. If the operator prefers per-decision, keep those reads outside slots and name the amended
rule at each site — POD-3365 established that both shapes are supported, so this is a choice rather
than a constraint.
