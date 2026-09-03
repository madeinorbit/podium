# POD-3250 [0.8] — the change-log append over the libsql remote client: results

**What was asked:** prove the change-log append keeps gap-free sequence numbers through the
libsql remote client on a Turso database, and measure its round trips so [B0.6]'s prefetch
design has real numbers.

**What was found:** the contract holds, unchanged, on both engines. Three of the brief's
assumptions do not, and two of them are corrections to documents this epic is already acting on.

Measured 2026-09-03 from `flatblock`. Slice at `apps/server/src/store/spike/turso-append/`;
`PODIUM_TEST_WORKERS` was `1`.

---

## The three things that matter most

1. **The append's contract survives the network intact.** Contiguous seqs across every chunk
   boundary, `lastInsertRowid` naming this statement's rows and not the database's, a
   mid-append throw rolling back the rows *and* the `AUTOINCREMENT` counter, and a restart
   continuing without a gap or a reuse — all of it, identically, on local `sqld` and on the
   hosted database. Nothing in the port needed bending to get there.

2. **There is no fast busy error, so the "bounded retry" in the driver contract is retrying
   something that does not happen.** A second writer against a held write transaction does not
   fail — it BLOCKS for the whole idle window (5.0 s local, 10.6 s hosted) and then WINS, and
   the *holder* is the one that loses its work. The retry policy below is written against that
   behaviour instead.

3. **A seq already handed out is re-issued when an enclosing span rolls back** — POD-3260's
   class, reproduced here on the remote client. The append cannot fix it; the rule is that seqs
   must not escape a revocable span. This proof now has a test that would see a regression.

4. **The write budget bounds the GAP between statements, not the transaction's duration.** A
   21.6 s transaction with a statement every 2 s committed on the hosted database; a 12.2 s one
   with a single idle gap was reaped. Spec §3.7 currently reads as a total-duration budget, and
   under that reading the 250-row append — 27.8 s of continuous statements — would be
   impossible. It is not: it commits.

---

## Where the slice lives, and why

`apps/server/src/store/spike/turso-append/`, chosen over a scratch package because the thing
being validated is the executor's driver port, which lives two directories up at
`apps/server/src/store/executor/driver.ts`. A separate package would have had to either
duplicate that interface or take a dependency across a boundary the epic is in the middle of
drawing, and the first would have made "the port works remotely" unfalsifiable.

It is NOT wired into the server. Nothing imports it; the composition root does not know it
exists. `@libsql/client` was added as a **devDependency of `apps/server`** — the only shared-file
edit in this issue, and the reason the tests are runnable at all.

| File | What it is |
|---|---|
| `schema.ts` | the `changes`, `change_latest`, `locks` and `feed_identity` tables, plus DDL to execute |
| `client.ts` | `@libsql/client/web` with a round-trip counter wrapped around its `fetch` |
| `libsql-driver.ts` | a `StoreDriver` (the [0.6] port) over libsql: lanes, limits, savepoints, classify |
| `sync-append.ts` | the append path ported to async, in a literal and a batched shape |
| `locks.ts` | lock acquisition — the read-decide-write contrast case |
| `backend.ts` | starts a real `sqld` on a free port over a persistent directory |
| `fixture.ts` | one appended-to database on whichever backend the caller names |
| `turso-append.integration.test.ts` | 17 assertions, CI-runnable against local `sqld` |
| `run-proofs.ts` | the same proofs against the hosted database — what produced this document |

**Round trips are counted at the transport, not at the call site.** `@libsql/client` takes a
`fetch` in its config, so the counter wraps that and counts actual HTTP requests. Counting
`execute()` calls would have measured the code rather than the network.

---

## The contract proofs

Both engines, same result, unless the row says otherwise.

