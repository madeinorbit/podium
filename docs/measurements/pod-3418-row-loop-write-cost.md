# POD-3418 — What a row-by-row write loop costs after the drizzle conversion

Measured 2026-09-04 on the epic's integration tip (`9d7925519`), bun 1.3.14, one box.

## What was asked, and what the answer is

POD-3416 found that a 250-row `appendChanges` went from 2.1 ms to 29.7 ms across the
conversion while issuing **the same 253 statements**. The question was whether that matters
in real use, and what gate would have caught it.

It matters, it is larger than the microbenchmark suggested, and **a drizzle prepared
statement removes it entirely**. That last point is new: POD-3416 measured a *statement*
cache inside `clientOverWrapper` and found it false, and concluded a cache "does not address
it". A cache at that seam does not. `.prepare()` on the **builder** does, because it hoists
the thing that actually costs — building the SQL string — out of the loop.

---

## 1. The exposure, derived rather than recalled

Derived from the AST (a `for`/`while`/`.forEach`/`.map` ancestor of a drizzle write call
whose statement terminates in `.run()`/`.returning()`/`.get()`/`.all()`), over every file in
the store boundary (`apps/server/src/store/`, `packages/sync/src/adapters/sqlite/`, plus
`apps/server/src/modules/operations/store.ts`) minus the three on `STAGE_A_UNCONVERTED`.

**21 row-loop write sites, in 7 of the 37 converted files that write at all.**

| site | rows per call in realistic use | how often | verdict |
|---|---|---|---|
| `conversations/index.ts:107` `upsert` | **whole corpus — 1663 on this machine** (`discovery.db` `conversation_cache`) on a `full: true` snapshot; the periodic delta otherwise | every daemon connect/reconnect and every on-demand scan; the 15 s periodic loop sends only the delta | **worst** |
| `sync-repository.ts:222/236` `applyLatestChangeStates` | one per appended change; a cold-index snapshot appends the whole corpus | every `ledger.commit`, including the one the sweep above wraps | **worst** |
| `transcript-costs.ts:127` `record` | ~400 (`service.ts`: "a 7-day harvest is ~28,000 usage records across ~400 transcripts") | per cost harvest | third |
| `issues.ts:916` `assignRepoIdToIssuesUnder` | every issue under a repo path — 3400+ on this tracker | one-off repo-identity upgrade | one-off |
| `issues.ts:857` `renumberCollidingIssueSeqs` | colliding rows only, normally 0 | every boot (`store.ts:382`) | noise |
| `conversations/index.ts:162` `delete` | removed ids per sweep | with the sweep | small |
| `issues.ts:1232`+`1244` `markIssueMessagesRead` | 2 writes per named message | per read-marking | small |
| `issues.ts:969` `setIssueLabels` | labels on one issue | per label edit | noise |
| `sessions.ts:384` `softDeleteSessions`, `sessions.ts:668` `listSnoozes` | session ids in one op; expired snoozes | per delete / per read | small |
| `repos.ts:427`, `repos.ts:516` | repos on one machine | registry edits | small |
| `shipping.ts` ×5 (`claimTrain`, `isolateTrainFailure`, `invalidateActiveLane`, `cancelAttemptAndOrder`, `raiseHold`) | members/orders in one train | per train operation | small |

The two "worst" rows are measured below. The rest are bounds read off their call sites, not
measurements, and are labelled as such.

---

## 2. End-to-end, through the real repositories

Not a microbenchmark: `openTestStore` builds a **real migrated `SessionStore`** through the
production path, and the numbers are the real `ConversationIndexRepository.upsert` and
`SyncRepository.appendChanges` called on it. Three arms, produced by editing the method and
re-running the same harness, so every arm is the same call through the same seam.

- **HEAD** — the drizzle builder constructed per row (what ships today).
- **raw prepared** — the pre-conversion shape: one prepared statement, run per row. This is
  the "named exemption" option, and it is byte-for-byte the SQL the file had before
  `403a628f3` / `da5df190d`.
- **drizzle `.prepare()`** — the same drizzle builder, with `sql.placeholder` values,
  `.prepare()`d once per site and `.run(values)` per row.

On-disk WAL database (what self-hosted Podium actually runs), median of 5:

| | n | HEAD | raw prepared | drizzle `.prepare()` |
|---|---|---|---|---|
| `conversations.upsert` (no-op rows) | 250 | **82.5 ms** | 3.9 ms | 4.1 ms |
| `conversations.upsert` (no-op rows) | **1663** | **487.5 ms** | 12.8 ms | 15.9 ms |
| `sync.appendChanges` | 250 | **30.3 ms** | 8.7 ms | 8.9 ms |
| `sync.appendChanges` | **1663** | **180.7 ms** | 50.0 ms | 54.0 ms |

In-memory database, median of 7, same ordering: `conversations.upsert` n=1663 is
542.2 ms / 9.3 ms / 13.9 ms. **Disk does not hide it** — the cost is CPU, and a real
file-backed WAL database has no more of it to spare than an in-memory one.

`sync.appendChanges` reproduces POD-3416's number (30.3 ms here against their 29.7 ms at
n=250), which is what says the harness is measuring the same thing they were.

