# POD-3251 [0.9] — Turso remote spike: results

**Spike, report only. No production code changed.** Measured 2026-09-03 on `flatblock` against
Turso organisation `michael-podium`, databases `podium-dev-spike-michael-podium` and
`podium-ci-michael-podium`, primary location `aws-us-east-1`. Client `@libsql/client@0.18.0`.
Every number below was produced by a script in a throwaway `.spike/` directory that is not
committed; the commands are named per gate so any of them can be re-run.

| Gate | Verdict |
|---|---|
| 1 — packaging | **PASS.** Four targets compile, no native addon, boots against Turso. |
| 2 — latency | **PASS with a hard condition.** Unbatched the hot paths are unusable; batched they are fine. One transport arm does not exist. The Fly IAD leg is **NOT MEASURED**. |
| 3 — transactions | **PASS with a hard constraint.** Interactive transactions work but die after ~9 s idle, and a concurrent writer blocks for that whole window. |
| 4 — platform features | **FAIL on FTS5.** Everything else passes. |

---

## The three things that matter most

1. **FTS5 does not exist on Turso as provisioned.** Both databases run in MVCC mode and refuse
   every virtual table. `conversations_fts` and `transcript_fts` cannot be created. The server
   still boots — both `enableFts()` methods catch — but conversation search silently degrades to
   a `LIKE` scan and transcript search turns off completely. This is a product decision, not an
   implementation detail, and it is the one finding that could change the epic's target.
2. **The N+1 fan-out must be batched before the flip, not after.** One issue frame is 371
   sequential round trips. On this host that is 37.6 s. Rewritten as the four `IN`-list queries
   that [B0.2] is meant to produce, the same frame is **4 statements in one round trip, 114 ms**
   — a 330× improvement that comes entirely from removing round trips, not from the region.
3. **Interactive transactions cannot be held across anything slow.** Turso rolls back an
   interactive transaction after ~9 s idle, and a second writer waiting on it blocks for that
   full window rather than failing fast. Any design that holds a transaction open across an
   await that might be slow is broken on Turso.

---

## Gate 1 — packaging: **PASS**

Probe: a one-file entry importing `createClient` from `@libsql/client/web`, compiled with
`bun build --compile --target=<t>` for each of the four targets in `scripts/build-bun.ts`
(`bun-linux-x64`, `bun-linux-arm64`, `bun-darwin-arm64`, `bun-darwin-x64`).

| Target | Compiles | Size | `neon-rs` strings | `index.node` strings |
|---|---|---|---|---|
| bun-linux-x64 | yes | 90 MB | 0 | 0 |
| bun-linux-arm64 | yes | 89 MB | 0 | 0 |
| bun-darwin-arm64 | yes | 60 MB | 0 | 0 |
| bun-darwin-x64 | yes | 66 MB | 0 | 0 |

**No native addon is pulled into the bundle**, and the contrast is measured rather than assumed:

- `@libsql/client/web` — 54 modules, 140.20 KB, zero native references.
- `@libsql/client` (default entry) — 62 modules, 179.1 KB, and it does pull the native loader:
  `@neon-rs/load`, a `path.join(dirname, "index.node")`, and a `linux-x64-gnu` target string.

So the brief's claim holds exactly, and the `/web` entry is the one to import.

**Boot against a Turso database:** the compiled `bun-linux-x64` binary connected and ran
`select 1` — `OK [{"one":1}] 549 ms` (cold, including TLS).

**Two packaging facts worth carrying forward:**

- **The install tree still contains the native package even though the bundle does not.** Adding
  `@libsql/client` installed `libsql@0.5.29` with two `.node` binaries
  (`@libsql/linux-x64-gnu`, `@libsql/linux-x64-musl`). It is a hard dependency of the client
  package, not an optional one. It costs install size and CI time; it does not reach the binary.