| # | Question | local `sqld` | hosted Turso |
|---|---|---|---|
| 1 | Contiguous seqs across chunk boundaries (250 rows = 3 chunks)? | 1..250, no gap | 1..250, no gap |
| 2 | Does a later append continue from the head? | 251, no gap | 251, no gap |
| 3 | Is `lastInsertRowid` over hrana this statement's, not the database's? | yes | yes |
| 4 | Does a throw mid-append roll back the rows? | yes | yes |
| 4 | Does it roll back the `AUTOINCREMENT` counter too? | **yes** | **yes** |
| 6 | Does the sequence survive the server process restarting? | yes, head 120 → next 121 | not applicable¹ |
| 8 | Is a RAW batch inside an open transaction atomic? | **no** | **no** |
| 10 | Does a rolled-back ENCLOSING span re-issue seqs already handed out? | **yes** | **yes** |

¹ Only the local server can be stopped and restarted. On the hosted database the closest
equivalent — a fresh client against the same database after the previous one closed — is what
proofs 1–3 already do, and it proves less. The restart proof is therefore a local-only result
and is not claimed for the hosted engine.

### Proof 3 is the one that would have been easy to fake

Two clients append alternately. If `lastInsertRowid` arriving over hrana were the *database's*
last insert rather than *this statement's*, the returned ranges would still look perfectly
contiguous — they would simply address the other client's rows. So the assertion is on the rows
each seq resolves to, not on the numbers. It passes on both engines: A's `281..380` address A's
rows, B's `381..430` address B's, and A's `431..530` address A's again.

### Proof 4's second half is the half that matters

`sqlite_sequence` is ordinary table data on SQLite, so it rolls back with the transaction — and
it does so on Turso as well. A test that only checked "no rows left behind" would pass either
way; the consequence of the other answer is that a failed append burns its seqs and every later
append starts after a gap.

### Proof 10 — the seq-reuse class POD-3260 found, reproduced on the remote client

The coordinator asked whether this proof would CATCH POD-3260's failure rather than assume it
away. It would not have, as first written, and now it does.

**Proof 4 does not cover it and reports the opposite conclusion.** There the append owns its own
transaction, so a rollback revokes seqs nobody could have published — the counter going back is
*safe*, and proof 4 correctly calls it a good result. The dangerous case is the other one: the
append SUCCEEDS, hands its seqs back to a caller that may publish them, and only then does an
ENCLOSING span roll back.

Measured, identically on both engines:

```
nested append returned                    1..5          (entities v0..v4)
enclosing span rolled back                true
the NEXT, unrelated append got            1..5          (entities w0..w4)
rows now in the log                       1=w0 2=w1 3=w2 4=w3 5=w4
```

A replica told "seq 1 is `v0`" is now served `w0` at seq 1. It holds a cursor at 5, sees nothing
new, and treats five genuine changes as ones it has already applied — **the stale row suppresses
the correct one.** That is worse than a gap: a gap heals, because a consumer applying
`seq !== cursor + 1` re-bootstraps. This does not heal at all.

**Nothing in the append can fix it, and it is not a Turso defect** — `sqlite_sequence` is
transactional on SQLite and the hosted engine faithfully reproduces that. The rule lives above
the append: **a seq may not escape a span that can still roll back.** POD-3260 fixed the
nested-publish case on this branch; what this proof adds is a test that would see a regression
instead of a document that says it cannot happen
(*REUSES a seq it already handed out when the enclosing span rolls back*).

### Proof 8 makes the port's savepoint load-bearing

The [0.6] contract requires `executeBatch` to be atomic *even inside an open transaction*, on
the grounds that a caller catching the batch's error would otherwise keep the prefix that
applied. That turns out to be exactly right and not a precaution: driving `tx.batch` raw, with a
failing second statement, the first statement **stayed applied** (0 rows → 1 row) on both
engines, and the transaction remained usable. So a driver that skipped the savepoint would be
silently non-atomic. It costs two round trips per batch, priced below.

---

## Round trips per append and per bootstrap read

Counts are identical on both engines — they are a property of the shape, not the backend. The
milliseconds are what the two networks cost.