### Per-row cost is not a constant

The coordinator's minimal case gave ~0.06 ms per row. The real worst site is **~0.29 ms per
row** — five times that. The difference is statement complexity: the conversation upsert's
`setWhere` guard is an eleven-clause `sql` template with thirty-odd interpolated column
references, and every row rebuilds and re-serialises all of it. **The overhead scales with
how complicated the statement is**, so a microbenchmark on a simple upsert is a floor, not an
estimate.

At n=1663, **97% of the 488 ms is builder construction** (488 → 13 with the statement
hoisted).

### The arms write the same thing

An equivalence oracle runs a scripted sequence through the real repository — insert, an
identical re-offer that the guard must skip, a changed field, a null-bearing row, a re-offer
with nulls that must not erase, a parent link, a delete — and digests the table. All three
arms are **identical**.

The oracle was **canaried**: dropping one `COALESCE` from the raw arm's SET list at first
produced an identical digest, because every null-bearing re-offer in the original sequence
was skipped by the guard before the SET list ever ran. A case that *changes* while carrying
nulls was added; the canary then failed the digest, and only then was the pass worth
anything.

---

## 3. Why the existing gate cannot see this, and what can

`scripts/measure-hot-paths.ts` budgets **statement executions per request**. Counted at the
same seam, on the same warm 250-row upsert:

| arm | SQL constructions (`session.prepareQuery`) | statement executions | wall |
|---|---|---|---|
| HEAD drizzle builder | **250** | 250 | 69.8 ms |
| drizzle `.prepare()` | **0** | 250 | 1.7 ms |
| raw prepared | **0** | 250 | 1.1 ms |

Executions are identical in every arm. A queries-per-request budget is blind to this entire
class *by construction*, exactly as the brief said. SQL constructions separate the arms
perfectly.

**The proposed gate: count SQL constructions per operation, and assert they do not scale with
row count.** Run a named write loop at `n` and `10n`; executions are expected to grow ~10×,
SQL constructions must not. That is a ratio over two counts, so it is stable on a shared box
in a way a wall-clock budget is not.

**Count at `SQLiteSession.prepareQuery`, not at the client.** `prepareQuery` is where the
builder becomes SQL text; it sits above every statement cache. Verified: installing a
`clientOverWrapper`-style statement memo leaves `prepareQuery` at 250 and leaves the wall
unmoved (67 ms vs 70 ms) — the memo hides the symptom at the client seam without fixing
anything, which is exactly the trap a client-level counter would fall into.

---

## 4. The cloud path is less safe than the framing assumes

The brief's arithmetic holds for `appendChanges`: 253 statements × 3–5 ms is 750–1250 ms of
Turso round trips, against which 28 ms of CPU is 2–4%. But two things do not follow.

1. **At the conversations site the ratio is worse.** 1663 statements is 5–8 s of network
   against 488 ms of CPU — 6–10%, not 2%.
2. **Network time is awaited; builder time is not.** Those 488 ms are synchronous JavaScript.
   They block the event loop, so on a shared server they are paid by *every* concurrent
   request, while the network wait costs the requester alone. This is not hypothetical at
   this exact site: POD-1931's comment in `conversations/index.ts` records 1650 of these
   writes "inside a single 757 ms event-loop stall" on the live server.

So the correct statement is not "irrelevant on the cloud path". It is: **on Turso the
network dominates the requester's latency, and the builder cost still dominates the server's
event loop.**

---

## 5. Recommendation

**Do not accept it at the two worst sites; do accept it everywhere else.**

- **Fix `conversations/index.ts` `upsert` and `sync-repository.ts`
  `applyLatestChangeStates`** by hoisting a `.prepare()`d builder per site. Measured: 488 ms
  → 16 ms and 181 ms → 54 ms, table contents identical under a canaried oracle. This needs no
  exemption, no raw handle and no second code path — it stays inside drizzle and inside the
  seam, so nothing about the epic's boundary rules changes. It is also within a few percent
  of the raw statement, so the "named exemption like POD-3404's" option buys nothing over it
  and costs a permanent hole in rule 13. **Prefer `.prepare()`; do not open an exemption.**
- **Accept the other 19 sites.** Their `n` is bounded by labels on one issue, repos on one
  machine, or members of one train. At 0.06–0.3 ms per row the worst of them is under a
  millisecond, and hoisting a prepared statement into each would be nineteen sites of
  complexity bought with nothing.
- `transcript-costs.ts` `record` at n≈400 is the borderline one. It is worth roughly
  40–120 ms per harvest by extrapolation; it was **not** measured end to end here, and the
  decision on it should be taken on a measurement rather than on this sentence.
- **Add the SQL-constructions gate before B1**, not after. The flip makes every one of these
  loops async; a gate that budgets executions will stay green through it, and a builder
  constructed per row inside an async loop is the same cost with a harder stack to read.

### What must be checked before any of this is implemented

`.prepare()` with `sql.placeholder` is a shape this repository does not use yet. It was
exercised here on two sites and its output digested against HEAD's, but it has not been run
against the full suite, and B1's async flip changes what `.prepare()` returns. Whoever
implements it owns that; this issue owns the measurement.
