# Execution method for the drizzle async store epic (POD-3221)

Companion to `pod-3221-drizzle-async-store-plan.md` (the specification, revision 11). That
document says what the end state is and which rules apply. This one says in what order the work
lands, how every occurrence is found, how each one is judged, and how a problem that no rule
covers becomes an architectural decision instead of a local fix.

Revision 2 (2026-09-02). Revision 1 proposed a fifteen-family CI ratchet, six question sets and
per-slice reviewers. That was the v3 rearchitecture's shape, and the v3 lessons apply: it took
too long, its instruments outlived it, and implementers spent their time on ratchets instead of
the work. This revision keeps the four things that carry load, deletes the rest, and gives
every remaining instrument a deletion date.

## 1. What actually threatens completion, and what answers it

| Threat | Answer | Cost |
|---|---|---|
| A repository is left half-converted, or a site is missed | Two database types during Stage A; converted repositories take the drizzle one; when the last converts, the legacy type is deleted and the compiler reports anything left. Stage B does the same with the port types: change them, follow the red until green. | None ongoing. The types are deleted at the gate. |
| A conversion changes behaviour and the tests are rewritten to match | Conversion commits may not modify an existing test assertion. The existing 1,840 store call sites in tests are the oracle. | None. A reviewer rule. |
| Interfaces are guessed and the reviews' rework repeats | The two prototypes of spec step 3b before the large repositories convert. | A few days, once. They decide the executor, scheduler, post-commit and dialect-query shapes. |
| An async hazard the compiler cannot see (frame cache, hidden read, mutable object, timer, I/O in a span) survives the flip | One inventory script, run at the B-prep gate, listing sites by category. The counts are in the tens, not hundreds, and the reviews already listed most of them with file and line. | One script, deleted after the flip. |
| The scheduler is wrong in a way the store tests cannot see | About ten deterministic interleaving tests of the scheduler itself: serialisation, re-entrancy, stale token, publication order, re-entrant commit timing, frames per burst, parked body at shutdown. | Permanent, fast: they test a new component. |
| A JSON column loses its quarantine | One table-driven test over the 23 json-mode columns that plants a corrupt blob per column and asserts the load survives. | One file, permanent. |
| Drizzle's own transaction or a drizzle import leaks out of the store | Two rules in `scripts/check-boundaries.ts`, beside the existing sync-kernel rule. | Permanent, cheap. |
| Hot paths regress in a way duration cannot show | Query count per request and frames per burst, captured by a script at the gates. Two numbers, compared by hand. | A script, not a test. |

Nothing else is added. There is no CI baseline file, no `--phase` close gate, no conformance
trace suite, no per-slice reviewer, no decision digest. Every instrument above has a deletion
date in §5 except the four permanent ones (the scheduler tests, the corrupt-blob test, the two
lint rules, and the two measurement scripts).

## 2. The sequence

Four phases. Each exit gate is a command that exits zero or a number that did not go up.

### Phase 0 — decide the interfaces

1. Capture the two measurements (query count on feed bootstrap and issue frame reads; frames
   per burst on the boot reconcile).
2. The executor prototype: queue, token, savepoints, the three post-commit mechanisms, ambient
   routing, async close, a service-shaped closure and the cross-service span.
3. The dual-backend vertical slice: locks, one aggregate with joins and JSON, the sync append
   with the feed-head allocator, boot and shutdown, on real SQLite and Postgres. It chooses the
   dialect-query strategy and the schema-twin technique.
4. Stage A prerequisites 5a to 5d: attribution at the execution seam, repos-cache invalidation,
   the two lint rules, the writer-guard replacement.
5. The scheduler's interleaving tests exist (they are written against the prototype).

Exit: the decisions from 2 and 3 are written into the spec as rules; 5a to 5d landed.

### Phase A — builder conversion, one agent per repository

Stage A is embarrassingly parallel: 34 repositories, each a file, each converted against the
same spec, each touching one line of the composition root. So it runs as waves of workers, one
per repository, five to eight at a time as the box allows, each in its own worktree, each
producing one commit (two where a schema-only commit precedes it). The coordinator lands them
serially behind the merge lock; the composition-root line is the only overlap and rebases
cleanly.

Order: the small aggregates in the first waves, the five large repositories last, each of those
split by family (shared selects and mappers first, then one family per worker or per commit,
cross-family spans with the last family).

Per repository, the worker answers the Stage A checklist (§3) for every site, converts on the
sync forms, leaves existing tests untouched, adds its rows to the corrupt-blob table test, and
stops on any "no rule" (§4).

Review: one review pass per wave, by one reviewer, against the Stage A checklist and the spec's
§6.1, with the removed lines of any test file read first. The five large repositories get two
reviewers.

Exit: the legacy database type is deleted and typecheck is green; the SQLite-construct grep over
`store/**` outside the search port returns nothing; the corrupt-blob test covers all 23 columns;
the two measurements did not go up.

### Phase B-prep — remove the async hazards while everything is still synchronous