- **The `turso://` scheme trap is real and now settled.** The client refuses it outright:
  `URL_SCHEME_NOT_SUPPORTED: The client supports only "libsql:", "wss:", "ws:", "https:",
  "http:" and "file:" URLs, got "turso:"`. Under the `/web` entry, `libsql://` resolves to
  **HTTPS**, because `web.js` calls `expandConfig(config, true)` with `preferHttp = true`.
  So the configuration to use is `libsql://<host>` with the `/web` entry, and the credential
  URLs need their scheme rewritten from `turso://`.

---

## Gate 2 — latency: **PASS with a hard condition**

### The WebSocket arm of this gate does not exist

Turso's hosted endpoint refuses a WebSocket upgrade outright:

```
HTTP/1.1 400 Bad Request
{"error":"protocol upgrade not supported (websocket)"}
```

Tried with and without the `hrana3` subprotocol; the client fails with
`HRANA_WEBSOCKET_ERROR: ... Expected 101 status code`. The HTTP pipeline answers normally
(`/v2` says "Hello, this is HTTP API v2 (Hrana over HTTP)", `/v3/pipeline` returns 200).

**hrana over HTTP is the only transport available.** There is no WebSocket number to report,
and no persistent-stream optimisation to design around.

### Correcting the floor number in the brief

The brief's 392–435 ms was **one cold connect per call**, not per-statement latency. Breaking a
single request into its phases (10 samples, `curl` against `/v3/pipeline`):

| Phase | Time |
|---|---|
| TCP connect | ~99 ms ← this is the raw network RTT to us-east-1 |
| TLS handshake (2 more RTTs) | +~195 ms |
| Request → first byte | +~95 ms |
| **Total, cold** | **~390 ms** ← matches the brief's 392–435 ms exactly |

With a **warm, reused client** the per-statement round trip is **p50 99.5 ms** (n=371, min 97.7,
p90 106.1, max 184.0). The first call still pays ~421 ms.

Two consequences: the naive issue frame is ~37 s from this box, not 2.5 minutes; and **the
server-side execution time is negligible** — 99.5 ms warm against a 99 ms network RTT leaves
~2 ms for everything else. That ratio is what makes the region projection below tractable.

### Replaying the real hot paths

The traces are the exact statement texts and counts recorded by `scripts/measure-hot-paths.ts`
(POD-3243), re-run here and reproducing the landed baseline: `feedBootstrap` 44,
`issueFrameReads` 371. Parameters are bound from real production ids. The Turso database holds
an imported production dataset (see Gate 4). The local control is a **twin built the same way**:
same 97 migrations, same imported rows, so the comparison is like-for-like.

| Path | Remote, sequential | Remote, one batch | Local `bun:sqlite` |
|---|---|---|---|
| feed bootstrap (44 statements) | **4.63 s** (44 round trips) | **0.40 s** (1 round trip) | 2.4 ms |
| issue frame (371 statements) | **37.61 s** (371 round trips) | **0.22 s** (1 round trip) | 1.4 ms |

Per-statement inside the frame replay: n=371, min 97.7, p50 99.5, p90 106.1, max 184.0 ms.

One caveat on the local control: 1 of the 44 bootstrap statements still failed against the twin
(an empty `sqlite_sequence` lookup), so the 2.4 ms is marginally optimistic. All 371 issue-frame
statements ran on both sides, so that row is a clean comparison.

### Round trips per request is the whole story

| Shape | Round trips | This host (99 ms each) |
|---|---|---|
| Feed bootstrap | 44 | 4.4 s |
| Issue frame, frame cache holds | 371 | 36.8 s |
| **Issue frame, frame cache dropped** | **5,163** | **512 s (8.5 min)** |

The 5,163 row is arithmetic, not a replay — it is the pre-frame-cache read count recorded in
spec §2.5 for `store/issues.ts:33-97`. It is in this table because spec §6.9 names the exact
mechanism that brings it back: **the first `await` anywhere in the issue read fan-out drops the
microtask-keyed frame cache.** On SQLite that regression costs 13 s of CPU. On Turso it costs
eight and a half minutes. This is the single largest risk the flip carries.