| Operation | Round trips | local `sqld` | hosted Turso |
|---|---:|---:|---:|
| append 1 row, literal port | 3 | 9 ms | **463 ms** |
| append 100 rows, literal port | 102 | 267 ms | **11,047 ms** |
| append 100 rows, batched | 7 | 52 ms | **857 ms** |
| append 250 rows (3 chunks), literal port | 254 | 786 ms | **27,482 ms** |
| append 250 rows (3 chunks), batched | 19 | 146 ms | **2,141 ms** |
| lock acquire, uncontended (read-decide-write) | 3 | 29 ms | **356 ms** |
| lock acquire, refused (already held) | 2 | 9 ms | **210 ms** |
| lock read | 1 | 3 ms | **104 ms** |
| bootstrap read (`change_latest` fold, 250 rows) | 1 | 6 ms | **218 ms** |
| head read (`sqlite_sequence`) | 1 | 6 ms | **105 ms** |
| `changesSince(0)` | 1 | 9 ms | **309 ms** |

### The shapes behind those counts

- **Literal port:** `rows + chunks + 1`. Every `change_latest` statement is its own round trip.
  The `BEGIN` folds into the first statement's request; the `COMMIT` is one.
- **Batched:** `6 × chunks + 1`. Per chunk: a savepoint, the insert batch, a release, then a
  savepoint, the `change_latest` batch, a release — then one commit for the whole append.

**Two round trips per chunk is the floor and no amount of batching removes it.** The
`change_latest` statements need the seq range the insert returns, and that range does not exist
until the server has answered. An append is not free even when perfectly batched.

**The savepoint costs four of those six.** A single-statement batch is atomic by definition, so
the insert's savepoint is arguably redundant, and `SAVEPOINT`/`RELEASE` could plausibly travel
*inside* the same `tx.batch` array as the statements they wrap. Neither was tested here and
neither should be adopted on this document's word — but together they would take the batched
250-row append from 19 round trips to about 7, which is worth [E.5] measuring.

### What this means for the hot paths

Beside POD-3243's landed baseline and POD-3251's 95 ms warm round trip:

- **A one-row append costs 453 ms on the hosted database.** That is the common case — a reconcile
  appending a handful of rows — and it is three round trips, not one. This is the number to
  design against, not the 250-row figure.
- **The bootstrap read is one round trip whatever its size.** 250 rows in 218 ms. [B0.6] is
  entitled to assume that; the fold does not scale with round trips.
- **The literal append path is unusable remotely** at 11 s for 100 rows, and the batching work
  is what fixes it — the same conclusion POD-3251 reached for reads, now measured for the write
  path.

### The locks aggregate: what a read-decide-write costs that a blind write does not

The append never asks the database a question before writing, so every statement it issues can
travel in a batch. A lock acquisition has to read the incumbent, decide in TypeScript whether
the lease is free or expired, and only then write — so the write lock is held open across a full
network round trip during which nothing is happening on the server.

| | Round trips | hosted Turso |
|---|---:|---:|
| grant (read, decide, write, commit) | 3 | 356 ms |
| refusal (read, decide, commit) | 2 | 210 ms |
| plain read, no decision | 1 | 104 ms |

**A grant costs 356 ms and roughly a third of it is the holder doing nothing** — and by proof 7,
every millisecond a write transaction is held is a millisecond the next writer pays as latency.
Three round trips is small in absolute terms; what makes it worth recording is that the middle
one is unavoidable in this shape and is the pattern every read-decide-write in the store shares.
Collapsing it to a single conditional upsert is possible and is a different program — it cannot
report the incumbent to the caller — so it is a decision for whoever converts the aggregate, not
a free optimisation.

---

## The multi-writer answer, and the retry policy

### What the brief expected, and what actually happens

The brief expected "the second receives a busy error rather than interleaving". Half of that is
right and it is the important half.

**There is no interleaving.** Under every arm run here the log stayed gap-free with every seq
unique. That is the invariant the feed protocol depends on and it held.

**There is no fast busy error either.** With client A holding an open write transaction
mid-append, client B's own append:

