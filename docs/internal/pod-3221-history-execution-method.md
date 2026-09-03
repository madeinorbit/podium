# Execution method for the drizzle async store epic (POD-3221)

Companion to `pod-3221-drizzle-async-store-plan.md` (the specification, revision 11.1). That
document says what the end state is and which rules apply. This one says in what order the work
lands, how every occurrence is found, how each one is judged, and how a problem that no rule
covers becomes an architectural decision instead of a local fix.

Revision 3 (2026-09-02). Revision 1 proposed a fifteen-family CI ratchet, six question sets and
per-slice reviewers: the v3 rearchitecture's shape, whose lessons apply (it took too long, its
instruments outlived it, implementers spent their time on ratchets). Revision 2 cut it to what
carries load. Revision 3 folds an independent review of revision 2 (issue artifact "Fable
review: execution method"), which verified that the shape is right and found seven places where
the method as written could not execute, could not say no, or contradicted the specification.
The changes are marked "rev 3".

## 1. What actually threatens completion, and what answers it

| Threat | Answer | Cost |
|---|---|---|
| A repository is left half-converted, or raw SQL survives on the drizzle type | **One lint rule family** over `store/**`, `modules/operations/store.ts` and the sync SQLite adapter, outside the search port: no import of `@podium/runtime/sqlite`, no `.prepare(`, no whole raw statement (`db.all/get/run/values(sql\`…\`)`), and the spec's §1.7 constructs inside `sql` template bodies. Its only allowlist is the `// DECISION POD-<n>` marker (§4). Deleting the executor's legacy handle field at Phase A exit is a second, free check. (Rev 3: type deletion alone cannot see a raw statement passed to drizzle's own `db.all(sql\`…\`)`.) | One permanent rule, proven to fire on a fixture in `check-boundaries.test.ts`. |
| A conversion changes behaviour and the tests are rewritten to match | Conversion commits may not modify an existing test assertion; test **setup** edits (direct repository constructions, probe seams) are allowed and listed in the commit message. The existing 1,840 store call sites in tests are the oracle. At the flip the rule is mechanical: changed test lines may differ only by `await`, `async`, or the helper rename. | None. A reviewer rule. |
| A call site drops a promise at the flip | **The flip is a codemod, not a hand edit** (rev 3): a script that inserts `await` before every call whose callee resolves to a repository or store method, regardless of position. Hundreds of store calls sit in statement position with the result discarded, and seven inside `if (…)`; after the port flip they compile clean and drop or always-pass. No floating-promise lint exists in this repo. Under the codemod every such site becomes "await in a non-async function" and the compiler enumerates them. Every branch that rebases across the flip runs the codemod before landing. | One script, deleted at Phase B exit. |
| Interfaces are guessed and the reviews' rework repeats | The two prototypes of spec step 3b before the large repositories convert. | A few days, once. |
| An async hazard the compiler cannot see survives the flip | **A ledger table in the flip issue**, one row per site by symbol: category, model chosen, commit that applied it (rev 3: replaces the inventory script, because mutable-state and I/O-in-span sites are not statically detectable, so a script would list zero for them by construction). The compiler under the codemod finds the detectable categories at the flip. | None in the repo. |
| The scheduler is wrong in a way the store tests cannot see | About ten deterministic interleaving tests of the scheduler, plus the step 14a **model tests** over an injected async persistence function that parks on a barrier (rev 3: a barrier test against the synchronous store cannot park anything and passes for any implementation). | Permanent, fast, small. |
| A JSON column loses its quarantine | The 23-column corrupt-blob table test, **written first, by the coordinator, against today's implementation**, its column list derived from `schema.ts` so a 24th column fails by name (rev 3: written after conversion by the worker who chose the behaviour it is a receipt, not an oracle). | One file, permanent. |
| Drizzle's own transaction or a drizzle import leaks out of the store | Two rules in `scripts/check-boundaries.ts`, beside the existing sync-kernel rule. | Permanent, cheap. |
| Hot paths regress in a way duration cannot show | **One script on the 5a attribution seam** (the raw-client wrapper), `--baseline <file>`, exit non-zero on increase; baselines are issue artifacts, never committed files. Frames per burst is one of the scheduler tests. (Rev 3: the existing query-count probes patch the `SqlDatabase` wrapper, which drizzle bypasses, so a script at that seam would read zero for every converted repository forever; 5a lands the seam and edits those probes before issues, users and repos convert.) | One script. |

Nothing else is added. Every temporary instrument is paired with a deletion issue in the tracker
(§5). Permanent additions: the lint rule family, the scheduler and model tests, the corrupt-blob
test, the two boundary rules, the measurement script.

## 2. The sequence

Four phases. Each exit gate is a command that exits zero, or is named as a human gate.

### Phase 0 — decide the interfaces and make every shared edit once

1. The two measurements are captured on today's probe seam first (issue 0.1); Stage A
   prerequisite 5a (attribution at the execution seam, issue 0.13) then moves the profiler and
   the three probe tests onto the client drizzle runs on and re-captures the baseline there. It
   depends on the executor object from item 2 and must land before issues, users and repos
   convert.
2. The executor prototype, now including the production scheduler with its tests, the token,
   ambient routing, the three post-commit mechanisms with synchronous implementations, and the
   **executor object** every repository will take: `{ drizzle, transact, legacy }`, where
   `transact` is a method (the raw handle is never exposed) and `legacy` is the field deleted at
   Phase A exit. The 14a model tests are written here too.
3. The dual-backend vertical slice (spec step 3b), unchanged.
4. Stage A prerequisites 5b to 5d; spec step 9 (retire the boot upgrades, so `store.ts` holds no
   raw SQL and the lint needs no allowlist); and the `queued_messages` and `upstream_outbox`
   table objects injected into the sync adapter's constructor, typed as drizzle tables, because
   the adapter reads those server-owned tables and a package cannot import from `apps/server`.
5. **The shared edits, once, by the coordinator** (rev 3): one commit makes the 34 constructor
   lines in `store.ts` take the executor; one commit sets `mode: 'boolean'` on every 0/1 column
   and records the 23 json-mode decisions (the drizzle snapshots do not record `mode`, so no
   migration results); the four `ord` migrations (`queued_messages`, `messages`,
   `automation_runs`, `repos`) land serially. No worker authors a migration or edits `schema.ts`
   or `store.ts` in Stage A.
6. The corrupt-blob table test, all 23 columns, against the synchronous implementation.
7. Coverage over `store/**`, once (`vitest --coverage`, scoped, not a gate): 18 of 38 repository
   files have no direct test file and about 131 of 455 public repository methods are never named
   in any test. Each brief carries its repository's list of uncovered methods.
8. The lint rule family lands with a fixture test proving it fires.

Exit: items 2 and 3 written into the spec as rules (human gate); items 1 and 4 to 8 landed;
`bun run lint:boundaries` green.

### Phase A — builder conversion, one agent per package, in waves

Stage A is embarrassingly parallel once the shared edits are done. The five large repositories
convert by family (shared selects and mappers first, one family per worker or commit,
cross-family spans with the last family). The small repositories convert in groups of three to
five by adjacency, one wave. Five to eight workers at a time as the box allows, each in its own
worktree, each producing one commit.

A worker's commit is its repository files, its golden tests (written **before** the conversion,
against the synchronous code, for the uncovered methods in its brief), and the setup edits of
tests that construct the repository directly. No `schema.ts`, no `store.ts`, no migration, no
corrupt-blob edit. Every site is answered against the Stage A checklist (§3), converted on the
sync forms, existing assertions untouched. A "no rule" site is converted literally with the
`// DECISION POD-<n>` marker and its decision issue is filed with the exact command in the brief;
the worker lands the rest of its package without waiting.

Review: one reviewer per wave against the Stage A checklist and the spec's §6.1, reading the
removed lines of any test file first; two reviewers for the five large repositories.

Exit: `bun run lint:boundaries` green with zero `DECISION` markers (a `grep` for the marker
is part of the gate script); `executor.legacy` deleted and
`bun run typecheck -- --filter=@podium/server` green; the corrupt-blob test green; the
measurement script green against the Phase 0 baseline.

### Phase B-prep — remove the async hazards while everything is still synchronous

Most of Stage B's real work, none of it needing the async ports, landable in small commits on
main. One agent per hazard category:

1. Hidden reads: constructors to `create()` shapes, getters to methods.
2. Array-callback store calls: batched reads before the loop.
3. Timers: single-flight guards.
4. Mutable process state: the step 14a audit, one model per registry, each model a small object
   over an injected persistence function, tested with an async fake that parks on a barrier.
5. I/O inside spans: each nested write classified into the three post-commit mechanisms, on the
   API shapes fixed by Phase 0 item 2.
6. The read-scope adoption: the fan-out passes and the frame caches move onto the synchronous
   read scope; the `forBatch` prefetch and admission-inside-the-read-scope land here under the
   synchronous implementation.
7. `SessionStore.open`, `openTestStore()`, the three shared test helper modules, the 481 test
   constructions; the await-preparation for tests, scoped as spec step 11a.

Exit: every row of the ledger table in the flip issue has a commit or a decision issue; the
twelve timing-sensitive suites the spec names are listed by name in the flip issue.

### Phase B.1 — the minimal flip

Freeze on `apps/server/src/**` and `packages/sync/src/**` (rev 3: the flip's red runs through
every module, and the modules take about forty commits a day), under the named lock
`freeze:pod-3221-flip`, renewed by the coordinator, stated in every concurrent session's brief
because a mailbox message does not reach a working agent. One integration branch. The
coordinator changes the port types and wires the scheduler built in Phase 0; the codemod awaits
every store call; the red is followed to green, in worktrees off the flip branch per module if
the box allows, merged into the flip branch. The twelve suites convert in the branch. A "no rule"
during the flip is resolved by the coordinator inside the freeze, not filed for later. Two
reviewers; the test-diff rule is mechanical. Every branch that rebases across the landed flip runs
the codemod before it lands, and the coordinator checks its output is empty at each landing
until the codemod is deleted.

Sizing (rev 3): with the scheduler, `open()`, `forBatch` and admission already landed, the flip
is about 620 repository signatures (codemod), 574 service call sites and their enclosing bodies
(codemod plus the red loop), 28 tRPC procedures, and the test constructions and call sites
already prepared. The mechanical closure is a day or two. What makes it longer: the twelve
suites, hazards B-prep could not see surfacing as flaky tests under real interleaving, the
package typecheck (scope it: `--filter=@podium/server`, concurrency 1), and the lease-gated full
suite.

### Phase B.2 — the post-flip list, on main, no freeze

One agent per item (rev 3: this list was placed nowhere in revision 2): exclusive operations for
the file-level subsystem through the scheduler; lifecycle states and awaited shutdown with the
parked-transaction test; the watchdog; the relay `create()` if B-prep did not finish it; the
three ADR amendments; deletion of the synchronous transaction helper, the synchronous port types,
the codemod, and the executor's legacy field if still present.

Exit: existing suite green; scheduler and model tests green; measurement script green; the
synchronous helper deleted and typecheck green; B.2's list complete; ADR 2, 6 and 9 amended
(human gate).

Stage B′ and the Postgres epic are outside this issue.

## 3. Two checklists

Every site is answered against the checklist for its phase. Each answer is a rule number from
the spec's §7 or a step number, or "no rule": see §4.

**Stage A, a query site or span.**
1. Which of the spec's §1.7 constructs does it use, and what replaces each: rowid class (step
   6), every column named on an upsert, which port for PRAGMA, `sqlite_master`, `lastInsertRowid`?
