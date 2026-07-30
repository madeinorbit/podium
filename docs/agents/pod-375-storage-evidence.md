# POD-375 — mobile storage adapter: what was measured, and what was decided

Companion to `packages/sync/src/adapters/mobile-sqlite/`. Everything here is either a
measurement taken on this branch or a decision with its source named. Written as the
sibling of `docs/agents/pod-374-storage-evidence.md`, which is this adapter's template.

---

## 1. The finding POD-374 handed forward, re-measured here

POD-374's most important result was that **the shared conformance suite is blind to
what a storage adapter does inside the kernel's transaction**: it applied a mutant
giving each staged write its own transaction — the ADR 2 D10 non-compliance verbatim —
and all 30 conformance cases stayed green, because `failNextCommit` fires *before* the
adapter's native transaction opens.

**That reproduces exactly on SQLite.** Mutant M1 below gives every staged statement its
own `BEGIN IMMEDIATE … COMMIT`. Under it:

| suite | result under the D10 non-compliance |
|---|---|
| `conformance.test.ts` — the 30 shared cases | **all green** |
| `conformance.test.ts` — this adapter's own binding guard | green (it checks the engine, not atomicity) |
| `crash.test.ts` | **4 of 8 fail** |
| `quota.test.ts` D4.4.1 | **fails** |

So a green conformance run on this adapter means *it satisfies the kernel's storage
contract*. It does **not** mean entities, cursor and outbox commit together. The second
claim is `crash.test.ts`'s alone, and that is stated in the header of
`conformance.test.ts` rather than left for a reader to infer.

---

## 2. What the ADR asked for, clause by clause

| ADR 6 clause | Where it lives | Where it is asserted |
|---|---|---|
| D1 — mobile durable engine is SQLite | `store.ts`, `schema.ts` | the whole directory |
| D1 — concrete package chosen at POD-375 | `sql.ts` `fromExpoSqlite` | `sqlite-shim.test.ts` (see §4) |
| D1 — in-memory adapter of the same port when the engine is absent | `store.ts` unavailable mode | `store.test.ts` "no usable SQLite at all still yields a working replica" |
| D1 — AsyncStorage for small UI preferences ONLY | nothing in the adapter names it | `quota.test.ts` D4.4.4, source detector + global spy, both with controls |
| D3 — one storage port, adapters behind it | implements `ReplicaCacheStore` + `OutboxStorePort` + `SyncUnitOfWork` | `conformance.test.ts` (suite unedited) |
| D4.1 — atomic multi-record commit | one `BEGIN IMMEDIATE` over all tables | `crash.test.ts`, 4 boundaries |
| D4.2 — cursor-after-data | same transaction | `crash.test.ts` cursor-never-ahead |
| D4.3 — outbox durable on the same footing | same transaction, same commit | `crash.test.ts` (outbox is one of the three regions) |
| D4.4 — quota exhaustion, 5 clauses | `commitSpan` degrade path | `quota.test.ts`, one case per clause |
| D4.5 — corruption clears and cold-starts, never wedges boot | `open()` | `lifecycle.test.ts` corrupt-file case |
| D4.6 — multi-tab/multi-process version check | preconditions re-checked INSIDE the transaction | `store.test.ts`, two connections + counterfactual |
| D4.7 — mobile lifecycle | no flush hook anywhere | `lifecycle.test.ts`, behaviourally and structurally |
| D5.1 — bespoke integer `schema_version`, forward-only, not drizzle-managed | `schema.ts` | `lifecycle.test.ts` newer-version case + counterfactual |

### Decisions taken at forks

No human was in this loop, so each was resolved from `docs/adr/` and recorded in the
commit that made it.