| | local `sqld` | hosted Turso |
|---|---|---|
| B's outcome | **SUCCEEDED** after blocking | **SUCCEEDED** after blocking |
| B blocked for | 5,040 ms | 10,612 ms |
| A's own commit | `TRANSACTION_TIMEOUT: Transaction timed out` | `SQLITE_BUSY: interactive transaction was rolled back because the stream was idle for too long` |
| Log afterwards | gap-free, seqs unique | gap-free, seqs unique |

The platform serialises writers by making the *contender wait for the holder to be reaped* and
then letting it through. The loser is the holder, and it loses everything it had done.

This reproduces POD-3251 gate 3 at the bare-statement level and extends it to the append shape.

### The policy

**1. The retry belongs above the transaction, and only to acquisition.** A remote transaction
that fails is dead and its work is lost — retrying anything whose body has begun risks applying
it twice. This is already what the [0.6] port says (`BusyRetryPolicy`, applied to `driver.open`
and `lease.begin`); the measurement confirms it rather than changing it.

**2. Bounded: 3 attempts, 50 ms initial delay, 500 ms cap, and bounded by the write budget too.**
Recorded as `TURSO_BUSY_RETRY` in `libsql-driver.ts`. The attempt count is small on purpose —
because contention manifests as a ten-second block rather than a fast failure, an error that
does reach the retry has already cost the full window, and further attempts spend a second
window rather than a millisecond one.

**3. `classify` treats only `SQLITE_BUSY` as retryable, in both its shapes** — a genuine write
conflict, and the idle reaper's "stream was idle for too long". `TRANSACTION_CLOSED` is fatal:
it means the work is already lost. Everything unrecognised is fatal, which is the safe default.

**4. The real defence is not the retry — it is not holding a write transaction across anything
slow.** Since the contender pays the holder's remaining idle window as latency, a holder that
pauses is charging every other writer for it. Two rules follow, and they bind [E.5] harder than
the retry does:

- **No await inside a write transaction except on the database.** Already spec §6 rule 7; this
  measurement is what prices it.
- **Batch the append.** Nineteen round trips instead of 254 is a smaller window in which a
  second writer can arrive at all.

**5. One write lane per database, which is what the driver already declares.** A second write
lane could only manufacture the contention above.

---

## Corrections to documents this epic is acting on

### 1. Spec §3.7 reads as a total-duration budget; it is an idle budget

Current text: remote interactive transactions lock the database "**with a 5-second server-side
timeout**", described as "a hard budget for any write transaction on the Turso backend".

| Arm | local `sqld` | hosted Turso |
|---|---|---|
| 20 s transaction, a statement every 2 s | **COMMITTED** after 20.1 s | **COMMITTED** after 21.6 s |
| 12 s transaction, one statement then a gap | FAILED — `STREAM_EXPIRED` | FAILED — `SQLITE_BUSY`, idle stream |

Every statement resets the clock, so what the budget bounds is the GAP. This matters in both
directions: a long chatty transaction is legal (the 250-row literal append takes 27.8 s and
commits), and a short one with a single slow await is not. The watchdog derived from
`writeBudgetMs` should therefore be measuring **time since the last statement**, not time since
`begin` — and if it measures the latter it will fire on transactions the server is perfectly
happy with.

### 2. `driver.ts` says a concurrent writer gets a busy error; it does not

`apps/server/src/store/executor/driver.ts` states in its header comment that on libsql remote
"writers are serialised by the platform and a concurrent writer gets a busy error". The
serialisation is real; the busy error is not — the contender blocks and then wins. The
`BusyRetryPolicy` the interface carries is still the right mechanism, for the idle-reaper error
and for whatever a loaded database does under real concurrency, but the comment overstates what
was measured.

### 3. drizzle-built SQL issued through a raw router returns rows keyed by COLUMN name

Not a correction to a document — a hazard that is going to bite Stage A and [E.5], found by
being bitten by it here.