### What batching buys, measured

Batch size scales far past anything the hot paths need:

| Statements in one batch | Wall |
|---|---|
| 100 | 0.13 s |
| 371 | 0.24 s |
| 1,000 | 0.30 s |
| 5,163 | 0.88 s |
| 10,000 | 1.33 s |
| 20,000 | 2.75 s |

Even the catastrophic 5,163-read case costs 0.88 s if it is one batch.

And the shape [B0.2] is actually meant to produce — the same fan-out rewritten as `IN`-list
queries — collapses it further, against the real production rows:

| Shape | Statements | Round trips | Wall |
|---|---|---|---|
| Today's N+1, sequential | 371 | 371 | 37.61 s |
| Today's N+1, one batch | 371 | 1 | 0.22 s |
| **`IN`-list rewrite, one batch** | **4** | **1** | **114 ms** |

114 ms is one network round trip. At that point the query layer costs one RTT per request and
the region is the only remaining term.

### The Fly IAD leg: **NOT MEASURED**

The brief requires Fly IAD → Turso `aws-us-east-1`, and says so emphatically. **I could not
measure it.** This box has no `flyctl`, no `~/.fly`, and the repo has no `fly.toml`; there is no
Fly account or token available to this session. I asked the coordinator twice (issue mail and a
session wake) for either a Fly token plus permission to deploy a throwaway measurement app in
IAD, or another us-east-1 host. No answer had arrived by the time this was written.

I am reporting it as unmeasured rather than guessing it. What I can offer instead is a
**projection from two measured anchors**, which is not the same thing and should not be quoted
as if it were:

- **Intercept, zero network distance.** Against a local `turso dev` sqld on 127.0.0.1, the warm
  per-statement round trip is **p50 1.8 ms** (n=40, min 0.6). 371 sequential there is 779 ms;
  as one batch, 19 ms. So client + HTTP + server overhead is ~2 ms.
- **One measured distance.** flatblock → us-east-1: 99 ms network RTT, 99.5 ms warm round trip.
  The model `round trip ≈ 2 ms + network RTT` fits.

Fly IAD and AWS us-east-1 are the same metro, where RTT is typically 1–3 ms, giving a projected
**per-statement round trip of roughly 3–5 ms**:

| Shape | Round trips | Projected at 4 ms | Confidence |
|---|---|---|---|
| Feed bootstrap | 44 | ~0.2 s | projection |
| Issue frame, cache holds | 371 | ~1.5 s | projection |
| Issue frame, cache dropped | 5,163 | ~21 s | projection |
| `IN`-list rewrite, one batch | 1 | ~5 ms | projection |

The caveat that matters: the intercept was measured against `turso dev`, which is legacy sqld,
**not** the MVCC `tursodb` the hosted databases run. Its server-side execution cost may differ.
The projection is robust to that — doubling the intercept moves the frame from 1.5 s to 2.2 s —
but it is still a projection, and **the gate should not be signed off on it.**

---

## Gate 3 — transactions: **PASS with a hard constraint**

All probes over hrana-on-HTTP, which uses a `baton` to continue a stream across requests.