**The concrete package is `expo-sqlite`** (D1 says "native driver; concrete package
chosen at POD-375"). The binding requirement is not "SQLite" but **SQLite through a
synchronous API**, because D4.7 requires transactions to commit *before* the adapter
resolves the kernel write, and `SyncSpanParticipant.publish` may not await. In the
managed Expo workflow `apps/mobile` already runs (`expo ~57`), `expo-sqlite` is the
SQLite with a synchronous API. It is named in exactly one file and typed
structurally, so `packages/sync` takes no React Native dependency.

**`schema_version` is a row, not `PRAGMA user_version`.** D5.1 asks for an integer
version "inside the SQLite DB". `user_version` is a header field any tool can set and
carries no room for provenance; a table participates in the same transaction as
everything else.

**No migration runner was built.** At version 1 there is no earlier version in
existence, so a forward migration would be a mechanism with no caller — the shape this
run has repeatedly paid for. Both off-version arms take ADR 6 D6's
upgrade-or-rebootstrap posture instead, and both are tested. The comment in `open()`
names the spot a version-2 migration goes.

### Deliberately NOT done

**The adapter is not wired into `apps/mobile`, and this is the same blocker as
POD-1195.** Measured, not assumed: `scripts/architecture-manifest.ts` tags
`packages/sync` `node-only`, tags `apps/mobile` `browser-safe`, and the platform rule
refuses a browser-safe → node-only edge. POD-1195 was filed against `apps/web` for the
identical cause; **mobile is a second consumer of the same decision, not a second
issue.** Retagging `packages/sync` changes the dependency matrix for every consumer and
is not this issue's diff, so it is reported rather than done.

**ADR 6 D6's legacy AsyncStorage import is not implemented here.** D6 says the key
inventory is POD-307 implementation work, and `apps/mobile`'s current bridge
(`MobileClientProvider.tsx` → `createAsyncStorageReplicaStorage`) is POD-307's to
retire. Building an importer against a guessed key set would be mechanism-present,
coverage-absent.

---

## 3. The environment measurement

Taken on this branch, and pinned as an assertion in `environment.test.ts` so it fails
the day it stops being true.

| lane | runtime | `bun:sqlite` | `node:sqlite` |
|---|---|---|---|
| repo root `test:unit` (`bun --bun vitest`) | bun 1.3.14 / node v24.3.0 | **present** | absent ("No such built-in module") |
| `packages/sync`'s own `bun run test` | node v22.22.2 | absent | **present** (`DatabaseSync`) |

**Neither lane has the other's engine**, so a suite hard-coded to one fails in the
other for a reason that looks like a product bug. `resolveSqliteEngine` tries both and
**throws if neither is present** — it never substitutes an in-memory imitation, because
a fake engine would leave every crash and quota case green while proving nothing. That
refusal is itself tested.

Both engines are real SQLite: `BEGIN IMMEDIATE`, `ROLLBACK` that undoes the whole
batch, and a file that outlives the connection. Tests use a real **file** in a temp
directory rather than `:memory:`, because "the process died and the data survived" is
the claim under test and an in-memory database dies with the connection — every crash
case would then pass by finding nothing.

### What no lane here provides

**The device.** iOS/Android filesystem behaviour, genuine disk exhaustion, the OS
reclaiming a backgrounded process, and `expo-sqlite` itself are not exercised by
anything in this repo. `sqlite-shim.test.ts` proves the MAPPING onto expo's documented
synchronous surface over a real engine; it does not prove expo. Closing that needs a
device or simulator lane, which does not exist here (see the ledger on the 54 Playwright
suites in no lane) and is not this issue's diff.

Also not measured: **timing**. No latency number is quoted anywhere, because neither
lane's filesystem is a phone's.

---

## 4. Instruments, and what each one's refusing arm depends on

The run's dominant defect is a gate whose refusing arm the environment cannot produce.
Each instrument here is listed with the fact its "no" needs.

| instrument | its "no" needs | control proving it can say "yes" |
|---|---|---|
| `crash.test.ts` boundaries | a fault at statement N of a LIVE transaction | positive control: no fault ⇒ POST in all three regions; `writesIssued` asserted per case |
| `crash` mode (vs `deny`) | a connection where `COMMIT` *and* `ROLLBACK` throw | `isDead` asserted true only for `crash` |
| `quota.test.ts` D4.4.1 | statement 0 already issued when 1 is denied | `writesIssued` moved by ≥ 2 before reading the store |
| D4.4.4 source detector | a forbidden name in CODE, not prose | finds all 8 spellings planted in code; does not fire on comments; still finds a needle beside a comment |
| D4.4.4 localStorage spy | the global to be reachable | records its own probe write first |
| D4.6 re-check | a SECOND CONNECTION with its own mirror | counterfactual: an up-to-date belief commits |
| D5.1 forward-only | a file stamped at a version this build lacks | counterfactual: at the current version the same file is read back, not cleared |
| lifecycle "no flush hook" | a real prototype to inspect | asserts `close`/`durability`/`open` ARE found |
| `resolveSqliteEngine` | no engine present | the real resolution succeeds, so the refusal is about absence |
| conformance binding guard | rows in a real file | asserts empty BEFORE and populated AFTER |

The one deliberate asymmetry: the D4.4.4 clause could not use POD-374's instrument.
`localStorage` is a global and can be spied on; **AsyncStorage is an imported module**,
so a runtime spy cannot observe it at all and an absence "proved" that way would be
vacuous. Hence the source-text detector — and mutant M7 shows it fires against the
product, not only against its own planted fixture.

---

## 5. Mutation evidence

Seven mutants, one per call. Each verified applied (match-count 1), hash-changed,
grep-backed, sole dirty file, and **compiling** (`tsgo` exit 0) — a mutant that fails to
apply, fails to compile, or patches a value to what it already was is non-evidence, not
a kill. The tree was verified clean after the last revert.

| # | Mutant | Result |
|---|---|---|
| M1 | one transaction per staged statement (the D10 non-compliance) | **KILLED** — 5 fail: 4 crash boundaries + D4.4.1. **All 30 conformance cases stayed green.** |
| M2 | never flip durability on a quota error | **KILLED** — 3 fail: D4.4.2/3, D4.4.5, D4.4.4 |
| M3 | keep writing to SQLite while degraded | **KILLED** — 3 fail: D4.4.2/3, D4.4.5, and the unavailable-mode case |
| M4 | skip the in-transaction precondition re-check | **KILLED** — exactly 1 fails: the two-connection case, and nothing else |
| M5 | hydrate the outbox in primary-key order | **KILLED** — exactly 1 fails: the cold-start FIFO case |
| M6 | defer the commit to a microtask (write-behind — the D4.7 shape) | **KILLED** — 21 fail across every suite |
| M7 | the adapter names AsyncStorage in code | **KILLED** — exactly 1 fails: the D4.4.4 source detector |

**M4's and M5's blast radius is the point, not a weakness.** One failure each is the
correct outcome when exactly one arm depends on the mechanism; a mutant that took down
half the directory would mean those cases were measuring something more general than
they claim. M6's breadth is equally informative in the other direction: write-behind is
not a local defect, and the suite says so.

**M1 is the result this issue exists to produce.** It is the second independent
measurement — after POD-374's, on a different engine — that the shared conformance suite
cannot see the ADR's central durability requirement. Any future adapter inherits the
suite *and still needs its own crash test*.

---

## 6. Two defects found by gates the test lane could not have caught

Recorded because both were green across 70 passing tests.

**A required field, found by the in-package typecheck.** `EntityRecord.provenance` is
required; hydrate assigned `undefined` for a nullable column. Every row the tests write
has provenance, so the branch never ran. Fixed by making the column `NOT NULL`, which
makes the bad state unrepresentable rather than handled. The instrument was probed
first: a `@ts-expect-error` with nothing to suppress reported TS2578.

**A raw NUL byte, found by `check-no-nul-bytes`.** `rowKey`'s separator was written as a
literal `0x00`, which makes the file binary — `grep -n` and agent search wrappers answer
"no match" for code that is right there. NUL is still the correct separator; it is now
written as an escape.

Two more were found while writing the tests and are recorded in the commits: a
vestigial `durable` promise that became an unhandled rejection on the throwing path,
and a `readDurable` helper that CREATED the tables it was sent to observe (which would
have reported "no rows" identically for a store that never created a table, and which
deadlocked against a crashed connection's write lock — that is how it was found).
