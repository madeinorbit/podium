# POD-374 — web storage adapter: what was measured, and what was decided

Companion to `packages/sync/src/adapters/indexeddb/`. Everything here is either a
measurement taken on this branch or a decision with its source named.

---

## 1. OPFS — a recorded negative, not an evaluation that was skipped

The issue title says "transactional IndexedDB (evaluate OPFS)". **No OPFS spike was
run, and none should have been.** ADR 6 D2 already decided it, and the fan-out
protocol's resolution order (`docs/adr/` first) makes the ADR the higher authority
over an issue title written before it:

> **D2 — OPFS is not adopted (spike not run).** Origin Private File System (alone or
> hosting SQLite-wasm) is **not** adopted. IndexedDB remains the web default.
>
> | Pre-sign-off OPFS spike run as part of POD-752? | **No** |
> | Concrete threshold (IDB fails, OPFS passes)? | **None recorded** |
>
> **Reversal condition (only path to OPFS):** a spike filed under a child of
> POD-307/POD-374 produces a concrete, reproducible threshold that IDB fails and
> OPFS (or OPFS+SQLite-wasm) passes, **and** PWA bundle/precache cost is acceptable.
> Until then implementers must not re-open OPFS inside POD-374.

D2 also lists "Evaluate OPFS inside the web adapter issue" under *rejected
alternatives*, and ADR 6's compliance checklist puts "treats OPFS/SQLite-wasm as the
web default without meeting D2's reversal condition" under **out of compliance**.

So the honest deliverable is the negative: **OPFS was evaluated as a DECISION, found
already settled, and not re-opened.** The reversal condition is not met and this
issue produced no evidence that it should be — the shape of the work here gave no
sign of a threshold IndexedDB cannot meet:

| Signal that would argue for OPFS | What this issue observed |
|---|---|
| Multi-key writes cannot be made atomic | One `IDBTransaction` spans all three object stores; 53 adapter tests and 30 conformance cases hold D4.1 across crash and quota |
| Working set too large for IDB | The replica's five entity kinds are metadata rows; nothing here approaches an IDB limit |
| Bootstrap write latency | Not measured, and not measurable honestly against `fake-indexeddb`, whose timing is not a browser's — see §3 |

**What a future spike must produce to reverse D2** (so the next person does not have
to re-derive it): a reproducible threshold, in a real browser, where IndexedDB fails
and OPFS passes — plus the PWA bundle/precache cost. Anything short of that leaves
D2 standing.

---

## 2. What the ADR asked for, clause by clause

| ADR 6 clause | Where it lives | Where it is asserted |
|---|---|---|
| D1 — web durable engine is transactional IndexedDB | `store.ts`, `schema.ts` | the whole suite |
| D1 — in-memory adapter of the same port for tests / private mode / hard quota | `store.ts` degraded + unavailable modes | `store.test.ts` "no IndexedDB at all still yields a working replica" |
| D1 — localStorage for small UI preferences ONLY | nothing in the adapter names it | `quota.test.ts` D4.4.4, with a spy that has a positive control |
| D3 — one storage port, adapters behind it | implements `ReplicaCacheStore` + `OutboxStorePort` + `SyncUnitOfWork` | `conformance.test.ts` (suite unedited) |
| D4.1 — atomic multi-record commit | one `IDBTransaction` over all three stores | `crash.test.ts`, 4 boundaries |
| D4.2 — cursor-after-data | same transaction | `crash.test.ts` cursor-never-ahead |
| D4.3 — outbox durable on the same footing | same transaction, same commit | `crash.test.ts` (outbox is one of the three regions) |
| D4.4 — quota exhaustion, 5 clauses | `enqueueCommit` degrade path | `quota.test.ts`, one case per clause |
| D4.5 — corruption clears and cold-starts, never wedges boot | `open()` | `store.test.ts` VersionError poison |
| D4.6 — multi-tab version check | preconditions re-checked INSIDE the transaction | `store.test.ts` two tabs + counterfactual |
| D5.1 — IDB database version, forward-only, not drizzle-managed | `schema.ts` `REPLICA_SCHEMA_VERSION` | `store.test.ts` poison case |
| Normative note — happy-dom/Playwright conformance exercising kill-between-writes and quota-full | `conformance.test.ts` runs under happy-dom | §3 |