2. Which columns are JSON, and does the corrupt-blob test say quarantine or throw for each?
3. Which mapper lines are decisions and stay (rule 6), and which existed only because the driver
   returned `unknown` and go?
4. Do brands flow from `$type` (rule 3), or is a cast left, and why?
5. Does a span cross repositories, nest, or do read-decide-write, and does the conversion keep
   its boundaries and its immediate mode (rule 7)?
6. Does anything inside a span call something that is not the database (spec §1.5 item 8)?
   Note it in the ledger for B-prep; do not fix it here.
7. Does any bound parameter arrive as `undefined`, and what did the raw statement do with it?
8. Does a dynamic `IN` list bound the number of distinct SQL texts (the statement cache)?
9. Which test setups change (direct constructions, probes)? List them in the commit message.
10. Is the method on the brief's uncovered list? Then its golden test comes first.

**Stage B, a store consumer or state site.**
1. Is every call awaited, including statement-position and boolean-position calls? (The
   codemod's output for this file is empty.)
2. From what context is the store reached: handler, constructor, getter, callback, predicate,
   timer, boot, inside a write span?
3. Which §1.5 category, and which model: `create()`, batched read, single-flight, read scope,
   rights read under the lease, ambient routing?
4. Is a process-owned object mutated before commit or restored on failure, and which step 14a
   model applies?
5. Does the caller read a derived row immediately after a commit (the re-entrant timing
   contract)?
6. Does any await now sit between two reads a frame cache covered?
7. Which nested write becomes which post-commit mechanism, and does the outer promise wait for
   it?

## 4. When no rule covers a site

The worker converts the site in the most literal form and marks the line `// DECISION POD-<n>`,
the one token the lint allowlists (rev 3: `TODO` is banned and an unconverted raw statement has no
handle to run on once the constructor takes the executor). It files the decision with the exact
command from its brief:

    podium issue create --parent-id 3221 --outside-scope --title "Rule: <question>" \
      --description "<one plain sentence>" \
      --brief "<site, question, candidate rules, other sites the rule would apply to>"

The coordinator resolves it by amending the spec's §7, never the site, and sends the answer to
each affected worker's session with `--urgency interrupt`, because an issue-mailbox message does
not wake a working agent. Workers that own listed sites apply the rule in a follow-up commit. The
worker does not wait for the answer; it lands the rest of its package. The Phase A exit gate
requires zero markers.

Banned in converted files, checked by the lint where it can be and by the reviewer otherwise:
`as any`, `@ts-expect-error`, `biome-ignore`, `TODO`, `sql.raw` outside the search port, a
temporary second code path.

## 5. What is deleted, and when

The v3 deletion audit is still a blocking CI step today, months after its purpose ended, because
its deletion date lived in a document. So (rev 3): **when a temporary instrument lands, the same
issue creates its deletion issue, blocked by the phase-exit issue, with the file paths in the
brief.** The tracker holds the deletion; this table is the human summary.

| Instrument | Deleted at |
|---|---|
| The executor's `legacy` field | Phase A exit |
| The codemod | Phase B.2 |
| The synchronous transaction helper and the synchronous port types | Phase B.2 |
| The freeze lock | Flip merged |
| The ledger table | Lives in the flip issue; nothing to delete |
| This document's checklists | When the epic closes; the rules live in the spec's §7 |

Permanent: the lint rule family, the scheduler and model tests, the corrupt-blob test, the two
boundary rules, the measurement script. No test that pins the transition is written: the
existing suite, awaited under 11a while still synchronous, is the oracle in both stages.

## 6. Roles

A coordinator who owns the spec, the decisions, the shared edits of Phase 0, the freeze and the
landings, and converts no repository. Workers who own one package, one category, or one module
each, in their own worktree created with `bun run setup:worktree`, with a brief that names their
files, the checklist, their uncovered-method list, the decision command, the freeze lock name
while it is held, and the spec's §6.1 and §7. One reviewer per wave, two for the five large
repositories and the flip.

## 7. Which parts depend on the engine decision

**Decided 2026-09-03: SQLite dialect everywhere, bun:sqlite locally, hosted Turso remotely**
(spec section 5 decision 5). The analysis below is kept as the record of why the twenty
engine-independent items could be filed before the decision. Under the decision: no schema
twin, no second journal, no ordinal migrations; the lint's construct list shrinks to what a
remote connection cannot rely on; the PGlite spike became the Turso remote spike; the Postgres
allocator slice became the Turso sync-append proof; the durability subsystem goes behind a port
the Turso backend leaves empty; the cutover is a platform import; backend enablement is the
Turso version and is inside the epic's definition of done.

Two scenarios were open: **B**, Postgres in the cloud and SQLite self-hosted (the spec as
written), and **A**, Postgres everywhere, with PGlite embedded for desktop and starter installs
and real Postgres for scale. This section says what stays, what changes, and what can start now.

### 7.1 The query layer is the same choice in both scenarios

Under A, converting repositories to drizzle's Postgres tables would mean nothing converted can
run until the engine switches, so all 34 repositories, the schema, the journal and the cutover
tool would land in one branch: the v3 shape. A dialect-neutral builder (Kysely) keeps
per-repository landing under both scenarios: the converted repository runs on bun:sqlite today
and on PGlite or Postgres after a driver swap, and after the switch nothing forces a second
conversion. So the query layer is decided independently of the engine, and the PGlite spike
decides the engine only.

### 7.2 What stays, what changes

| Part | Same in both | Changes under A | Changes under B |
|---|---|---|---|
| Spec kernel design: unit of work, post-commit mechanisms, admission, mutable-state models, live grants | yes | | |
| Executor prototype: scheduler port with lanes, token, ambient routing, harness | yes (port) | the driver implementation delegates to PGlite's own transaction mutex | the driver implementation is our size-one queue |
| Phase 0: attribution seam, repos-cache invalidation, transaction lint, writer guard, step 9, sync-adapter table injection, corrupt-blob test, coverage run, measurements | yes | seam wraps the PGlite instance instead of the raw bun:sqlite client | |
| Phase 0: shared schema edits | column-mode decisions carry over | schema file becomes Postgres tables; no `ord` work (identity columns) | `ord` migrations, SQLite table forms |
| Phase A: per-repository conversion, waves, checklist, lint as proof | yes (with a dialect-neutral builder) | lint drops the SQLite-construct list; the cutover lands after the last repository | SQLite-construct list stays; twin later |
| B-prep: hidden reads, array callbacks, timers, mutable state, I/O in spans, read scope, `openTestStore`, await-prep | yes, entirely | | |
| The flip: port types, codemod, freeze, modules | yes | | |
| Post-flip list: lifecycle, watchdog, ADRs | yes | exclusive operations become dump and reload, not checkpoint and file copy | file-level subsystem through the scheduler |
| Feed-head allocator | one design | one implementation | two (`sqlite_sequence` stays; Postgres head row) |
| Full-text search | behind a port | `tsvector` once | FTS5 plus the port |
| Migrations journal | drizzle-kit | new Postgres journal from a baseline; cutover imports data | SQLite journal unchanged |
| Durability, transfer, snapshots, Litestream plan | | rewritten on datadir dump and reload; our own lock and crash recovery | unchanged |
| Cutover of existing installs | | mandatory for every install, at the switch | cloud only, later |
| Stage B′ and the Postgres epic | | shrink to "real Postgres is a driver plus operations" | full: schema twin, journal, search port, cutover |

### 7.3 What can start now, regardless

Engine-independent and already specified:

1. The measurements baseline against today's store (query count per request, frames per burst).
2. The coverage run over `store/**` and the per-repository uncovered-method lists.
3. The corrupt-blob table test against today's behaviour, all 23 columns.
4. Step 9: retiring the boot upgrades, which is deletion of legacy heals.
5. Store-owned invalidation for the repos registry cache (5b).
6. The sync adapter's table injection.
7. The executor prototype with the scheduler port, token, ambient routing, post-commit
   mechanisms and the interleaving harness, first implementation on bun:sqlite; the PGlite spike
   plugs a second implementation into the same harness.
8. B-prep categories 1 to 5 as soon as the prototype fixes the read-scope and transact shapes.
9. The Postgres half of the vertical slice: the feed-head allocator and locks on real Postgres,
   with PGlite as the test backend, needed in both scenarios.
10. The PGlite spike itself, in parallel with all of the above.

Waiting for the engine decision: the schema file's form, the `ord` migrations, the
SQLite-construct lint list, the durability and transfer rewrite, the cutover tool, and the shape
of Stage B′. Waiting for the query-layer decision: Phase A's first conversion and the writer-guard
replacement pattern (5d).

## 8. The issue tree (filed 2026-09-02)

Prefix gives the order; edges in the tracker give the real dependencies (`podium issue tree 3221`).

| Prefix | Issue | Depends on |
|---|---|---|
| 0.0 | POD-3242 Query layer confirmation (drizzle, two drivers) | none |
| 0.1 | POD-3243 Hot-path measurement baseline | none |
| 0.2 | POD-3244 Store coverage census | none |
| 0.3 | POD-3245 Corrupt-blob oracle test | none |
| 0.4 | POD-3246 Boot upgrades retirement | none |
| 0.5 | POD-3247 Repos cache invalidation seam | none |
| 0.6 | POD-3248 Executor prototype and harness | none |
| 0.7 | POD-3249 Sync adapter table injection | 0.0 |
| 0.8 | POD-3250 Turso sync-append proof | 0.6 |
| 0.9 | POD-3251 Turso remote spike | none |
| 0.10 | POD-3252 Store boundary lint family | 0.0, 0.4 |
| 0.11 | POD-3253 Issues writer-guard replacement | 0.0 |
| 0.12 | POD-3254 Shared schema and constructor edits | 0.3, 0.6 |
| 0.13 | POD-3281 Attribution at execution seam (step 5a; probes and profiler onto the client drizzle runs on) | 0.0, 0.6 |
| A | POD-3255 Repository conversion waves (placeholder) | 0.0, 0.4, 0.5, 0.10, 0.11, 0.12, 0.13 |
| B0.1 | POD-3256 Hidden store reads | 0.6 |
| B0.2 | POD-3257 Array-callback batched reads | none |
| B0.3 | POD-3258 Timer single-flight guards | none |
| B0.4 | POD-3259 Mutable process-state models | 0.6 |
| B0.5 | POD-3260 Span side-effect classification | 0.6 |
| B0.6 | POD-3261 Read-scope adoption and prefetch | 0.6, 0.1, 0.13 |
| B0.7 | POD-3262 Test store helper and awaits | 0.6 |
| B1 | POD-3263 Async port flip | A, B0.1–B0.7, 0.8 |
| B2.1 | POD-3264 Scheduler lifecycle and shutdown | B1 |
| B2.2 | POD-3265 Transaction watchdog | B1 |
| B2.3 | POD-3266 ADR amendments | B1 |
| B2.4 | POD-3267 Transitional instrument deletion | B1, B2.1 |
| E.1 | POD-3268 Engine decision record | closed 2026-09-03: decision taken |
| E.2 | POD-3269 Schema form and journal | archived 2026-09-03: not needed under one dialect |
| E.3 | POD-3270 Durability port for Turso | B1, B2.1 |
| E.4 | POD-3271 Turso database import | E.5 |
| E.5 | POD-3272 Turso backend enablement | B1, 0.9, E.3 |

Ready at filing time: 0.0 to 0.6, 0.9, B0.2, B0.3. The only remaining placeholder is A, filled
after 0.0 and its Phase 0 prerequisites are green. E.3 to E.5 are real issues on the Turso path
and inside the epic's definition of done.
