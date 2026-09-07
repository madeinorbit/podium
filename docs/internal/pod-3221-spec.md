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

### Rule 51 — a SYNC CALLBACK PORT handed an async provider: decide by the CALLER, and here is the procedure

[Standing rule, 2026-09-05. `relay.ts` alone has ~92 of the flip's remaining errors and about 60 are
this one shape: `(userId) => Promise<boolean>` handed to a port typed `(userId) => boolean`. Rules 47
and 49 each answered one instance. This is the general procedure so the flip stops stalling once per
site.]

THE QUESTION IS NEVER "can I make the port async". It is: **may the CALLER yield at the moment it
invokes the callback?** Three answers, and the site tells you which:

1. **THE CALLER MAY YIELD** — it is already async, or is only reached from async paths. Then WIDEN THE
   PORT to return a promise and await it. This is the default and most sites are here. No permission
   needed.

2. **THE CALLER MAY NOT YIELD** — it runs inside a transport drain, a synchronous frame handler, a
   comparator, or anything §2.5 covers. Then the port STAYS SYNC and you move the await EARLIER:
   resolve the value at an async boundary that already precedes the call, and hand the callback a
   value or a resolved lookup rather than a promise. This is rule 47's shape, and rule 49's if the
   value can go stale in an unsafe direction.

3. **YOU CANNOT TELL.** Then it is a real boundary — mail me. But say which of the two you suspect
   and why; "I could not tell" without a hypothesis is not a question I can answer faster than you.

HOW TO TELL, mechanically, rather than by feel: walk up from the callback's invocation site. If every
frame to the nearest entry point is already `async`, you are in case 1. If you cross a drain loop, a
frame router, an event handler that returns void, or a comparator, you are in case 2. If the same
port is invoked from BOTH, that is case 3 and it is genuinely interesting — do not silently pick one.

WHAT YOU MAY NOT DO, in any case: make the non-yielding path yield, or paper over it by caching the
async result behind a sync reader without asking which way that cache drifts (rule 49). Those are the
two failure modes this rule exists to prevent.

### Rule 48b — the NO-THROW counterfactual keeps its matcher: `await expect(fn()).resolves.not.toThrow()`

[POD-3463 found the gap: rule 48a covers the positive rejection assertion and says nothing about
`.not.toThrow()`. 2026-09-05.]

    expect(() => fn()).not.toThrow()        becomes        await expect(fn()).resolves.not.toThrow()

That is `await` plus `.resolves`, with the MATCHER UNCHANGED, so it satisfies the mechanical rule
literally. Apply it wherever the callee went async; standing authorization, no need to ask.

I VERIFIED IT IS ARMED rather than assuming, because a no-throw assertion that cannot fail is worth
nothing: against a resolving promise it passes, and against a rejecting one it FAILS. Both directions
measured on this repo's vitest before this rule was written.

DO NOT COLLAPSE IT TO A BARE `await fn()`. An unhandled rejection does fail the test, so the coverage
is similar — but it deletes the `expect` and with it the test's statement of its own property, which
is more than `await`/`async`/rename and therefore outside the mechanical rule. These counterfactuals
exist precisely to say "this path stays alive"; a bare call says nothing, and the next person to touch
it cannot tell an intentional assertion from an incidental call.

KNOWN SITE TO REPAIR: `relay.test.ts`, "keeps registry boot alive when the recovery job throws",
where `expect(() => { registry = SessionRegistry.create(...) }).not.toThrow()` was collapsed to a bare
`registry = await SessionRegistry.create(...)` during the flip. Restore the matcher form.

### Rule 51a — case 3 resolved: move the await to the PRODUCER, never fire-and-forget from the handler

[First genuine rule 51 case 3, raised by POD-3263 on `SuperagentDefaultSeeder`, 2026-09-05. Its
`seed()` is invoked from an awaited boot path AND from the synchronous void-returning
`machine.metadataChanged` bus handler.]

THE ANSWER IS THE PRODUCER, and POD-3263's own instinct was right. Await the seed at the async
boundary that PRODUCES the event — `recordInventory`, which already writes and is already async —
rather than inside the subscriber. Every other subscriber then observes an already-seeded state,
failure surfaces on the write path instead of vanishing, and no non-yielding handler is made to yield.

TWO SHAPES REFUSED, and the second is the trap:

1. **Fire-and-forget from the handler** (`void seed()`), even with `seed` made async. It preserves
   non-blocking emission and loses everything else: the failure is unobserved, and nothing orders the
   seed against the next event. An unobserved rejection in an event handler is the silent-failure
   shape this epic has now been bitten by twice.

2. **Boot hydrate ALONE.** This one looks tidy and CONTRADICTS THE DOCUMENTED REASON THE HANDLER
   EXISTS. `relay.ts` says it in as many words: *"An inventory report is the ONLY moment new
   availability becomes known, and a daemon that connects minutes after boot is the ordinary case —
   so the seed runs on the report rather than once at startup."* Seeding only at boot silently drops
   every daemon that connects afterwards, which is the NORMAL case, not an edge one.

SO BOTH HALVES ARE REQUIRED: awaited at the producer for each inventory report, AND awaited once at
boot hydrate for the install whose daemon reported before this process started. The existing code has
exactly that pair for exactly that reason; keep the pair.

PRESERVE THE GUARD AND THE IDEMPOTENCE. The `inventory` flag exists so a rename or a machine-name
change does not re-run the seed, and the seed is idempotent because its guard reads the fields its own
write fills. Neither property may be lost in the move.

AND CHECK THE PROPERTY IS PINNED. If no test asserts that a daemon connecting AFTER boot gets seeded,
say so — that is the behaviour this whole shape exists to protect, and moving it without a test
watching is how it disappears in the next refactor.

### Rule 51b — case 2 may resolve LATER, not only earlier: a DEBOUNCER's boundary is its own timer

[Raised by POD-3468 on `IssueAssistantDigestModule.onSessionActivity`
(`apps/server/src/modules/issues/service/assistant.ts:40`), 2026-09-06. It classified the site as case
2 correctly and then concluded the await had to move UPSTREAM to a relay-owned producer, and so
proposed to leave the site untouched. The classification was right; the direction was not.]

CASE 2 SAYS "MOVE THE AWAIT OFF THE SYNCHRONOUS PATH". It does not say the only direction is earlier.
Later is equally valid whenever the path is ALREADY deferred and ALREADY best-effort — and a debouncer
is exactly that shape.

THE TEST for this variant, all three required:

1. The function has NO observable effect at call time — it schedules, it does not answer.
2. The deferred body is already fire-and-forget in the code as it stands (a `void ...catch(() => {})`
   inside a timer or a queue drain), so no NEW unobserved rejection is introduced.
3. The async read is needed only by the deferred body, not by the scheduling decision.

`onSessionActivity` passes all three: its four callers are void (the `issue.sessionDerived` bus handler
at `relay.ts:1553`, and `daemon-lifecycle.ts` at 263, 794 and 901), it arms a 120-second timer, and
that timer's body is already `void this.refreshAssistant(row.id).catch(() => {})`. The resolution moves
INTO the timer body. Nothing upstream changes and `relay.ts` is not touched — which matters during the
flip, because `relay.ts` is single-owner and every site pushed onto it serialises behind one worker.

WHAT THIS VARIANT COSTS, AND IT IS INVISIBLE. Deferring a resolution loses whatever the resolved value
was used for AT SCHEDULING TIME. Here the resolved value is the debounce KEY:

    this.assistantTimers.set(row.id, ...)   // row.id is the ISSUE, not the session

That key is the point of the function: a burst across N member sessions of ONE issue coalesces into ONE
digest — one LLM call. Defer the resolution naively and the timer keys by `sessionId` instead, so the
same burst arms N timers and fires N digests for one issue. N times the cost, and NOT ONE TEST FAILS,
because nothing asserts the call count.

SO THE RULE HAS AN OBLIGATION ATTACHED. Before deferring, name what the pre-resolution value was used
for — a key, a guard, an early return, an ordering — and say how it is preserved. State the
before/after count of the deferred effect for a burst that the coalescing exists to collapse. Equal
counts, or the site comes back to the coordinator.

GENERALLY: when case 2 has no earlier async boundary, look DOWNSTREAM before escalating. A scheduler, a
queue drain, a retry loop and a debouncer all have a later boundary that already tolerates an await,
and using it keeps the change inside one file instead of spreading it across an ownership line.

### Rule 51c — a provider that also MAINTAINS state cannot be snapshotted: split the ANSWER from the MAINTENANCE

[Raised by POD-3469 on the websocket credential path, 2026-09-06. It proposed the ordinary case-2 fix,
resolving credential validity once at the HTTP upgrade, then followed `auth-route.ts`, proved the fix
was NOT behaviour-preserving, and reverted it in `a381218b2` before anyone reviewed it. That is the
right order of operations and the reason this rule exists rather than a bug.]

WHY THE SNAPSHOT WAS WRONG. `maintainClientCredentialByHash` is not a query. Besides answering "is this
credential still valid", it RENEWS an active login or mobile session and touches mobile `lastSeenAt`.
Resolving it once at upgrade answers the question correctly and then never performs the maintenance
again — so a healthy long-lived socket dies at the 30-day expiry it should have been renewing all
along, and mobile activity tracking silently stops. The snapshot preserves the boolean and destroys the
side effect.

RULE 51'S DECISION PROCEDURE ASSUMES A PURE PROVIDER. Cases 1, 2 and 3 all ask only WHERE the await may
happen. That is a complete question when the async call is a read. When the provider also WRITES, moving
the await also moves WHEN the write happens — and a write that must RECUR cannot be hoisted to a
one-shot boundary at all. Neither earlier (51/case 2) nor later (51b) is available.

SO SPLIT THE TWO RESPONSIBILITIES, and keep both:

1. THE ANSWER the synchronous path consumes becomes a resolved value it can read without yielding —
   for the pong handler, a resolved validity. The port stays synchronous. Nothing on the frame or pong
   path yields.
2. THE MAINTENANCE moves to a serialized async producer on its own cadence — a heartbeat — which
   performs the renew and the touch and refreshes the resolved value the sync path reads.

Rule 51b's condition 2 does NOT apply here and POD-3469 was right to say so: the existing timer body was
synchronous, so there is no already-fire-and-forget deferred body to move the await into. 51b is for
deferring a resolution; this is for separating a read from a write.

NOW THE RULE 49 OBLIGATION, WHICH IS SHARPER HERE THAN ANYWHERE ELSE IN THIS EPIC. The resolved validity
is a cache on an AUTHENTICATION path, so ask which way it drifts. A stale "valid" keeps alive a socket
whose credential has been revoked. That permits MORE, and it is the unsafe direction. Therefore:

- The cached validity carries a BOUNDED staleness, and the bound is stated in the code, not implied by
  the heartbeat interval.
- If the heartbeat is OVERDUE — it failed, or was never scheduled — the answer is INVALID and the socket
  closes. Fail closed. An authentication cache whose refresher has died must not keep answering "yes".