Most of Stage B's real work, none of it needing the async ports, all of it landable in small
commits on main. One agent per hazard category rather than per file, because a category is a
few to a dozen sites that want one consistent treatment:

1. Hidden reads: constructors to `create()` shapes, getters to methods.
2. Array-callback store calls: batched reads before the loop.
3. Timers: single-flight guards.
4. Mutable process state: the step 14a audit, one model per registry, the same-entity barrier
   tests written against the synchronous implementation.
5. I/O inside spans: each nested write classified into the three post-commit mechanisms.
6. The read-scope and transact API shapes, introduced with synchronous implementations so the
   fan-out passes and the frame caches adopt the read scope before its semantics change.
7. The `openTestStore()` helper and the three shared test helper modules; the await-preparation
   for tests, scoped as spec step 11a.

Exit: the inventory script lists zero sites in categories 1 to 6, or each remaining site is
named in the flip issue with a reason.

### Phase B — the flip, then the modules

1. The flip: one branch, one agent plus the coordinator, days not weeks, under a freeze on the
   store, the sync package and the relay that other sessions respect through a lock name. It
   changes the port types, lands the scheduler, the token, ambient routing, the post-commit
   mechanisms, admission inside the read unit of work, the `forBatch` prefetch and
   `SessionStore.open`, and follows the red until typecheck is green. Two reviewers. The
   scheduler tests and the existing suite are its gate.
2. Modules top-down, one agent per module in waves as in Phase A, each converting its store
   call sites and its constructor reads, each reviewed against the Stage B checklist.
3. Delete the synchronous transaction helper and the synchronous port types; typecheck proves
   nothing needs them.

Exit: existing suite green; scheduler tests green; the two measurements did not go up; the
synchronous helper deleted; the three ADR amendments landed.

Stage B′ and the Postgres epic are outside this issue.

## 3. Two checklists

Every site is answered against the checklist for its phase. Each answer is a rule number from
the spec's §7 or a step number, or "no rule": see §4.

**Stage A, a query site or span.**
1. Which of the spec's §1.7 constructs does it use, and what replaces each: rowid class (step
   6), every column named on an upsert, which port for PRAGMA, `sqlite_master`, `lastInsertRowid`?
2. Which columns are JSON, and is each quarantined or throwing (rule 4)?
3. Which mapper lines are decisions and stay (rule 6), and which existed only because the driver
   returned `unknown` and go?
4. Do brands flow from `$type` (rule 3), or is a cast left, and why?
5. Does a span cross repositories, nest, or do read-decide-write, and does the conversion keep
   its boundaries and its immediate mode (rule 7)?
6. Does anything inside a span call something that is not the database (spec §1.5 item 8)?
   Note it for B-prep; do not fix it here.
7. Does the oracle cover this statement? If thin, which golden test is added first?
8. Is the statement on a hot path, and does it need `prepare()`?

**Stage B, a store consumer or state site.**
1. From what context is the store reached: handler, constructor, getter, callback, predicate,
   timer, boot, inside a write span?
2. Which §1.5 category, and which model: `create()`, batched read, single-flight, read scope,
   rights read under the lease, ambient routing?
3. Is a process-owned object mutated before commit or restored on failure, and which step 14a
   model applies?
4. Does the caller read a derived row immediately after a commit (the re-entrant timing
   contract)?
5. Does any await now sit between two reads a frame cache covered?
6. Which nested write becomes which post-commit mechanism, and does the outer promise wait for
   it?
7. Which scheduler test or barrier test proves it?

## 4. When no rule covers a site

The worker stops on that site, leaves it unconverted with a one-line comment naming the
question, and files a decision sub-issue under the epic with the site, the question, the
candidate rules, and the other sites the rule would apply to. The coordinator resolves it by
amending the spec's §7, never the site, and the workers that own the listed sites apply the
rule. This is the one piece of process that is not optional, because it is what keeps a new
kind of problem from being solved thirty times differently.

Banned in converted files, checked by the reviewer: `as any`, `@ts-expect-error`,
`biome-ignore`, `TODO`, `sql.raw` outside the search port, a temporary second code path.

## 5. What is deleted, and when

| Instrument | Deleted at |
|---|---|
| The legacy database type | Phase A exit |
| The hazard inventory script | Phase B exit |
| The synchronous transaction helper and the synchronous port types | Phase B exit |
| The freeze lock | Flip merged |
| This document's checklists | When the epic closes; the rules live in the spec's §7 |

Permanent: the scheduler's interleaving tests, the corrupt-blob table test, the two boundary
rules, the two measurement scripts. Nothing else this epic adds survives it. No test that pins
the transition is written: the existing suite is the oracle in both stages, and the scheduler
tests test the scheduler.

## 6. Roles

A coordinator who owns the spec, the decisions and the landings and converts no code. Workers
who own one repository, one category, or one module each, in their own worktree created with
`bun run setup:worktree`, with a brief that names their files, the checklist and the spec's
§6.1 and §7. One reviewer per wave, two for the five large repositories and the flip.
