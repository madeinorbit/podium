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
reports a body holding the connection past a budget through an injectable sink. No I/O other
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
  **with a 5-second server-side timeout** (Turso client reference). That is a hard budget for any
  write transaction on the Turso backend: the watchdog budget there is below it, no body may await
  anything but the database, and the sync-append proof measures how many round trips fit. A
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
  proving it fires. The `// DECISION POD-<n>` marker is its only allowlist and must be zero at
  Stage A exit.
- Full-text search sits behind a `SearchIndex` port with the FTS5 implementation; whole raw
  statements are allowed there only, with parameters bound.

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
   builder queries anywhere; whole raw statements only behind the search port, parameters bound,
   never `sql.raw` of user input. The lint bans the constructs in §2.7, not the `sql` tag.
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
   - **No slow await inside a transaction body.** The budget is wall-clock on the server. This is
     the same requirement as B0.5's span side-effect classification, now with a number on it.
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

15. **Do not put backticks in a `podium mail --body` or `session send --text`.** A backticked
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