- Explicit revocation invalidates IMMEDIATELY and does not wait for the next heartbeat. POD-3469's
  existing revoke producer already covers deletion; it does NOT cover renewal or touch, which is exactly
  why the maintenance half must survive as its own producer.

STATE THE INTERVAL, THE STALENESS BOUND AND THE OVERDUE BEHAVIOUR in the handoff. A credential cache
that outlives its refresher is a login that cannot be revoked.

GENERALLY: before applying rule 51 to any provider, ask whether it WRITES. If it does, 51's three cases
do not decide it — split the answer from the maintenance and apply 49 to whatever you cached.

### Rule 52 — PROMISE TRUTHINESS has unbounded spellings: the lint is a floor, not the guard

[Raised by POD-3263's `850b106ec`, 2026-09-06, and it is the seventh confirmed instance of this class
in this flip. The first six were `.filter`/`.find` callbacks and are caught by
`checkAsyncBooleanPredicate`. This one was not, because it wore a COMPARISON instead of a callback.]

THE SITE. `relay.ts` read:

    exclusiveOperationActive: () =>
      operations?.engine.active(LIFECYCLE_EXCLUSION_GROUP) !== undefined

`engine.active()` returns a promise now. A promise compared to `undefined` is a perfectly good
boolean — so this answered TRUE on every call, and NOTHING failed to typecheck.
`UpdatesService.setTarget` uses it to decide whether a newly published version lands or is queued
behind a running update, so EVERY publication was being queued as though an operation were
permanently in flight.