### Deliberately NOT done

**D6 (migration from today's localStorage/AsyncStorage replicas) is not implemented
here.** ADR 6 D6 says so itself: "Exact key inventory is POD-307 implementation
work; this ADR requires the upgrade-or-rebootstrap posture." POD-307 owns the client
wiring and therefore the key inventory. Building a legacy importer against a guessed
key set would be the mechanism-present-coverage-absent shape — an importer nothing
calls, matched against keys nobody confirmed.

**The adapter is not wired into `apps/web`.** `packages/sync` is tagged `node-only`
in `scripts/architecture-manifest.ts`, and the manifest platform rule forbids a
`browser-safe` workspace from importing a `node-only` one — so `apps/web` cannot
import this adapter today. Retagging `packages/sync` changes the dependency matrix
for every other consumer and is not this issue's diff. Filed as discovered work.

---

## 3. The environment measurement

Taken on this branch, and pinned as an assertion in
`packages/sync/src/adapters/indexeddb/environment.test.ts` so it fails the day it
stops being true:

| Environment | `indexedDB` | `window` | `localStorage` | `DOMException` |
|---|---|---|---|---|
| bun 1.3.14 (the test runtime) | **undefined** | undefined | undefined | — |
| node v22.22.2 | **undefined** | — | — | — |
| happy-dom 20.10.2 | **undefined** | object | object | function |

**No non-browser environment available to this repo ships IndexedDB.** So "green
under happy-dom" cannot mean "green against happy-dom's IndexedDB" — there is none.
`fake-indexeddb@6.2.5` is the engine under every lane, and choosing happy-dom over
node changes which DOM globals surround the adapter, not which engine it talks to.

`conformance.test.ts` runs under happy-dom anyway, because that is the environment
shape the web client will have and asserting the adapter tolerates it costs nothing.

**What `fake-indexeddb` does and does not buy.** It is a spec implementation with
real transaction semantics — request queues, transaction auto-close, and
abort-undoes-the-whole-batch — which is exactly what the crash and quota claims rest
on. It is NOT a source of timing evidence, which is why §1's latency row says "not
measurable honestly" rather than reporting a number. A Playwright lane against a real
browser engine would add timing and true multi-process behaviour; it is not in any
lane today (see `docs/agents/rewrite-fanout-ledger.md` on the 54 Playwright suites in
no lane) and adding one is not this issue's diff.

---

## 4. Mutation evidence

Five mutants, one per call. Each verified applied (match-count 1), hash-changed,
grep-backed, sole dirty source file, and **compiling** (`tsgo` exit 0) — a mutant
that fails to apply or fails to compile is non-evidence, not a kill.

| # | Mutant | Result |
|---|---|---|
| M1 | one transaction per staged write (the D10 non-compliance) | **KILLED** — 10 fail: 4 crash boundaries, D4.2, crash-is-not-quota, D4.4.1 |
| M2 | never flip durability on a quota error | **KILLED** — 3 fail: D4.4.2/3, D4.4.5, D4.4.4 |
| M3 | keep writing to IndexedDB while degraded | **KILLED** — 2 fail: D4.4.2/3, D4.4.5 |
| M4 | skip the in-transaction precondition re-check | **KILLED** — 1 fail: the two-tab case, and nothing else |
| M5 | hydrate the outbox without sorting by ordinal | **KILLED** — 2 fail: both FIFO-across-reload cases |

### The finding worth more than the kills

**Under M1 the conformance suite stayed green — all 30 cases.** `failNextCommit`
fires *before* the native transaction opens, so the suite's own
`base/crash-between-writes` gate cannot see a durable adapter that gives each write
its own transaction. The gate is correct for what it tests (the kernel's
one-transaction commit path) and blind to what a storage adapter does inside it.

So **"conformance green" is not on its own evidence for D4.1 on this engine**, and
`crash.test.ts` is not redundant with it. The same will be true for POD-375's SQLite
adapter, which is why this is written down rather than left as a property of one
branch.

M4's blast radius is the other half of the same point: exactly ONE case failed,
because the mirror-level precondition check still answers every single-connection
caller. A narrow kill is the correct outcome when only one arm depends on the
mechanism — a mutant that took down half the suite would have meant the two-tab case
was measuring something more general than it claims.