| Question | Answer |
|---|---|
| Interactive transactions across network awaits? | **Yes.** Write, read-back inside the transaction, and commit all behave correctly. |
| `BEGIN IMMEDIATE` semantics? | **Yes, but only through the client API.** `transaction('write')` maps to `BEGIN IMMEDIATE` (`@libsql/core/util.js`), `'read'` to `BEGIN TRANSACTION READONLY`, `'deferred'` to `BEGIN DEFERRED`. |
| Raw `BEGIN` / `BEGIN IMMEDIATE` as a statement? | **Accepted but useless.** `c.execute('BEGIN IMMEDIATE')` returns success, but each `execute()` is its own stream, so the transaction does not survive to the next call — a following `ROLLBACK` fails with `cannot rollback - no transaction is active`. Anything that opens a transaction by executing SQL is silently broken. |
| Savepoints? | **Yes.** `savepoint` / `rollback to` / `release` inside an interactive transaction all work, and `rollback to` correctly discarded the intervening write. |
| Idle tolerance? | **~9 s.** Alive at an 8 s gap; dead at 10, 11, 12 and 14 s. Each statement resets the clock. |
| Error on expiry? | `SQLITE_BUSY: interactive transaction was rolled back because the stream was idle for too long; retry the transaction` |
| Concurrent writer? | **Blocks for the whole idle window, then wins.** A second writer against a held write transaction did not fail fast — it blocked **10.2 s**, until the holder was reaped, then succeeded. The holder's own commit then failed with the idle-stream error. Two interactive write transactions behaved the same way: B waited 10.0 s, committed; A's commit failed. |
| Network loss mid-transaction? | **The transaction is dead immediately and the work is lost.** The in-flight statement surfaces the transport error; every later call on that transaction returns `TRANSACTION_CLOSED` (`Cannot execute statements because the transaction is closed`), commit returns `TRANSACTION_CLOSED`, and the row still holds its pre-transaction value. |
| Does the client reconnect? | **Yes, transparently, at the client level.** The same client object served a fresh statement 97 ms after the outage with no manual reconnect. It is the *transaction* that is unrecoverable, not the client. |

**What this means in one line:** a transaction on Turso is a ~9 second budget, it must not contain
a slow await, and a concurrent writer pays the full budget as latency rather than getting a fast
busy error.

---

## Gate 4 — platform features: **FAIL on FTS5**

### FTS5: **not available**

```
CREATE VIRTUAL TABLE conversations_fts USING fts5(...)
-> SQL_INPUT_ERROR: Tursodb error: Parse error: Virtual tables are not supported in MVCC mode
```

Confirmed on **both** provisioned databases, so it is not a per-database setting:

| Database | `PRAGMA journal_mode` | fts5 | rtree | `sqlite_version()` |
|---|---|---|---|---|
| `podium-dev-spike-michael-podium` | `mvcc` | refused | refused | 3.50.4 |
| `podium-ci-michael-podium` | `mvcc` | refused | refused | 3.50.4 |

No virtual table of any kind can be created. What happens to the store:

- `ConversationIndexRepository.enableFts()` (`apps/server/src/store/conversations/index.ts:17`)
  puts the `CREATE VIRTUAL TABLE` first inside its `try`, so it fails there, the triggers are
  never created, and the `catch` leaves `ftsAvailable = false`. Conversation search falls back
  to the `LIKE` path — over **3,528 conversations**, remotely.
- `TranscriptIndex.enableFts()` (`store/conversations/transcript-index.ts:25`) behaves the same
  way and sets `available = false`, at which point **every transcript read and write becomes a
  no-op through `isAvailable`**. Transcript search does not degrade; it disappears. The
  production database holds **32,697** `transcript_fts` rows today.

So the server boots and nothing crashes — the fallbacks are honest — but two features are lost
or badly degraded. **A hazard for [E.5] to note:** the two statements are only safe because the
virtual table is created *before* the triggers in the same `try`. If that order is ever
inverted, or a partial failure leaves a trigger behind, every `INSERT INTO conversations` fails
with `no such table: conversations_fts`. I hit exactly that during this spike by running the
statements separately, and it blocked all 3,528 conversation rows until I dropped the trigger.

### PRAGMA support

| PRAGMA | Result |
|---|---|
| `PRAGMA foreign_keys` | **Works**, reads back `0` |
| `PRAGMA foreign_keys=ON` | **Works** — a following read returns `1`, so it is honoured per connection |
| `PRAGMA defer_foreign_keys=ON` | **Works** |
| `PRAGMA synchronous` | Works, returns `2` |
| `PRAGMA user_version` | Works, returns `0` |
| `PRAGMA table_info(...)` | Works |
| `PRAGMA journal_mode` | Works, returns **`mvcc`** |
| `PRAGMA journal_mode=WAL` | **Refused** — `SQL_PARSE_ERROR: SQL not allowed statement` |
| `PRAGMA wal_checkpoint(TRUNCATE)` | **Refused** — `SQL_PARSE_ERROR: SQL statement is not allowed` |
| `PRAGMA busy_timeout=5000` | **Refused** — `SQL_PARSE_ERROR: SQL not allowed statement` |