CORRECTION — THE COMPILER IS NOT SILENT ON ALL OF THESE. [POD-3483, 2026-09-06, verified by the
coordinator with a direct probe under this repo's tsgo.] TypeScript emits TS2801, "This condition will
always return true since this Promise<boolean> is always defined", and it ALREADY CATCHES five of the
eight spellings:

    if (p())            FLAGGED        !p()                silent
    p() ? a : b         FLAGGED        while (p())         silent
    p() && x            FLAGGED        for (; p(); )       silent
    x && p()            FLAGGED
    const v = p(); if (v)   FLAGGED

SO A GREEN TYPECHECK IS NOT WORTHLESS HERE, and the original wording of this rule wrongly implied it
was. What the compiler is genuinely blind to is `!p`, the loop conditions — and, decisively, THE UNION
PORT, because TS2801's premise is that the value is ALWAYS DEFINED and a `T | Promise<T>` is not.

THAT IS WHY BOTH LIVE DEFECTS SURVIVED. POD-3487's was `if (ceiling.canSee(...))`, a spelling TS2801
flags — it escaped only because the port was a union. POD-3488's was `!lease.renew()`, a spelling
TS2801 does not flag at all. The union defeats the compiler's own check, which is the strongest
argument yet for rule 52b.

AND THE TWO LIVE DEFECTS SIT ON OPPOSITE SIDES OF THE TS2801 LINE, which is why either one alone
would have taught the wrong lesson. POD-3487 was a spelling the compiler DOES flag, escaping only
through the union. POD-3488 was a spelling it NEVER flags. Read only the first and you conclude the
union is the whole problem; read only the second and you conclude the compiler is useless here. Both
together give the actual shape: the compiler covers most spellings, the union defeats it entirely, and
the negation and loop forms are unguarded regardless.

TWO CONSEQUENCES. TS2801 only protects a checkout whose typecheck is ALREADY GREEN, so it protects
nothing on a red slice mid-flip — which is exactly when this class is introduced. And the union port is
simultaneously the spelling the compiler cannot see and the one this epic keeps writing.

THE CLASS IS "A PROMISE USED AS A BOOLEAN", AND ITS SPELLINGS ARE UNBOUNDED:

    p !== undefined      p != null       Boolean(p)       if (p)
    p ? a : b            !p              p && q           while (p)
    arr.filter(async …)  arr.find(async …)  arr.some(async …)

`checkAsyncBooleanPredicate` catches only the last line. Do not read a clean lint as the absence of
this defect — the lint is a FLOOR. Catching the rest needs TYPE information, because syntax alone
cannot tell which expression is a promise; that is filed as POD-3483.

SO THE OBLIGATION IS ON THE AUTHOR, NOT THE TOOL. When you make a function async, walk EVERY call site
and ask what its result is used AS, not merely whether it still compiles. A result used as a boolean —
in a comparison, a condition, a ternary, a negation — is the dangerous case, and the compiler is silent
on all of them because every one is legal.

THE RUN OF CONSERVATIVE FAILURES IS A SAMPLING ARTEFACT, NOT A PROPERTY OF THE CLASS.
[POD-3467, 2026-09-06, correcting this rule's own framing.] All seven confirmed instances failed toward
a CONSERVATIVE branch — publications queued, digests coalesced, an operation treated as in flight — and
that is precisely why they survived unnoticed. It would be a mistake to read that as the class being
benign. It reflects only which sites happened to get converted naively first.

`anchorFor` in `scoping.ts` is the counter-example, and it is worth studying even though the defect was
never written: `currentValueOf` became async, and had the comparison been left inline,
`value !== undefined` would have been true on every call and every REVOKED subject would have been
re-admitted as an upsert carrying a promise as its wire value, instead of being evicted. There, truthy
is the PERMISSIVE direction. A revocation that does not revoke is a data leak, not a latency bug.

So WORK OUT THE DRIFT DIRECTION PER SITE. Ask what the comparison guards, not what the last six sites
happened to do. The next permissive one will not announce itself either.

AND NOTE WHICH WAY THE BUG WENT, because it is the reason this class is severe: the broken witness said
TRUE always, so the system took the CONSERVATIVE branch and queued everything. A promise is always
truthy, so this class fails toward whichever branch "truthy" selects — which may be the permissive one.
POD-3263's own analysis is the model: it refused to CACHE the witness because a cached answer drifts
toward a stale FALSE, and false is the permissive direction there.

THE POSITIVE RULE: never leave a possibly-async expression in a boolean position. Resolve it first and
compare the resolved value.

### Rule 53 — an ADDED await can DEADLOCK a test whose subject is CONCURRENCY, and it reads as slowness

[Raised by POD-3263 on `updates/service.test.ts`, 2026-09-06. Rule 48a warns that a MISSING await is
silent. This is the opposite failure and it is worse, because it does not present as a failure at all.]

THE SHAPE. A mechanical await pass wrote

    const tick = await svc.refreshTarget(…)

in three refresh-coalescing tests whose WHOLE POINT is that two calls are in flight TOGETHER, with the
resolver released by a `finish()` further down the test body. Awaiting the first call means `finish()`
is never reached, so the test DEADLOCKS and dies on the 20-second timeout. A fourth test had

    await Promise.all([await a, await b])

which serialises the two calls and defeats the `Promise.all` it is written around.

WHY IT IS DANGEROUS: a deadlock presents as a TIMEOUT, and a timeout reads as "this test is slow" or
"the box is loaded" — especially on a shared machine, and especially while the disk is full and ENOSPC
is producing 20-second timeouts of its own. Three separate causes converge on the same symptom.

THE RULE. Before adding an await inside a test, ask WHAT THE TEST IS ABOUT. If its subject is
concurrency — coalescing, single-flight, debouncing, racing, ordering, "both in flight at once" — then
awaiting each call individually destroys the thing under test. Keep the calls unawaited, collect the
promises, release the resolver, and await the collection:

    const a = svc.refreshTarget(…)      // NOT awaited
    const b = svc.refreshTarget(…)      // NOT awaited
    finish()                            // now reachable
    const [ra, rb] = await Promise.all([a, b])

NEVER write `Promise.all([await a, await b])`. It type-checks, it passes, and it tests nothing the
`Promise.all` was there to test.

AND WHEN A TEST TIMES OUT DURING THIS FLIP, ENUMERATE THE THREE CAUSES BEFORE DEBUGGING THE SUBJECT:
a deadlock you introduced, ENOSPC (`df -h /`), or a genuinely slow test. They are indistinguishable
from the symptom alone.

### Rule 52a — WIDEN THE PORT IN THE SAME PASS: a sync port fed by an async provider is the only window where promise-truthiness is silent

[POD-3469 audited rule 52 across its slice and returned a refinement that changes the instruction,
2026-09-06. It is right, and it converts rule 52 from a warning into a procedure.]

RULE 52's OWN EXAMPLE IS LOUD ON POD-3469'S BRANCH. The same two sites —

    relay.ts:784  operations?.engine.active(LIFECYCLE_EXCLUSION_GROUP) !== undefined
    relay.ts:789  exclusiveUpdateVersion(operations?.engine.active(…), channel)

— are compiler ERRORS there (TS2322 at 783, TS2322 at 788, TS2345 at 789), not silent ones. The
difference is that POD-3469 had already WIDENED THE PORT to `Promise<boolean>` and
`Promise<string | undefined>`. Once the port says `Promise`, a synchronous arrow whose body compares a
promise to `undefined` no longer satisfies it, and the compiler names the line.

SO THE SILENCE WAS NEVER A PROPERTY OF THE EXPRESSION. It was a property of the PORT still being sync
while the provider went async. That is the entire window in which this class hides, and it is a window
YOU CONTROL.

THE PROCEDURE, and it is now mandatory: WIDEN THE PORT IN THE SAME PASS AS THE PROVIDER. Never leave a
sync-typed port fed by an async provider, even briefly, even "just until the next commit". Widen it and
the compiler enumerates every bad call site for you, for free, by name and line.

The same effect is visible elsewhere: `feed-visibility.ts:381` reports a `Promise<boolean>` provider
against a sync `mayRead` port as a plain type error. SYNC PORT PLUS ASYNC PROVIDER IS LOUD. What stays
silent is only the residue — where the port is legal at both ends and the promise sits inside an
expression whose own inferred type is still boolean.

AND A NEGATIVE RESULT WORTH HAVING, so nobody repeats it. POD-3469 tried a repo-wide TEXTUAL scan for
promise-in-boolean: derive every async name, flag un-awaited uses in conditions, negations, logical
operators, nullish comparisons and ternaries. It produced 873 findings and essentially all were NAME
COLLISIONS — `has`, `get`, `state`, `capabilities`, `isFile`, `join`, `canSee`, `runs` are async
somewhere and sync where they are used. Name matching cannot decide this. POD-3483's type-aware check
is genuinely required; do not attempt a grep substitute.

WHAT DOES WORK WITHOUT TYPES is exhausting ONE confirmed-async function: POD-3469 checked every
`engine.active(` call site in the repo and found only the two above. Note `relay.ts:2742` reads wrong at
a glance and is FINE — `await` binds tighter than `!==`.

### Rule 54 — AWAITING CORRECTLY IS NOT THE SAME AS BEING SAFE TO AWAIT: check-then-act across a new await

[POD-3469, 2026-09-06, measured on POD-3263's tip. It had previously certified that same code CLEAN for
rule 52 — and it was: every call awaits properly, no promise sits in a boolean. This is a different
defect entirely, and it appeared only when it probed for CONCURRENCY rather than reading for truthiness.]

THE CLASS. Adding an await between a CHECK and the ACT it guards turns a previously atomic sequence
into a race. The code is correct as written and correct as read; what changed is that the function now
yields in the middle, so a second entrant can pass the same check before the first has acted.

MEASURED, not argued — the same byte-identical test on both trees:

    POD-3263 tip 46e2975c1   attachDaemon called 2 TIMES   FAIL
    POD-3469 branch          attachDaemon called 1 time    pass

Two hello frames delivered in ONE tick admit the daemon TWICE. Verified in
`packages/protocol/src/handshake/acceptor.ts`:

    :156   if (state === 'established') …          CHECK — refuses a second hello
    :218   const outcome = await strategy.authenticate({…})   YIELD
    :242   state = 'established'                   ACT — too late

`daemon-socket.ts` repeats it one level up: `if (principal === undefined)` → `await
receiveDaemonFrame` → `principal = outcome.principal`. The handler is async and nothing serializes it.

IT IS REACHABLE BY THE PEER. An attacker writes two hellos back to back and controls whether they land
in one read. Beyond the double admission it permits concurrent unbounded credential lookups on a socket
that has not authenticated.

WHY NO TEST SAW IT, and this is the reusable part: the existing case, "refuses a second handshake on a
live connection", AWAITS its first hello before sending the second. It is SEQUENTIAL BY CONSTRUCTION,
so it cannot express two frames in flight, and it passes on both shapes. The assertion was never wrong.
The DELIVERY could not see the bug. Same shape as a vacuous fail-closed test: check what the harness is
capable of expressing before trusting what it reports.

THE OBLIGATION. Every time you add an await to a function that GUARDS something — an admission, a
single-flight, a "have we already done this", a cache fill, a lock acquisition — find the check it sits
between and ask what happens if a second caller arrives during the yield. Then WRITE THE TEST THAT
DELIVERS TWO IN ONE TICK, without awaiting the first. If your existing test awaits between the two, it
is testing sequence, not concurrency, and it will pass either way.

THE FIX IS NOT A CAP. Bounding a queue limits how much can pile up; it does not make the admission
single-flight. Either mark the connection as in-progress SYNCHRONOUSLY before the first await, or
serialize entry at the boundary (POD-3469's `preAuthSerial` chain). It mutation-checked that its own
guard is load-bearing: replacing `preAuthSerial` with `Promise.resolve()` reproduces "called 2 times"
exactly.

### Rule 52b — WIDEN TO `Promise<T>`, NOT TO `T | Promise<T>`: a union port manufactures the blind spot

[POD-3484, 2026-09-06, correcting rule 52a with a live example. 52a says widening the port in the same
pass makes the class loud. That is true only for one of the two ways to widen.]

RULE 52a IS RIGHT ABOUT `Promise<T>` AND WRONG ABOUT UNIONS. `apps/server/src/modules/updates/operation.ts`
declares

    stepActive?: (operationId: string, stepId: string) => boolean | Promise<boolean>

That port WAS widened in the same pass as its provider, exactly as 52a demands. The bad call site
thirty lines below still typechecks clean, zero errors in the file:

    until: () => !(context.stepActive?.(operation.id, UPDATE_STEP_WEB) ?? true)

The arrow returns `boolean`, which satisfies the union, so nothing is loud. The promise sits inside an
expression whose own inferred type is still boolean — the exact residue rule 52 describes. THE EFFECT
WAS REAL: the web-rebuild watcher never stopped, which is the POD-2173 leak the fence exists to close.

A UNION PORT IS A MACHINE FOR MANUFACTURING THAT RESIDUE, because it makes the synchronous spelling
legal at both ends BY CONSTRUCTION. `Promise<T>` refuses the sync arrow and the compiler enumerates the
sites; `T | Promise<T>` accepts it and says nothing. The whole leverage of 52a comes from the port
REFUSING something, and a union refuses nothing.

SO THE PROCEDURE IS: widen to `Promise<T>`. Do not reach for the union because it makes the diff
smaller — it makes the diff smaller precisely by not forcing the call sites you need forced.

IF A UNION IS GENUINELY REQUIRED because some implementations must stay synchronous, then declare it a
KNOWN BLIND SPOT: list the port in the handoff, read every call site by hand, and say you did. A union
port is the one place where "the typecheck is clean" carries no information about this class.

AND A UNION IS SOMETIMES A DELIBERATE STOP-SHORT, WHICH MUST ALSO BE DECLARED. POD-3469 widened
`UpdatesDeps.onTargetChanged` to `void | Promise<void>` rather than `Promise<void>` because tightening
it would flag `relay.ts:790` — a FENCED file it was not allowed to edit. That was the right call at the
time and the wrong thing to leave silent. If a fence, not a design need, is what stopped you, say so:
name the port, name the site outside your fence, and file the remainder. Otherwise the next reader
cannot tell a considered union from an unfinished one.

NOTE WHAT THE `void` SLOT WAS DOING BEFORE ANY OF THIS. At the merge-base the port was declared plain
`void` while the provider already returned `Promise<void>`, and ALL THREE call sites were un-awaited. A
`void`-returning slot ACCEPTS a promise-returning function — the same assignability rule behind the
floating-promise hazard in the merge steps — so the float pre-dated the flip entirely and was invisible
in the type. Widening to a union is therefore an IMPROVEMENT on `void`: it makes the asyncness visible
and awaits what can be awaited. The ranking is `Promise<T>` best, union second, bare `void` worst.

THIS ALSO BOUNDS RULE 51. When rule 51 case 1 says "widen the port and await", it means widen to
`Promise<T>`. A case-1 conversion that produces a union has not been done.

NARROWING PROTECTS THE IMPLEMENTATION SIDE, NOT THE CALLER SIDE — I overstated this, and POD-3488
is the demonstration. Narrowing `renew?: () => boolean | Promise<boolean>` to `() => Promise<boolean>`
stops an IMPLEMENTATION supplying a synchronous function. It does NOT stop a CALLER writing

    if (!this.renewResourceLease(lease))          // Promise<boolean>, negated

because negating a promise is legal at any type. Verified: removing the `await` from all three call
sites typechecks at ZERO errors and breaks no test.

So a narrowed port is necessary and NOT sufficient. The caller side needs a TEST — one that fails when
the await is removed. Rule 52b buys you the compiler at the assignment; only a test buys you the
compiler's absence at the negation.

THE BAN IS ON PORTS, NOT ON THE TOKEN. [POD-3469, 2026-09-06, and this qualification is load-bearing —
without it someone "fixing" a union will destroy a design this epic deliberately chose.] A union is
acceptable as an IMPLEMENTATION SIGNATURE behind overloads that discriminate on argument type, because
TypeScript does not expose the implementation signature to callers:

    export function receiveDaemonFrame(a: HandshakeAcceptor, raw: string): DaemonFrameOutcome
    export function receiveDaemonFrame(a: PreparedDaemonAcceptor, raw: string): Promise<DaemonFrameOutcome>
    export function receiveDaemonFrame(a: HandshakeAcceptor | PreparedDaemonAcceptor, raw: string):
      DaemonFrameOutcome | Promise<DaemonFrameOutcome> { … }

Each caller matches ONE overload, decided statically by which acceptor it holds, and gets a single
concrete type. POD-3469 PROVED a caller cannot obtain the union: assigning
`receiveDaemonFrame(prepared, …)` into a `DaemonFrameOutcome` slot is refused with TS2322. This is in
fact the STRONGEST available shape here, because the caller cannot get the wrong one.

THE TEST IS NOT THE SPELLING, IT IS WHETHER A CALLER CAN OBTAIN THE UNION. A port hands the union to
every caller and the sync spelling stays legal at both ends — banned. An implementation signature
behind discriminating overloads hands the union to nobody — allowed, if you can demonstrate it. If you
cannot demonstrate it, treat it as a port.

Collapsing those overloads into one async function would take the synchronous acceptor path with it —
the very path the gateway ruling in the merge steps exists to protect.

### Rule 55 — SPREADING a value that might be a promise: narrowing is right and NOT sufficient

[POD-3499 found it at `shipping/service.test.ts:535`, generalised it wrongly, corrected itself when
challenged, and supplied a four-case discriminator. The coordinator reproduced all four under this
repo's tsgo. Both of us were wrong first; the measured version is below.]

THE SITE. A test resolver overriding one field of an async provider's result:

    const policy: ShippingPolicyResolver = {
      resolve: (issue) => ({ ...compatibility.resolve(issue), evidenceOptional: false }),
    }

`compatibility.resolve` is async, so the spread is OF A PROMISE. A promise has no own enumerable
properties, so the object arrives with NOTHING from the provider — here, no `validationProfile` at all.
It typechecks.

WHY IT TYPECHECKS, measured — spreading `Promise<Policy>` where `Policy` has a required property:

    const one:   Promise<Policy>       = { ...resolveAsync(), evidenceOptional: false }   TS2353 FLAGGED
    const two:   Promise<Policy>       = { ...resolveAsync() }                            silent
    const three: () => Promise<Policy> = () => ({ ...resolveAsync(), evidenceOptional: false })   silent
    const four:  () => Promise<Policy> = (): Promise<Policy> => ({ ... })                 TS2353 FLAGGED

ONLY EXCESS PROPERTY CHECKING CATCHES THIS, and it fires only while the object literal is still FRESH —
checked directly against an annotation. Case 3 is a port implementation written the ordinary way, with
no return annotation: freshness is lost before the assignability check, and the spread of a promise
carries `then`, `catch`, `finally` and `Symbol.toStringTag`, so it structurally IS a `Promise<Policy>`
and passes.

THE DISCRIMINATOR IS INFERRED-VERSUS-ANNOTATED RETURN, NOT THE UNION. This matters because the obvious
conclusion is wrong: `Promise<T>` hides it just as well as `T | Promise<T>` in the position that
actually occurs. So NARROWING PER RULE 52b IS STILL RIGHT — it is simply not sufficient here. POD-3499
verified that on the real code: after widening `resolve` to `Promise<ResolvedShippingPolicy>`, the bad
stub still typechecked clean, and only a runtime failure revealed it.

AND THE TRUTHINESS CHECKER CORRECTLY DOES NOT SEE IT. The value is never read as a boolean; it has the
RIGHT TYPE and the WRONG RUNTIME CONTENTS. No type-directed instrument can be expected to find that.

THE INSTRUMENT IS A TEST: assert that a required field SURVIVES the spread. A fixture that overrides one
field of a provider's result must be checked for the fields it did not override, or it is asserting
against an empty object and passing.

CHEAP DEFENCE WHERE YOU CONTROL THE CODE: annotate the return type of port implementations. Case 4 shows
the annotation restores the check for free.

### Rule 50 — when a mechanism is deleted, MECHANISM assertions die with it and BEHAVIOUR assertions transfer

[Standing rule, 2026-09-05. POD-3263 has hit this shape four times — the thenable refusal,
`transaction-spec.ts`, the savepoint-hijack case, and now `synchronous-span.test.ts`'s orphaned
`expect(reported).toEqual([])`. Every answer has been the same; make it a rule so the flip stops
round-tripping through me.]

SORT EVERY ASSERTION IN A DELETED MECHANISM'S TEST INTO ONE OF TWO PILES:

- **MECHANISM** — it names the implementation, or observes ABSENCE from a registry/namespace/counter
  that the deletion removes. `expect(reported).toEqual([])` against a deleted sink registry;
  assertions naming `podium_sp_<depth>` or the `depths` WeakMap. These DIE with the construct. Keeping
  one is worse than deleting it: it either fails to compile, or passes because nothing can populate
  the thing it inspects, which is a green that means nothing.
- **BEHAVIOUR** — it observes what a CALLER can see, and would still make sense written against the
  replacement. `expect(ran).toEqual(['now'])`; the throw propagating rather than being swallowed;
  rolling back only the inner savepoint; nothing appended after a failed write. These TRANSFER, and
  they transfer VERBATIM to wherever the behaviour now lives.

YOU MAY APPLY THIS WITHOUT ASKING. Report the split in the handoff — which assertions you dropped as
mechanism, which you carried, and where the carried ones landed.

THE ONE THING THAT IS NOT OPTIONAL: after removing a mechanism assertion, PROVE THE SURVIVORS ARE
STILL ARMED. Break each remaining assertion's subject and watch it red by name. The risk is that the
deleted assertion was the one doing the discriminating and the survivors pass regardless — which is
how a suite gets greener while testing less, and that is precisely the shape of this epic's two
critical findings.

STOP AND ASK ONLY IF the behaviour pile is EMPTY — a test all of whose assertions were mechanism means
the deletion removed a property nobody is checking any more, and I want to know that rather than have
it silently disappear.

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

### Rule 56 — a port declared `void` HIDES an async implementation completely: widen it, or nothing will ever see it

Rule 52a said widen the port because a sync port is the window where promise-truthiness is silent.
This is the harder version of that, found live on the integration tip at **0 apps/server errors**.

A port declared to return `void`:

```ts
requireMachineForRepo?(machineId: MachineId, repoPath: string): void
```

wired in production to an async implementation:

```ts
requireMachineForRepo: async (machineId, repoPath) => …
```

is **legal TypeScript**. Assigning `(args) => Promise<void>` to `(args) => void` is a deliberate,
long-standing allowance — the return value is being discarded, and discarding is what `void` means.
So the compiler says nothing, at any strictness. And because no call site ever READS the returned
value, `TS2801`, `lint:promise-truthiness` and `check-boundaries`' async-boolean-predicate rule are
all silent too. Every instrument this epic built is blind to this shape.

**WHY IT IS WORSE THAN A UNION PORT.** Rule 52b's complaint about `T | Promise<T>` was that it
manufactures a blind spot. A `void` port does not manufacture one — it *is* one, and it is invisible
in both directions: the implementer sees a port that wants nothing back and writes `async` freely;
the caller sees a port that returns nothing and correctly does not await. Neither is wrong locally.
The defect exists only in the pair, and only a human reading the declaration against its wiring
finds it.

**THE CONSEQUENCE HAS A NAME.** When the `void` port is a GUARD, the unawaited call cannot refuse.
Its rejection becomes an unhandled rejection on some later tick, and the caller has already proceeded
on the assumption that the guard passed. This is the third time this epic has produced that exact
shape — the mail ceiling (POD-3487), the union port (rule 52b), and now `requireMachineForRepo` and
`requireIssueHomeMachine` (POD-3500), whose own doc comment says it must be "still able to say NO".
When it is a WRITE, as with `setParentForUpdate`, the caller is told the write happened and it has not.

**THE PROCEDURE.** Rule 51 case 1 applies, but the ORDER is not optional:

1. Widen the port to `Promise<void>` (rule 52b: `Promise<T>`, never a union).
2. Let the compiler name the call sites.
3. Await them.

Never add the await first. An await under a `void` port typechecks identically with or without it,
so it is invisible to the next reader and the compiler will not keep it — a later edit removes it
silently. Widening is what makes the fix load-bearing.

**FINDING THE REST.** These do not surface from any existing check, so the search is a derived set,
not a grep for `await`: enumerate every port member declared `: void` (or `=> void`), resolve each to
its wired implementation, and flag every pair where the implementation is `async` or returns a
thenable. That census is the deliverable, not a fix list — a `void` port that is *correctly* sync
today is one refactor away from this bug, and the census is what tells you where to look next time.

**BREAK-TESTING A GUARD OF THIS SHAPE.** "A test goes red" is not evidence here, because before the
fix the test passes for the wrong reason — nobody waited, so nobody saw the refusal. The isolating
probe is: make the wired implementation REJECT, and show a named test failing with **the guard's own
refusal message**. A kill that reports a timeout, an unhandled rejection, or a generic assertion is
not the same claim (mutation: read the reason code, not the red).

### Rule 56a — CORRECTION to 56: on the control arm the guard's own message CANNOT appear

Rule 56 ends by demanding that a guard's break-test fail with **the guard's own refusal
message**, and calls a generic assertion "not the same claim". POD-3500 applied the rule and
found that clause is impossible to satisfy as written. It is right, and this is the amendment.

On the control arm the guard **never refuses** — that is the whole defect. So its message
cannot appear there, and every honest control-arm failure reads as the generic

```
AssertionError: promise resolved "{ …(45) }" instead of rejecting
```

Verified independently at landing: dropping the await at `workflow.ts:394` kills exactly
`start: a REJECTING requireMachineForRepo refuses the start` and nothing else, with that
generic message; dropping it at `crud.ts:1159` kills exactly the containment-cycle test and
additionally surfaces an **Unhandled Rejection**, which is the production symptom — the
refusal escaping onto a later tick after `update()` already returned its wire.

**THE DISCRIMINATION IS PROVED FROM THE OTHER SIDE.** Keep the fix, and mutate the injected
double to reject with an *unrelated* message. A test that merely awaits now still passes; a
test that pins the refusal fails naming the pattern it requires:

```
expected [Function] to throw error matching /machine 'laptop' is offline/
  but got 'PROBE: some other error entirely'
```

So the pair is: the control arm proves the await is load-bearing, and the message-pinning
mutation proves the test is asserting the right refusal rather than any rejection. Neither
alone is sufficient — a test that awaits but accepts any rejection passes both the fixed and
a wrongly-guarded implementation.

A refusal raised in production code rather than by a double (POD-3500's seventh test asserts
`/would create a containment cycle/`, thrown at `hierarchy.ts:94`) is pinned by construction:
no double can fake it, so the message mutation does not apply and the control arm is enough.

**AND THE PORT ITSELF NEEDS ITS OWN MUTATION.** Reverting `requireMachineForRepo` from
`Promise<void>` back to `void` at `types.ts:238`, with all six awaits left in place, produces
**zero typecheck errors**. The awaits survive under the narrow port and nothing enforces them,
which is rule 56's claim demonstrated rather than argued: the widening is the load-bearing
half, and a reviewer who mutates only the call sites has not tested the fix.

**ASYNC-UNDER-VOID IS NECESSARY BUT NOT SUFFICIENT.** POD-3500's census of the same interface
found eight more bare-`void` ports and cleared all eight. One is genuinely async — `relay.ts`'s
`stopClosedIssue` — but its body is `void stopClosedIssueNow(…).catch(log.warn)`, a deliberate
fire-and-forget that can never reject. Widening it would assert that the caller waits for a
stop it deliberately does not. The test for a site is not "is the implementation async" but
**can the promise reject, or carry a result the caller needs**. Two others reach `EventBus.emit`,
which is `: void` and isolates listener rejections itself.

### Rule 57 — the FOURTH class: an added await at a DELIBERATELY fire-and-forget site

Rules 52, 55 and 56 each describe a promise the compiler cannot see. This one is the
opposite mistake and the **dual of rule 53**: not a missing await, but an await added where
the previous author had deliberately declined to wait. It typechecks clean, reads as a
correctness improvement, and in the one confirmed instance it **wedges the write lane
permanently**.

**THE INSTANCE.** The flip commit `9f0d5c33e` changed `retire(runner)` to
`await retire(runner)` in `executor.ts`'s `transact` (now the `finally` at line 701). That
`finally` runs INSIDE `scheduler.run('write', …)`, so the single write slot is held while
`retire` awaits `effectsSettled()`. An external effect that issues a root store write routes
through `ambientRouter` to `scheduler.run` and queues behind the very slot `retire` is
holding. `retire` waits for the effect; the effect waits for the slot; there is no timeout
anywhere. Even without the cycle it serialises the write lane behind every slow socket.

**IT CONTRADICTS THE FILE'S OWN STATED CONTRACT.** `post-commit.ts` lines 21-24 say the
promise `transact` returns "resolves after the COMMIT, after every commit application, and
after every durable follow-up … **It does not wait for external effects.**" The await made it
wait for external effects. As with rule 56's `sync-drizzle.ts`, the code had come to
contradict a comment that was still correct.

**WHY NO INSTRUMENT CAUGHT IT.** Adding an await to a call that returns a promise is always
type-correct, so nothing static can object. And the test that detects it —
`executor.test.ts`'s "sends a late external effect to the root, not to its released lease" —
is BYTE-IDENTICAL before and after the flip and passed before it. The regression is invisible
in the diff of the test file, which is why it survived review: a reviewer diffing tests sees
nothing, and a reviewer diffing source sees an await being added, which looks like a fix.

**THE GENERAL SHAPE.** A mechanical await pass cannot distinguish a *forgotten* await from a
*declined* one, because in source they are the same absence. The information lives only in
the author's intent, and if it is not written down the next pass destroys it.

**THE REMEDY, and it is a requirement for the rest of this epic.** A deliberate
fire-and-forget must be spelled so that it cannot be read as an oversight:

```ts
void retire(runner)   // NOT awaited: see post-commit.ts's waiting rule
```

The `void` operator plus a comment naming the contract it is honouring. Any await pass that
meets a bare `void`-prefixed call must leave it alone and report it, never convert it.
Sites already converted must be audited against this rule rather than assumed correct —
POD-3506 found one; the pass ran over hundreds.

**THE SEARCH IS FOR DECLINED AWAITS, NOT MISSING ONES**, so it inverts every technique used
so far: instead of asking which call sites drop a promise, ask which awaits the flip ADDED,
and for each, whether anything downstream of it is now waited for that previously was not.
`git log -S` over the flip's commits against the deferral primitives (`retire`, effect
registration, the post-commit drain) is the cheap first pass.

**LANDING RULE while this is open:** nothing that adds or reorders post-commit effects lands
until POD-3506's fix does. A second site of this class would compound into a deadlock nobody
can attribute.

### Rule 48c — the preamble's "no assertion changes" bar does NOT cover the 48a conversion

POD-3499 flagged that commit `94a0be79b` converted an existing assertion —

```ts
expect(() => …).toThrow(ShippingOrderAccessError)
await expect(…).rejects.toThrow(ShippingOrderAccessError)
```

— and that the worker preamble says a conversion commit may not modify an existing test
assertion. It was right to flag it, and the conversion was right to make. The two rules
were in genuine conflict and this settles it.

**THE BAR EXISTS TO STOP A CONVERSION FROM MOVING THE GOALPOSTS**: weakening a matcher,
loosening an expected value, or deleting a case that the new code no longer satisfies.
Rule 48a's sync-to-`rejects` spelling does none of those. The error type and the
triggering condition transfer verbatim; only sync-throw versus rejection changes, and
that change is forced by the subject having become async. Refusing it would mean deleting
the test instead, which is strictly worse.

**SO THE BAR IS ON THE CLAIM, NOT THE CHARACTERS.** An assertion may be re-spelled when
the subject's mechanism changed under it and the claim is identical; it may not be
re-aimed. The test is whether you can state the assertion in prose and have the sentence
come out the same on both sides. "Refuses a nested issue with `ShippingOrderAccessError`"
is the same sentence before and after; "no longer throws" is not.

**AND IT MUST BE REPORTED, NOT ABSORBED.** Rule 50 already asks for the mechanism/behaviour
split; this adds that a 48a re-spelling is listed in the handoff with the before and after
text, so a reviewer can check the sentence for themselves rather than trusting that it was
checked. POD-3499 did exactly that and it is why the conflict surfaced at all.

### Rule 58 — the FIFTH class: a Promise baked into a DECLARED type

Found by V5 in the flip review, and it is the first of these classes where **nothing flows
wrong at all**. The declaration itself is wrong.

```ts
output: ReturnType<(typeof WORKFLOW_COMMANDS)[N]['handler']>        // WRONG
output: Awaited<ReturnType<(typeof SUPERAGENT_COMMANDS)[N]['handler']>>  // every sibling
```

Once the handler became `async`, `ReturnType<>` of it *is* `Promise<T>`. The tRPC output
type therefore declares a promise, and the server is perfectly consistent with itself: the
handler returns a promise, the declared output says promise, nothing is misused. Three
sites had it — `modules/workflows/trpc.ts:93` and `:125`, `modules/automations/trpc.ts:86` —
against the `Awaited<>` spelling every other module already used.

**WHY NO INSTRUMENT SEES IT.** TS2801, `lint:promise-truthiness` and the boundary lint all
look for a promise being *read* as something it is not. Here no value is read wrongly. The
type is simply declared one level off, and inside `apps/server` that is internally
coherent. The compiler has nothing to object to.

**IT SURFACES ONLY IN A CONSUMER, ONE PACKAGE AWAY:**

```
apps/web  src/features/workflows/use-workflows.ts(163,68): error TS2345
  Argument of type 'Promise<{ workflow: {...}; revisions: {...}[] }>' is not assignable
  to parameter of type 'SetStateAction<{...} | null>'
```

So the defect lives in `apps/server` and the red appears in `apps/web` — and this epic's
headline number is *apps/server typechecks at 0*. Both statements were true at once for the
whole flip.

**AND THE GATE COULD NOT HAVE TOLD YOU.** `bun run typecheck` fail-fasts at `apps/daemon`
and reports 22 of 26 projects, so it reached neither `apps/web` nor `@podium/scripts`. That
is the same truncation that hid POD-3508's 93 errors. **A per-project census, with turbo
bypassed, is the only thing that finds this class** — filed as POD-3516, with POD-3517 for
the gate itself.

**THE SEARCH.** Grep for `ReturnType<` not preceded by `Awaited<` across every type-level
position, then check each against how its siblings spell it. Inconsistency between sibling
modules is the tell, because the correct spelling was already the majority here — three
sites were wrong out of a dozen. Where a codebase is uniformly wrong there is no tell at
all, which is why the per-project census matters more than the grep.

**THE GENERAL LESSON, and it is the one to carry into R4.** Every class from 52b onward has
been a promise that some *declaration* made invisible: a union port, an inferred return, a
`void` port, and now a missing `Awaited<>`. The compiler is only ever as good as what it was
told. A sixth shape found the same night makes the point bluntly — `session-wiring.ts:87` is
`const bag = life as any`, and all thirteen store calls beneath it are unchecked by
construction, unawaited, against methods that are all async, with `apps/server` still
reporting zero. **Treat every escape hatch as a hole in every gate downstream of it**, and
audit what is under one before trusting a green.

### Rule 59 — the SEVENTH class: an await that changes EVALUATION ORDER, not correctness

```ts
await Promise.all([f(), f(), f()])          // concurrent — three calls in flight
await Promise.all([await f(), await f(), await f()])   // SEQUENTIAL — one at a time
```

An `await` inside an array literal is evaluated **before the next element is constructed**, so
each call completes before the next begins. `Promise.all` then receives three already-settled
values and has nothing to interleave. The expression still typechecks, still returns the same
values, and still *reads* as a correct await — the flip commit `9f0d5c33e` made this edit
across sibling test files and no review caught it.

**IT IS NOT RULE 57 AND NOT A MISSING AWAIT.** Rule 57 is about a *declined* await at a site.
This await is neither forgotten nor declined: it is locally harmless and changes the semantics
of the **enclosing expression**. The tell is not the call site — it is the `Promise.all` two
lines up. A reviewer diffing source sees a correct-looking await; a reviewer diffing tests sees
a correct-looking await. Only reading the enclosing expression shows it.

**THE DAMAGE IS WORST WHERE IT IS SILENT.** POD-3501 measured three outcomes:

| file | result |
|---|---|
| `model-catalog.test.ts` | RED — 2 failures, one a **20s timeout**: a gated concurrent test cannot progress once sequentialised |
| `oracle-handoff.test.ts` | RED |
| `updates/operation.test.ts` | **GREEN — and this is the dangerous one** |

`operation.test.ts` passes because, run sequentially, the second start still hits the
already-running branch. So the assertion holds. What it no longer covers is **the race it is
named for**, and no red run will ever surface that. A concurrency test that was quietly
converted into a sequential one is worse than a deleted test, because it still reports success.

**THE DERIVED SET, not a hand list.** Nine sites remain on the tip (coordinator-derived by
matching `Promise.all(` array literals containing `await`):

```
apps/server/src/model-catalog.test.ts:106            modules/operations/engine.test.ts:260
apps/server/src/migrations/snapshot-verifier.test.ts:431   modules/shipping/service.test.ts:392
apps/server/src/gateway/wire-window.integration.test.ts:174 modules/updates/dev-web-build.test.ts:250
modules/updates/service.test.ts:1234                 modules/updates/head-sha-cache.test.ts:223
modules/updates/operation.test.ts:1492
```

`issues.test.ts:4629` was the same defect and is already repaired — POD-3468 spotted it as
"inner awaits that accidentally serialized the single-flight counterfactual", which is the
same finding arrived at independently, months of context apart. That it was found twice by
accident and never by a gate is the argument for the lint.

**THE FIX IS TO DELETE THE AWAITS**, not to add anything. `Promise.all` already awaits.

**AND IT MUST BE PROVEN PER TEST.** Removing the awaits turns red files green, which looks like
success — but for a file that was GREEN throughout, the only evidence that the concurrency is
back is a mutation that could not have failed before: make the two operations genuinely
overlap and show the test distinguishes that from the sequential case. Otherwise you have
restored the shape without restoring the coverage.

**THE INSTRUMENT.** This is mechanically detectable — an `await` in an argument-list array
literal passed to `Promise.all`, `Promise.allSettled`, `Promise.race` or `Promise.any` — and
belongs in `check-boundaries.ts` beside the async-boolean-predicate rule, so it cannot recur.

### Rule 58a — an escape hatch does not only HIDE defects, it MANUFACTURES findings

Rule 58 closes by saying to treat every escape hatch as a hole in every gate downstream of
it. POD-3508 found the sharper and more dangerous half, and it nearly filed the false
report itself.

`scripts/audit-scoped-feed.ts` drives the sync kernel through `as never` casts, so tsgo is
blind to that whole seam. The flip dropped four awaits behind it — `authority.capture`,
`authority.changesSince`, `publisher.publish`, `connection.drain`. The audit then reported
**three confident findings against a healthy `packages/sync`**:

> "the grantee did NOT receive a row she may see"
> "a permanent invisible gap that heal-loops forever"

Both are artefacts of the audit's own driver. Awaiting the four takes that file from three
failures to green, and `packages/sync` was never wrong.

**SO AN UNCHECKED SEAM INVERTS THE USUAL RISK.** The classes before this one cost us
defects that no gate could see. This one costs us *investigations into code that is fine* —
and it is worse, because a red finding is acted on. Someone would have opened a
`packages/sync` regression, and the evidence would have looked strong: a specific grantee,
a specific missing row, a named failure mode.

**THE RULE.** Before believing ANY finding produced by an instrument, check whether the
instrument reaches its subject through `as any`, `as never`, `as unknown as`, or a port it
declares itself. If it does, the finding is unverified regardless of how specific it looks:
**fix the instrument's own seam first, re-run, and only then read the result.** POD-3508's
`measure-hot-paths.ts` is the same story in the other direction — three dropped promises
inside the measurement window produced WRONG NUMBERS, not wrong types:
`readyList(...).length` on a promise is `undefined` (a silent undercount, which reads as a
free win exactly when the gate matters), `issues.get(...) !== null` is always true so the
counter always incremented, and `upsertIssue({...row})` spread a promise and wrote the
title `"undefined (aged out)"`.

**CONSEQUENCE FOR R4.** The POD-3243 hot-path baseline was produced by that instrument.
Any number quoted from it before this fix is suspect and must be re-measured, not carried
forward. A measurement is only as trustworthy as the seam the measuring code reaches
through, and this one was `as any` all the way down.

### Rule 57a — a deadlock's blast radius is bounded by FILE SELECTION, not by the defect

POD-3506's tenth-hang pass found a tenth. Not by masking within a file, which is what V5's
caveat predicted, but because the tenth victim **lives outside the three files the lane
ran**:

```
apps/server/src/store/runtime-events.test.ts
  causal failure ownership > a LIVE turn/failed in the current turn is ownership
  20004ms timeout under the bug, passes under the fix
```

A/B over the whole **store shard** — 91 files, 1269 tests, one line reverted, compared BY
TEST NAME:

| arm | failed | passed | time | hang-shaped |
|---|---|---|---|---|
| fix | 56 | 1213 | 389.45s | 10 |
| bug | 59 | 1210 | 623.88s | 23 |

In fix but not in bug: **none** — the fix introduces no failure and unmasks nothing. In bug
but not in fix: **three**, of which two were known and the third was invisible to the
original investigation.

**THE RULE.** A shared-resource defect — a lease, a lane, a connection, a scheduler slot —
has a blast radius set by what TOUCHES the resource, and that has no relationship to the
file where the symptom was first noticed. So a verdict scoped to "the files that were red"
undercounts **on principle, not by accident**. Scope the A/B to the whole shard that
contains the mechanism, and diff by test NAME rather than by count: a count that improves
by three cannot tell you whether three got better or five got better and two got worse.

**AND SAY WHAT YOU ARE NOT CLAIMING.** The same pass left 56 failures identical in both
arms. POD-3506 did not fold them into its verdict, did not call them a product defect, and
filed them as POD-3526 with the alternative explanation stated as the open question —
invoking the shard script directly may not be the environment turbo gives it. That is the
right shape: a verdict says what it proved, and a separate issue carries what it merely saw.

**A CORRECTION IT MADE ON ITSELF**, worth keeping because the mistake is easy: its first
"zero hang-shaped in the store shard" was an artifact of piping each shard through
`tail -25` and then grepping the truncation. The real number was ten. Never grep a
truncated log — the pipe answers a different question than the one you asked.

**AN EMPTY SET IS ONLY A RESULT IF BOTH ARMS COLLECTED THE SAME FILES.** POD-3506 added this
and it is the load-bearing caveat on everything above. Rule 57a's strongest claim — "in fix
but not in bug: NONE, so the fix introduces no failure" — rests on an empty set, and an
empty set is indistinguishable from a set that was never populated. If the two arms ran
different shard invocations, or one collected fewer files, the emptiness is an artifact of
collection rather than a finding. So: same shard invocation, same file list, both arms, and
say so explicitly when reporting an empty direction. This is the same failure mode as
POD-3426's gate refusing a corpus that could not have failed, and as POD-3508's canary
against a typecheck that wrote an empty file — **an absence proved by an instrument that
ran over nothing is not a pass.**

**MEASURE THE TIP, NOT YOUR OWN BASE.** POD-3506 moved its worktree onto the integration tip
before running these arms rather than measuring from its own commit 33 behind, having first
verified its fix was an ancestor of the tip and that no `package.json` or lockfile changed
across those commits so the install could not be stale. A result taken from a stale base
describes something nobody will ship.

### Rule 52c — TS2801 covers about HALF the class; the other half has to be read for

POD-3507 asked for this amendment and earned it with the worst site the epic has found.

`TS2801` fires on a bare promise **in a condition**. It is blind to:

| spelling | what it does | compiler |
|---|---|---|
| `if (p())` | truthy | **flagged** |
| `!p()` | always `false` — the guard never refuses | silent |
| `xs.filter((x) => p(x))` | keeps **every element** | silent |
| `p()` as a statement | floating; the work happens later or never | silent |
| `while (p())` / `for (; p(); )` | truthy forever | silent |

At `view.ts` all three silent spellings were present at once, and the `.filter` one projects
**every session in the fleet to every reader**. Nothing static objected.

**SO A CLEAN `lint:promise-truthiness` AND A CLEAN TSC ARE NOT A RESULT FOR THIS CLASS.** They
are a result for the half that appears in a condition. The other half is found by reading the
call sites of anything that became async, and by widening the port so the compiler can speak at
all — which is why rule 56's *widen first* is not a style preference but the precondition for
the compiler having an opinion.

**AND THE `any` MULTIPLIES IT.** `SessionAuthzPorts` declared `store: any`, so the flip produced
no error in that file at all; three further sites were spelled `live ?? store.sessions.getSession(id)`,
where an `any` on the **left** of `??` makes the whole expression `any` — so even a correctly
typed store could not have caught them. Rule 58a says an escape hatch manufactures findings;
this is the same hatch deciding which defects are *possible to notice*.

**THE PRACTICAL TEST.** After widening a port, do not stop when the compiler goes quiet. Grep
the newly-async symbol's call sites for the four silent spellings above and judge each by hand.
POD-3507 found eight more of the same three shapes in `session-state/service.ts` that way —
"by reading, not by the compiler".

### Rule 56b — make a widening ENFORCED, not merely permitted: consume the promise structurally

Rule 56a records that a widening is unenforced — reverting a port from `Promise<void>` to `void`
with every `await` left in place produces **zero** typecheck errors, because `await` on a
non-promise is legal. POD-3500 measured exactly that. POD-3523 found the construction that fixes
it, and I verified the difference by mutation on both.

**The construction.** Route the deferred call through a helper whose parameter type *requires* a
promise:

```ts
private defer(peerId: string, start: () => Promise<void>): void
…
this.defer(peer.id, () => this.admit(peer, principal, routingPrincipal, 'attach', resumeFrom))
```

Now reverting `admit()` to `): void {` — one line, verified applied as a 1/1 diff — produces
**three TS2322 errors**, two of them at the `defer` call sites:

```
feed-serving.ts(309,31): Type 'void' is not assignable to type 'Promise<void>'.
feed-serving.ts(440,5):  Type 'Promise<void>' is not assignable to type 'void'.
feed-serving.ts(769,33): Type 'void' is not assignable to type 'Promise<void>'.
```

Same mutation shape, zero errors under POD-3500's plain `await`, three under POD-3523's thunk.
The difference is that `defer` **consumes** the promise as a value of a declared type, so the
compiler has something to object to. An `await` merely tolerates one.

**WHY THIS MATTERS BEYOND TIDINESS.** Every rule from 52b onward has been a promise some
declaration made invisible, and the standing remedy has been "widen the port". But a widening
that the compiler does not enforce is a comment with a type annotation's syntax: the next
mechanical pass can narrow it back and nothing complains. This is the first construction in the
epic that makes the fix survive its own maintenance.

**WHEN TO REACH FOR IT.** Wherever a rule 51 case 2 site forces a deliberate deferral — the
caller cannot yield, so the promise must be started and not awaited. Instead of `void
somethingAsync()` with a rule 57 comment, give the deferral **one named home** that takes a
`() => Promise<T>` thunk. POD-3523's `defer` also retains the promise, logs a rejection rather
than leaking it, refuses a second admission, and drops a peer that detached before publication —
so the single home is where the deferral's *policy* lives, not only its type.

Rule 57's `void` spelling remains correct for a one-off fire-and-forget that genuinely has no
policy. The moment there is a second such site, or any policy at all, prefer the thunk.

### Rule 52c, amended — widening does NOT make the EQUALITY half loud

POD-3511 widened `SessionMetaOpsPorts.store` from `any` to `SessionStore` exactly as rule 56
prescribes, and `apps/server` stayed at **0 errors**. Not one of its three sites surfaced.

It did not take that as a result. Its canary assigned the same read into a `string` slot:

```
session-meta-ops.ts(109,11): error TS2322:
  Type 'Promise<string | undefined>' is not assignable to type 'string'.
```

So the port *is* typed and tsgo *does* know the method returns a promise. It simply has no
opinion on the two spellings actually in use — which belong on 52c's silent list:

| spelling | why silent |
|---|---|
| `p === undefined` | legal at any type; TS2367 does not fire against `undefined` |
| `(string \| Promise<string>) !== s` | the types overlap, so the comparison is well-formed |

**THE STRONGER CLAIM, and it corrects how I have been briefing this.** Rule 56's "widen the
port first, then let the compiler name the sites" is still right about the widening being the
load-bearing half — it is what let the canary speak, and it is what will refuse a future sync
spelling. But it is **not a search procedure** for the equality half. Those sites have to be
read for. A worker who widens, sees zero errors, and reports the class clear has proved
nothing; the canary is what distinguishes "no defects" from "no opinion".

**AND ONE `any` IS RARELY THE ONLY ONE.** The same interface also declared `repository: any`,
which was hiding the offer *writes*. Widening that one named a site nobody had listed:
`session-meta-ops.ts:456`, `sessionFromStoredRow(row, 'restore') as Session | null`, where the
method is async — a **second** promise-absorbing cast in the same method, one line below the
cast POD-3507 fixed. A promise is never `null`, so the `.filter` on the next line kept every
row and every "restored session" downstream was a promise.

> **Fixing one cast in a method is not fixing the method.** When a cast is found absorbing a
> promise, re-read the whole enclosing function for siblings before closing.

Twelve of that interface's fourteen members are still `any`; a probe widening three of them
named six further sites in the same file. Filed separately rather than smuggled into an
unrelated fix — which is the right instinct and the reason the finding is legible at all.

### Rule 60 — a RED LANE HIDES ITS OWN CAUSES: triage by error string, not by count

POD-3515 set out to explain why a crashing site had no test, and found the opposite. In its
words:

> "This did not ship for want of a test. It shipped PAST a test that was already red."

The site *is* exercised, through the production wiring, by two suites — and both were failing
on the base with the defect's own `TypeError`. Nobody looked at *which* failures, only at how
many, and a lane that is already red absorbs a new defect without changing colour.

**COUNT THE ERROR STRING.** POD-3515's strongest evidence is not a pass/fail delta, it is:

```
relay.test.ts + answer-delivery   base 137 occurrences -> 0
services shard                    base   2 occurrences -> 0
    "TypeError: bag.store.sync.queuedMessageCounts().keys is not a function"
```

137 crashes removed while the lane stayed red, because those same tests also hit a *second*
defect on the same path (`session-authz.ts:355`, a promise read as a Map). Two defects on one
path: removing one cannot turn the lane green, so the pass count is the wrong instrument and
the error-string count is the right one.

**THE CONSEQUENCE FOR THIS EPIC.** We have carried "inherited reds on the base, not ours" as a
standing exclusion all the way through. That is correct as a rule about *ownership* and
dangerous as a habit of *attention*: a red file is not a closed question, it is an unread one.
Before excluding a red as pre-existing, grep it for the error string of whatever you are
working on. POD-3515 found 137 instances of its own defect inside a lane everyone had agreed
to ignore.

**AND CLASSIFY BEFORE YOU BUCKET.** POD-3515's own first pass mis-attributed two tests as
timeouts using a `grep -B 40 "Test timed out"` window, which swept in neighbours. It caught
that itself and reported it. A crude proximity window is not a classifier; match the failure to
its own test name, and state the timeout count per arm so the reader can see whether any
conclusion rests on one.

### Rule 61 — THREE DEFENCES, and they catch different things: the pre-flip diff, the typecheck, the tests

POD-3525's most valuable section is where its own method failed. Three times, each caught by a
**different** defence, and no two of the three would have sufficed.

**(a) A heuristic was wrong three times in four.** Its "sibling inside the held window" widening
proposed four candidates; two were *consuming* uses (`const record = await enqueued`) that it
would have broken. Only comparing against the pre-flip file separated them. It dropped the
heuristic from the shipped rule rather than keeping it with caveats.

**(b) A file BYTE-IDENTICAL to `9f0d5c33e^` still carried the defect.** `maintenance/service.test.ts:453`
passed every text check — but its *callee* went from `(id) =>` to `async (id) =>` in the flip, so
a field was being read off a promise under a line that had not changed. **The typecheck caught
it; the diff could not.**

**(c) A callee that was ALREADY async still regressed.** `scanReposAll()` was async before the
flip, but the store going async moved an `await` to the top of its body, so a fan-out that used
to be queued synchronously with the call no longer is. Three tests regressed. **Only running
them caught it.**

**THE RULE.** Comparing against the pre-flip file cannot see a callee whose asyncness changed
under an unchanged line. So for any conversion of this class, all three of:

| defence | catches |
|---|---|
| diff against pre-flip | a line the flip changed that it should not have |
| typecheck | a value whose *type* moved because a callee's signature moved |
| running the tests | an ORDERING that moved because a callee's body moved |

This is the third time the epic has been bitten by trusting one of the three. POD-3508's
control-arm typecheck 404'd and read as a perfect zero; POD-3515 found a defect had shipped past
a test that was already red; and now a byte-identical file carrying a live defect. **A green
from one defence is not a result — it is one of three.**

**AND READ THE SHAPE SPLIT THE RIGHT WAY ROUND.** POD-3525's five-lane comparison:

```
                 failed   timeout-shaped   assertion-shaped
control (bug)      338          76               262
fix                351          14               337
```

The assertion count **rises**, and that is the fix working: a deadlocked test never reaches its
own assertion. `daemon-request.test.ts` went 10 timeout-shaped / 0 assertion-shaped to 1 / 9,
and 200s to 20s — the same ten failures, but nine can now reach the assertion they would always
have failed. Reading a rising assertion count as a regression would have been exactly backwards.
Worse, the control arm's store lane **silently ran 3 of its 6 files**: 22 tests never executed
at all under the bug, so the control's own totals understate it.

### Rule 56c — CORRECTS the SCOPE of 56: census by the BINDING, not by the declared return type

Rule 56 told the census to enumerate ports declared `: void`, and every instrument built on it
inherited that scope — POD-3520 confirmed its probe is scoped to `void`-returning ports only.
That scope is wrong, and POD-3552 is what it missed.

**The `void` return was never the hiding mechanism.** The `as any` binding is
(`session-wiring.ts:88`, `const bag = life as any`), and an `any` satisfies a *value*-returning
port exactly as well as a `void` one. `ClientControlPorts.sessionOwner` is declared
`(id) => { owner; grants } | undefined`, is wired to an implementation returning
`Promise<…| undefined>`, and typechecks at zero errors.

**The two halves fail in OPPOSITE directions, which is why only one of them kept being found:**

| | declared `void` | declared *value* |
|---|---|---|
| what the promise does | is dropped | is compared |
| failure direction | **open** — work is silently lost | **closed** — the read is never equal to anything |
| how it presents | the product mostly still runs | **outage** |

`authorizeAttach` is both at once, four lines apart:

```ts
const owner = this.ports.sessionOwner(sessionId)
if (!owner) return false                                 // FAILS OPEN: a Promise is truthy
const ctx = contextFromOwnership(owner, this.ports.machineUseFor(principal, sessionId))
return mayWatch(controlSubjectFromClient(principal), ctx) === true   // FAILS CLOSED: false for everyone
```

The open half is unreachable, so the closed half is what ships: **every terminal attach and every
`requestControl` denied, for admins and the system principal too.** And because
`terminal.handleInputBytes` returns early when `clientId !== controllerId`, a client that cannot
attach also cannot type — keystrokes are dropped with no error anywhere.

**WHERE TO LOOK, in POD-3511's wording, which is sharper than mine:** look for it wherever a
guard's answer is **COMPARED rather than awaited** — `=== true`, `!== undefined`, `?? fallback`.
Those are exactly the spellings TS2801 cannot see (rule 52c), and **a single function can fail
open at one and closed at the next**.

**THE CENSUS RULE, RESTATED.** Enumerate every port member reached through an `any` bag or a cast,
*whatever its declared return type*. The declaration is not evidence — it is the thing the `any`
made unenforceable. A port whose binding is typed needs no census entry; a port whose binding is
`any` needs one even if it looks perfectly ordinary at the call site.

**AND WHY A PASSING TEST IS NOT THE PIN HERE.** Widening the declaration produces no error at an
`any` binding, so you can widen to a clean typecheck with the bug still live. The fix is to stop
routing the member through the bag — a typed local, the way POD-3507 did with
`const store: SessionStore = deps.store` — and the check is rule 56b's: revert the await and state
the compiler's error codes and count. Zero means you have a test, not a pin.

*Found by POD-3511 while testing something else, off the wire rather than from the type system;
verified against tip `889e579a0`; fixed under POD-3552.*

### Rule 62 — ANNOUNCING IS NOT SERIALISING: a probe in a shared tree needs a LOCK, not a heads-up

POD-3511-A's sentence, and it is the root cause of the third mutation result this epic has had to
throw away.

It re-applied a mutant and measured it killing **two** tests instead of one — apparently a
discrimination change, which would have been a real finding. It disbelieved its own result,
diffed the working tree against `HEAD` rather than trusting the run, and found **all 32 POD-3511
files reverted pre-fix with a test file deleted**: POD-3511-B was mid control arm and the mutation
run straddled the revert. With the file pre-fix both defects are live, so both tests fail for the
ordinary reason and the mutation had nothing to do with it. The number was void.

Rule 47 already said to *announce* a probe in a live worktree, and A did announce it. **That is not
enough and rule 47 is hereby narrowed.** Announcing tells the neighbour what you are doing; it does
not stop the two of you from doing it at the same time. Take a named lease over the file set —
`podium lock acquire pod<issue>-<file>` — and require it of BOTH sides, because a lease only works
if both take it.

**AND THE CONTAMINATION RUNS BOTH WAYS, which is the half that gets forgotten.** A's probe may have
corrupted *B's* arm, not only the reverse: any read B started before the probe's timestamp may have
measured the fixed file with one await removed, **which is neither arm**. A could not check this
itself — only B knows its own read times — so it reported the exact minute and the exact line it
touched and let B judge. Do that. A neighbour's control arm and a lost working tree look identical
from outside (memory: *a control-arm window looks like lost work*), and the only thing separating a
probe from vandalism is whether the other side agreed to the window.

**THE STRONGER VERSION, from POD-3511-A after it re-ran the same mutations cleanly.** A lock is
belt and braces; **not sharing the resource is the mechanism.** It redid both mutants in its own
detached review worktree at a checkout of the branch head, never writing to the shared tree at all,
and took the lease anyway only because the neighbour had offered it. Both mutants were then killed
by exactly one test each, by their own test, with the same isolating reason codes as the original
measurement — proving the awaits were still load-bearing after a rebase and a round of respellings,
which is the thing an added await can silently destroy with nothing announcing it.

So the rule is ordered, not alternative: **run it somewhere nobody else is, and lock only what you
genuinely cannot un-share.** Three mutation results were discarded this epic before anyone reached
that ordering.

**RESTORE NOTHING.** A did not check out, restore or commit anything, because destroying a
neighbour's control arm mid-measurement is worse than a missing datapoint. An inconclusive result
reported as inconclusive is worth more than a clean number that has to be distrusted later.

### Rule 56b, CONFIRMED THREE TIMES — and the negative case that shows what it is NOT

Rule 56b was written from one worked example. It has now been measured independently by three
issues on the same day, in both directions, and the negative case is the more instructive half.

**THE POSITIVE RESULTS.** In each, the *same* reversion produced nothing before the structural
binding was added, and a named diagnostic after:

| issue | mutation | before | after |
|---|---|---|---|
| POD-3520 | three `void` port reversions | **0** | 3 × TS2322 (`inbox.ts:1044`, `session-wiring.ts:407`, `relay.ts:1268`) |
| POD-3552 | narrow both ownership ports | — | 3 × TS2739 + 3 × TS2322 at production bindings |
| POD-3552 | drop the call-site awaits | — | 2 × TS2739 |
| POD-3264 | narrow `SnapshotVerifier.verify` to `void` | — | 6 (TS1064 ×1, TS2322 ×5, **including at the `deferBackground` thunk call**) |

**THE NEGATIVE CASE, which is the one to remember.** POD-3264 widened
`oracle-support.ts`'s `dispose()` from `void` to `Promise<void>` and then removed the `await` in
`disposeOracles` — and got **zero diagnostics**. That is not a failure of the fix; it is the
mechanism being demonstrated. **Widening an interface member does not make a `() => Promise<void>`
in a `() => void` slot an error** — TypeScript accepts that assignment — so a widening alone buys
you *permission* to await, never *enforcement* of it. POD-3264 responded correctly: it added an
explicit oracle-disposal test to pin the omission the compiler cannot see.

**SO THE RULE HAS A TEST OF ITS OWN.** After any widening, revert the await and read the count.
Zero means you have a test-pinned site, and you must say so in your handoff in those words —
*test-pinned, not compiler-pinned*. A green with no stated pin is the thing this epic keeps
mistaking for a result.

**AND STATE THE LIMITS YOU PREDICT.** POD-3520 predicted in advance that reverting a blanket
`catch` would be compiler-invisible, then ran it and confirmed nothing appeared. A limit predicted
and then confirmed is evidence; the identical silence found by accident is a false clearance.

### Rule 63 — CAPTURE BOTH REPORTERS: the vitest JSON reporter DESTROYS timeout messages

Found by POD-3264 while building its paired comparison, then proved by POD-3511-A with a canary
that killed POD-3511-A's own headline number in one run.

**THE DEFECT.** Three tests, both reporters, one run:

| test | default reporter | JSON `failureMessages` |
|---|---|---|
| forced 5000ms timeout at `{ timeout: 50 }` | `× canary A: this MUST time out` | `Error\n    at task (…/vitest/dist/chunks/…)` |
| `expect(1).toBe(2)` | `× canary B` | `AssertionError: expected 1 to be 2 // Object.is…` |

The assertion keeps its full text. **The timeout is reduced to a bare `Error` plus a stack whose
first frame is vitest's internal `task`.** The string `Test timed out in \d+ms` is one the JSON
reporter *never writes*, so any classifier grepping JSON for it is structurally incapable of
returning non-zero.

**WHAT IT COST.** POD-3511-A reported "zero scheduler timeouts across all 722", and the coordinator
used that to certify the arm as load-trustworthy and repeated it to three parties. Re-derived
against the signature the real count is **~69 of 722 (9.6%)**, concentrated in
`relay-agent-relay.test.ts` (32) and `modules/daemon-request.test.ts` (10).

**THE TELL WAS IN THE REPORT ALREADY.** `70 × Error` was the single most common first line in
POD-3511-A's own distinct-failure-lines table, and both it and the coordinator read it as
uninformative noise. **A failure bucket with no message text is the finding**, not the background.

**THE RULE.**

1. **Every evidence arm captures BOTH reporters** — `--reporter=default` to a file *alongside*
   `--reporter=json`. It costs nothing and it is the difference between a comparable pair and two
   numbers nobody can reconcile.
2. The shared classification, until a direct reading is available: **timeout-shaped iff the JSON
   message is exactly `Error` AND the first stack frame is vitest-internal `at task`**; anything
   carrying real message text is classified by that text.
3. **Where a default-reporter join disagrees with the signature, the join wins** — a derived
   signature yields to the string the reporter actually wrote.
4. Report a signature-derived count as **signature-matched, not measured**.
5. Difference the arms by name *after* classifying each side independently, and report
   **"same name, different shape"** as a third category beside newly-red and newly-green. A name
   that times out in one arm and asserts in the other is present in both, so it appears in neither
   direction of a naive set difference while being a real change.

*This is rule 44 applied to a counter rather than a guard: a check whose pass is silence must be
shown to fail before its silence counts. Eight instruments in this epic have now been caught
reporting success for work they did not do.*

### Rule 64 — THE EXIT CODE AND THE ASSERTION RESULTS ARE INDEPENDENT SIGNALS

This epic has now been bitten from both directions, and neither reading is safe alone.

| | assertions | exit code | what it was |
|---|---|---|---|
| POD-3531 | none executed | **0** | the runner announced 446 files and ran none |
| POD-3502 gate | none matched | **0** | a vitest filter that matched no file "passed" |
| POD-3586 | **12 pass** | **1** | an unhandled rejection derived from a handled promise |

POD-3586 is the newest and the inverse of the familiar one. `mutation-ledger.ts` stores
`tracked = owner.then(…)` in `inFlight` but awaits `owner`. With a joiner, `tracked` is awaited and
all is well; with **no** joiner, the caller catches `owner`'s rejection and `tracked`'s rejection
has no observer — so the test file passes every assertion it makes and vitest exits 1.

**Read both, every time.** Triaging by exit code alone sends you hunting a failing assertion that
does not exist; triaging by assertion count alone calls the file green and ships an unhandled
rejection. State both in a handoff — "12 passed, exit 1" is a complete report and "12 passed" is not.

**And note what makes it invisible to the type system:** a promise derived from a correctly handled
promise is not a promise anyone forgot to handle. `owner` is awaited, `tracked` is stored. Every
individual line is right. Rule 52c's blind half again — no compiler has an opinion about who
observes a derived promise.

### Rule 65 — "RED ON THE BASE" MEANS **dev/mw**, NOT THE INTEGRATION TIP

The coordinator's error, made four times in one afternoon, and it moved real defects out of the
gate.

The integration branch is **829 commits ahead of `origin/dev/mw`**. A control arm at a commit on
*our own branch* — `f55ecf97f`, `7a1445540`, `e4e66e5c7` are all epic commits — answers only:

> did **THIS CHANGE** cause it?

It does **not** answer:

> did the **EPIC** cause it?

Those are different questions and conflating them is how POD-3589 was filed as pre-existing. Its
control at `f55ecf97f` correctly showed the same failure on both sides — and the responsible line,
`cached.authorizationRevision = Number.NaN`, came from `380a2708b refactor(POD-3263)`, the B1 flip.
It had been ours from the beginning. `NaN` equals nothing, so every revision comparison failed and
the advanced world cache was **disabled outright**, not merely invalidated often.

**THE TWO CLAIMS AND THE EVIDENCE EACH ONE NEEDS:**

| claim | required control |
|---|---|
| "my change didn't cause it" | the integration tip **without** my branch — cheap, and usually enough |
| "the epic didn't cause it, it is inherited" | `origin/dev/mw`, **or** `git log -S` on the responsible line showing its introducing commit is an ancestor of `origin/dev/mw` |

The second is what a post-phase placement asserts, and only the second justifies removing something
from the gate. The `git log -S` form is nearly free and does not need a second test run.

**AND WEIGH THE MECHANISM, NOT ONLY THE ARM.** A missing `zig` binary cannot be caused by an async
conversion whatever the arms say; a gateway visibility failure very much can be. When the arm and
the mechanism disagree, trust the mechanism and go get the better control.

*Filed by the coordinator against itself. POD-3589 is closed as fixed-by-POD-3529; POD-3588 has been
moved back into the gate pending a real `dev/mw` check.*

### Rule 65a — SHARPENS 65: an OLD wrapper is not an INHERITED failure when the epic changed the CALLEE's contract

POD-3602's session census found the case rule 65 as written would have misclassified, and its
sentence is the rule:

> **An old wrapper is not an inherited failure when the epic changed the callee's contract.**

The broadcast `void` port at `fc270e099` **is** an ancestor of `origin/dev/mw`. A literal reading of
rule 65 — pickaxe the responsible line, check its introducing commit against `dev/mw` — returns
"inherited", and the failure would have left the gate. But the port only became *wrong* when
`9f0d5c33e` (the POD-3263 flip) made its callee async. The wrapper did not change; **the contract
underneath it did**.

**SO THE PICKAXE MUST FIND THE RIGHT LINE.** For a compatibility failure the responsible line is not
the site that fails — it is whichever end of the pair moved. Ask: *which side of this call changed?*
If the caller is ancient and the callee was converted by this epic, the failure is **ours**, however
old the caller's blame line is.

This is the same shape as the defects that exist **only in the pair** (POD-3552 × POD-3511,
POD-3569): neither side is wrong alone, so neither side's history explains the failure.

**THE COROLLARY, WHICH IS THE EXPENSIVE HALF.** Rule 65 was written after I moved four issues out of
the gate on control arms taken at the integration tip. 65a is the opposite error waiting to happen:
a correct `dev/mw` ancestry check on the *wrong line*, producing a confident "inherited" that is
wrong. A pickaxe result is evidence about a LINE. Deciding it is evidence about a FAILURE takes one
more step, and that step is naming which side of the contract moved.

### Rule 66 — VERIFY A REF EVEN WHEN AN AUTHORITY HANDS IT TO YOU

POD-3511-A's correction, and the error was mine.

I told it, verbatim, "They are now POD-3577." POD-3577 is *Bug: mobile typecheck failures* — unrelated.
It took the ref in good faith and propagated it through an audit, an artifact, and a mail, four
repetitions, each looking corroborated by the last. Its acceptance criterion would have landed on a
mobile-typecheck issue where nobody would ever have read it, and it had already mailed a long essay
about offer observation to a worker who had no idea what it was about.

**Its sharpening is the rule, not mine.** "Check the ref before you cite it" is right but toothless;
the version that would have caught this is:

> **Check it even when someone else hands it to you — a wrong ref from an authoritative source is
> the one nobody checks.**

`podium issue show <ref>` costs four seconds. Two of us in sequence declined to spend them.

**WHY THIS EPIC IS UNUSUALLY EXPOSED.** Refs move here. Fourteen findings were filed top-level and
recreated under the epic with *new numbers*, so notes, artifacts and mails written an hour earlier
cite refs that now point at something else. A stale ref does not error — it resolves, to the wrong
issue, silently. That is the same shape as every other defect in this epic: the failure is not that
nothing happens, it is that something plausible happens instead.

### Rule 48d — `not.toThrow()` on an async call asserts NOTHING. Await the call instead.

Rule 48a converted positive `expect(() => f()).toThrow(...)` into
`await expect(f()).rejects.toThrow(...)`. It said nothing about the NEGATIVE form, and the negative
form is the dangerous one.

    expect(() => requireAgent(id)).not.toThrow()     // requireAgent is now async

`requireAgent` returns a promise. Calling it throws nothing synchronously **whether it rejects or
not**, so this assertion passes unconditionally. It is not weakened — it is vacuous, and it was
vacuous the moment the callee became async, silently, with no test turning red.

**THE RULING: await the call directly.**

    await requireAgent(id)

An unexpected rejection then fails the test on its own, with the real error and its stack, which is
strictly more than `not.toThrow()` ever gave. `await expect(f()).resolves.toBeUndefined()` is
*permitted* where the resolved value genuinely matters, but prefer the bare await: asserting
`undefined` usually pins an incidental return rather than the behaviour.

Apply to EVERY async `not.toThrow` site reached by the flip, not only the two that were reported —
this is a signature, not an incident. Known: `modules/machines/service.test.ts` around 193-195 and
237-239.

*This is the seventh vacuous-assertion class found in this epic. The others: the offer suite's seven
preservation assertions, three authorization outcomes, nineteen restore cases aborting in a helper,
a fail-closed room visibility check hiding its own negative test, a rollback probe exercising only
the safe path, and a self-referential migration-prefix comparison.*

### Rule 62a — the awaitify fixed point and rule 59 do NOT contradict: race sites go on `keep-sync`

`scripts/check-await-idempotence.ts` requires the awaitify pass to be a FIXED POINT — any
un-awaited store call is a proposed edit, and a proposed edit fails the check. Rule 59 requires the
opposite at one specific shape: an await inside a `Promise.all` array literal **sequentialises the
race** and destroys the test.

Both are right. A concurrency test that races two store calls is exactly the shape rule 54 obliges
us to write, and the pass will demand awaits that would delete the thing under test.

**THE RULING: those sites go on `keep-sync`, which is the mechanism that already exists for this,
and each one carries a one-line reason at the site.** The check reports `keep-sync` and
`unused-keep-sync` counts precisely so the list stays honest.

**AND A `keep-sync` ENTRY IS AN ESCAPE HATCH, so rule 58a applies to it in full**: a hatch is a hole
in every gate downstream of it. Two obligations follow. The reason must be written at the SITE, not
only in the list, so a later reader sees why the await is absent before they add one. And a stale
entry is a live hazard, not clutter — `unused-keep-sync=3` in the measured run is POD-3489, and an
unused entry silences a site that may since have become an ordinary un-awaited call.

**RULE 62a EXPIRES WITH THE CODEMOD, AND THAT IS THE REAL RESOLUTION.** POD-3267 (B2.4) deletes the
whole awaitify apparatus — `awaitify.ts`, `awaitify-derive-keep-sync.ts`, `awaitify-keep-sync.txt`,
`check-await-idempotence.test.ts`. The pass and its fixed-point check exist ONLY to drive the
conversion; once the conversion is finished there is no pass to be a fixed point of, and `keep-sync`
has nothing left to annotate.

So the collision is transitional by construction. Until B2.4 lands, use `keep-sync` as above. After
it lands, **only rule 59 governs** — an await inside a `Promise.all` array literal sequentialises
the race — and that lint (`scripts/check-boundaries.ts`, the `sequential-promise-combinator` rule)
is PERMANENT and is not part of the deletion set. There is then no contradiction to resolve, because
only one of the two checks still exists.

Do not carry a `keep-sync` habit past B2.4: after it, an un-awaited store call has no sanctioned
list to sit on and must be justified at the site or awaited.

*Measured on POD-3524's branch: `keep-sync=3 refusals=11 proposed-files=1 proposed-awaits=6
unused-keep-sync=3`. The six proposed awaits were two racing `claimGroup()` calls in each of three
new concurrency tests — rule 59's exact shape, arriving from the pass rather than from a person.*