drizzle's query builder emits the physical column names: `select "seq", "entity", "entity_id",
… from "changes"`. Only drizzle's own execution path applies the field mapping back to
`entityId`. A router-based client — which is what the [0.6] port is, and what this slice uses,
because the transaction must be opened through `client.transaction("write")` rather than through
drizzle — gets raw rows keyed `entity_id`.

Casting those rows to the drizzle row type **compiles, runs, and yields `undefined` for every
renamed column.** The first version of `changesSince` here did exactly that, and proof 3
reported `false` for a contract the engine was in fact keeping. Any driver handing drizzle-built
SQL to a raw connection has to map results back, and a cast will not tell it that it forgot.

---

## What the tests are worth

Seventeen assertions, `apps/server/src/store/spike/turso-append/turso-append.integration.test.ts`,
in the **integration lane** — the file is named `*.integration.test.ts`, which the unit lane
already excludes and the integration lane already includes, so no shared config or shard
manifest changed. `bun scripts/server-test-shards.ts verify` reports no drift.

They start a real `sqld` rather than using a fake, because every question they ask is about the
engine and the transport; a fake would answer all of them by construction. Without the binary
the suite **skips and says so** — it is not on `PATH` on every machine (`~/.turso/sqld` here;
`PODIUM_SQLD_PATH` overrides).

Every assertion was proven able to fail, and each mutation was checked to kill the test that
names the property rather than merely turning something red:

| Mutation | Test killed |
|---|---|
| seq range off by one (`last - count + 2`) | 9 of 17, including all three contiguity tests |
| commit instead of rollback on a failed append | *rolls the whole append back … INCLUDING the counter* |
| read rows by the drizzle field name (`r.entityId`) | *derives each range from the statement that wrote it* |
| head from `MAX(seq) FROM changes` | *reads the head from `sqlite_sequence`* |
| drop the savepoint around an in-transaction batch | *keeps a failed batch … from applying its prefix* |
| lease never expires (invert the expiry comparison) | *grants a free lease, refuses a held one, takes over an expired one* |
| always grant (drop the incumbent check) | that test **and** *costs a round trip for the decision …* |
| nested append does not roll back to its savepoint on failure | *rolls a FAILED nested append back to its savepoint* |

**One of those mutations survived first time round, and the test was wrong rather than the
mutation harmless.** The head-pruning test originally deleted `seq <= 150` of 200 rows — but
head-pruning removes the OLDEST rows, so the retained maximum was still 200 and
`MAX(seq) FROM changes` agreed with `sqlite_sequence` by accident. The test now prunes
everything, which is POD-678's actual "every row aged out" case: `MAX` is NULL and only the
high-water mark still knows where the log had got to. A partial-prune test was kept alongside
it, labelled as the weaker one.

---

## Reproducing

```bash
bun run setup:worktree

# the assertions, against a local sqld the test starts itself
bun --bun node_modules/vitest/vitest.mjs run --config vitest.integration.config.ts \
  apps/server/src/store/spike/turso-append/turso-append.integration.test.ts

# the measurements — `local`, `remote` or `both`
set -a; . ./.env; set +a
bun --conditions=@podium/source \
  apps/server/src/store/spike/turso-append/run-proofs.ts remote
```

Credentials come from the gitignored `.env` (`TURSO_SPIKE_URL`, `TURSO_SPIKE_TOKEN`); the
`turso://` scheme is rewritten to `libsql://` in `client.ts`, since the client refuses the
former outright. Nothing in the slice reads or prints a token.

## What is still open

| Item | Why it is not answered here |
|---|---|
| **Fly IAD → us-east-1** | Every millisecond above is from `flatblock`, not from the metro the app will run in. The round-trip COUNTS carry over unchanged; the latencies do not. Still blocked on a Fly token, as it was for POD-3251. |
| **Contention under real concurrency** | Two clients, one contending writer. Whether a loaded database ever produces a fast busy error — the case the retry policy is actually for — is untested. |
| **Whether the savepoint can be cheaper** | The insert's savepoint looks redundant and inlining `SAVEPOINT`/`RELEASE` into the batch array looks possible. Neither was measured; both are [E.5]'s to try. |
| **`locks` under contention** | The acquisition path is driven and measured above, but only uncontended. What two clients racing for the same lease do — given that a second writer blocks rather than failing fast — is untested. |