`journal_mode` and `wal_checkpoint` are not no-ops as the brief anticipated — they are **hard
errors**. Any code path that issues them must not run against Turso. `busy_timeout` being
refused is the more interesting one: it means the ~9 s block in Gate 3 is not tunable.

### The migration chain: **applies cleanly**

The chain is **97 migrations now, not 87** — worth correcting in the brief.

Podium does not use drizzle's own `migrate()`; it has its own applier
(`apps/server/src/migrations/index.ts`) that walks `DRIZZLE_MIGRATIONS` from
`drizzle-manifest.generated.ts`, splitting each on `--> statement-breakpoint`. I replayed that
against a freshly emptied Turso database:

| | Turso (remote) | Local twin (`bun:sqlite`) |
|---|---|---|
| Migrations | 97 | 97 |
| Statements | 587 | 587 |
| Failures | **0** | **0** |
| Round trips | 685 | — |
| Wall | **136.2 s** | **1.48 s** |

Per-migration remotely: min 245 ms, p50 683 ms, p90 2.75 s, **max 19.1 s**. Result: 101 tables.

Nothing in the chain is rejected — including the `PRAGMA foreign_keys=OFF` / `=ON` pairs that
bracket drizzle's table rebuilds. But **a fresh remote database costs 136 s to migrate, 92×
local**, which is a boot-time and CI fact rather than a correctness one.

### The migration ledger read remotely: **works**

`__drizzle_migrations` is created and read back over the remote connection; the `hasTable`
probe (`SELECT name FROM sqlite_master WHERE type='table' AND name = ?`) that
`appliedDrizzleNames` and `packages/runtime/src/migration-ledger.ts` rely on returns correctly,
and all **97/97** names read back.

One structural caveat for [E.5], not a Turso defect: `readAppliedMigrations()` in
`migration-ledger.ts` is built on `existsSync(path)` and `openDatabase(path)` — a **local file
path**. Its daemon caller asks "does this machine's database exist, and what has it applied";
against a remote database "no database here" and "a fresh empty one" become network questions.
That function needs a remote answer, not just an async signature.

### Importing an existing `podium.db`: **works, by row insert**

`turso db import` needs an authenticated CLI; the CLI at `~/.turso` is not logged in and
`turso auth login` is interactive. I imported by reading the production database with
`bun:sqlite` and inserting through the client in batches of 200.

Source: `/home/mgw/.podium-vmi/podium.db`, 184 MB — 168 issues, 318 sessions, 179 issue
comments, 62 issue deps, 3,528 conversations, 3,621 conversation segments, 1,183 changes.

| | Result |
|---|---|
| Rows imported | 13,387 |
| Batch round trips | 81 + 18 |
| Wall | 26.1 s + 6.6 s |

Two classes of failure, both worth naming:

- **Source staleness, not Turso.** `pins`, `tab_order`, `snoozes` and `client_sessions` all
  failed with `NOT NULL constraint failed: <table>.user_id`. The production database predates a
  `user_id NOT NULL` column added by the current chain. `issues` imported 45 of 47 columns and
  `sessions` 23 of 24 for the same reason. A real import needs the source migrated first.
- **The orphan-trigger hazard** described under FTS5 above, which blocked all 3,528
  `conversations` rows until the trigger was dropped.

### Database-per-tenant through the platform API: **NOT MEASURED**

The Platform API needs an **organisation** API token. `TURSO_SPIKE_TOKEN` is a database auth
token and is rejected:

```
GET https://api.turso.tech/v1/organizations                       -> 401
POST .../v1/organizations/michael-podium/databases                -> 401 {"error":"could not parse jwt id"}
```

The CLI is not logged in and login is interactive. I asked the coordinator for an org token.
Creation and deletion of per-tenant databases is therefore unverified.

---

## What [E.5] must handle

Ordered by how much design they force.

1. **FTS5 is gone.** Decide between: accepting `LIKE` for conversation search and *no* transcript
   search; keeping a local SQLite sidecar purely for the search indexes; moving search to an
   external service; or asking Turso for a non-MVCC database. Nothing in the store needs to
   change to *boot* — both fallbacks are already correct — but two features silently lose their
   teeth, and 32,697 transcript rows have no other home.
2. **Batch or lose.** The flip must not ship the N+1 fan-out unbatched. Sequential is 37.6 s per
   issue frame from this host; the `IN`-list rewrite is 114 ms. [B0.2] and [B0.6] are not
   optimisations here, they are preconditions.
3. **Protect the frame cache with a test that counts round trips.** The first `await` in the
   issue read fan-out turns 371 into 5,163. Unbatched that is 8.5 minutes from this host and a
   projected ~21 s from IAD. `scripts/measure-hot-paths.ts` already measures exactly this and
   its gate refuses an increase — keep it in the flip's gate.
4. **A transaction is a ~9 second budget.** No slow await inside one. `busy_timeout` cannot be
   raised. Expiry arrives as `SQLITE_BUSY` with a distinctive message; it needs recognising and
   retrying at the scheduler, and the retry must be safe to run twice.
5. **A concurrent writer pays the full ~9 s as latency**, not as a fast busy error. Serialise
   writers in the process rather than letting Turso's stream reaper arbitrate.
6. **Network loss kills the transaction, not the client.** Every call after an outage returns
   `TRANSACTION_CLOSED` and the work is gone; the client itself keeps working. The durability
   port needs an explicit retry-the-whole-transaction path.
7. **Only ever import `@libsql/client/web`.** A boundary lint should forbid the bare
   `@libsql/client` specifier, which pulls the native loader into the bundle.
8. **Rewrite the credential URLs** from `turso://` to `libsql://`. The client refuses `turso:`.
9. **Never issue `PRAGMA journal_mode=WAL`, `wal_checkpoint` or `busy_timeout`** against Turso —
   they are errors, not no-ops. Audit the store, the janitor and the backup paths for them.
10. **`migration-ledger.ts` needs a remote answer.** It is `existsSync` + local-path based, and
    its "no database here" versus "empty database" distinction is what the daemon's downgrade
    guard turns on.
11. **A fresh database costs 136 s to migrate.** That is a boot timeout and a CI-provisioning
    fact; one migration in the chain alone took 19 s.
12. **There is no WebSocket transport.** Do not design for a persistent hrana stream.
13. **Import needs the source migrated first**, or `NOT NULL` columns added since will reject
    whole tables.

---

## What is still open

| Item | Why | What it needs |
|---|---|---|
| **Fly IAD → us-east-1 latency** | The number the human actually asked for and the one [E.5] lives with. Only projected here. | A Fly token and permission to deploy a throwaway app in IAD, or any other us-east-1 host. |
| **Database-per-tenant create/delete** | Platform API rejects a database token. | An organisation-scoped Turso API token. |
| **FTS5 on a non-MVCC database** | Would reverse the one gate failure. | Whether Turso offers a legacy/sqld database on this plan. |

## Reproducing

Scripts lived in an uncommitted `.spike/` directory; each gate was one file. Credentials came
from the gitignored `.env` (`TURSO_SPIKE_URL` rewritten `turso://` → `libsql://`,
`TURSO_SPIKE_TOKEN`). The baseline trace came from
`bun --conditions=@podium/source scripts/measure-hot-paths.ts --suite queries --out <file>`,
which reproduced POD-3243's landed numbers (44 / 371) before being replayed remotely.

`PODIUM_TEST_WORKERS` was **not set**. Nothing here ran under the heavy test lease; no test
suite was run at all.
