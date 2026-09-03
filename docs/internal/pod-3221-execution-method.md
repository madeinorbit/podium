# Execution method for the async store epic (POD-3221)

Companion to `pod-3221-spec.md`, which says what the end state is and which rules apply. This
document says in what order the work lands, how every occurrence is found, how each one is
judged, how a problem no rule covers becomes a decision instead of a local fix, and where the
coordinator stops to review and replan. The revisions that produced it, with their reviews, are
in `pod-3221-history-execution-method.md`.

## 0. Branching

The epic has one **integration branch**: `issue/3221-i-want-to-move-our-podium-sql-queries-to`,
checked out in the coordinator's worktree and started from `dev/mw`. Every sub-issue's branch
is created from it (the sub-issues carry it as their parent branch) and lands back into it,
behind its merge lock (`podium merge-lock` from the integration worktree). `main` and `dev/mw`
are not touched during the epic. At the close checkpoint, after the complete result has been
tested on the integration branch, the coordinator rebases it onto the current `dev/mw` and
merges it back into `dev/mw`; `main` is left alone. "Landed" everywhere below means landed on
the integration branch.

## 1. Four principles

1. **Completeness comes from the compiler and a lint, never from grep or memory.** A stage is
   complete when a type the old code needed no longer exists, the lint family is green, and the
   count of decision markers is zero.
2. **Every occurrence has a classification and a decision, or it blocks.** Each site is put
   through the checklist for its phase (§3); every answer maps to a rule in the spec's §6 or to
   "no rule covers this".
3. **Decisions are made once, as rules; occurrences apply rules.** A new kind of occurrence is a
   decision issue resolved by the coordinator with the spec amended, then applied to every site
   the rule touches.
4. **No intermediate state may land that the next step cannot see, and no instrument outlives
   its purpose.** The flip is one short-lived branch under a freeze; every temporary instrument
   is paired with a deletion issue in the tracker; the coordinator checkpoints between stages
   are issues with edges, not habits.

## 2. What threatens completion, and what answers it

| Threat | Answer | Cost |
|---|---|---|
| A repository is left half-converted, or raw SQL survives on the drizzle type | One lint rule family over the store directories: no runtime-sqlite import, no `.prepare(`, no whole raw statement on drizzle's raw-execution methods, no `PRAGMA`, `sqlite_master` or `ATTACH` inside `sql` bodies, no drizzle transaction outside the store's port, drizzle imported only from the store, the operations store, the migrations and the sync adapter. Its only allowlist is the `// DECISION POD-<n>` marker. Deleting the executor's legacy handle field at Stage A exit is a free second check. | One permanent rule family, proven to fire on a fixture. |
| A conversion changes behaviour and the tests are rewritten to match | Conversion commits may not modify an existing test assertion; setup edits (direct repository constructions, probe seams) are allowed and listed in the commit message. At the flip the rule is mechanical: changed test lines differ only by `await`, `async` or the helper rename. | A reviewer rule. |
| A call site drops a promise at the flip | The flip is a codemod that inserts `await` before every call whose callee resolves to a repository or store method, regardless of position; the compiler then enumerates every site that must become async. Hundreds of store calls sit in statement position with the result discarded and no floating-promise lint exists. Every branch that rebases across the flip runs the codemod before landing. | One script, deleted after the flip. |
| Interfaces are guessed and rework repeats | The executor prototype and the sync-append proof before the large repositories convert. | A few days, once. |
| An async hazard the compiler cannot see survives the flip | A ledger table in the flip issue, one row per site by symbol: category, model chosen, commit that applied it. The compiler under the codemod finds the detectable categories at the flip. | None in the repo. |
| The scheduler is wrong in a way the store tests cannot see | About ten deterministic interleaving tests of the scheduler, plus the mutable-state model tests over an injected async persistence function that parks on a barrier. | Permanent, fast, small. |
| A JSON column loses its quarantine | The 23-column corrupt-blob table test, written first by the coordinator against today's implementation, its column list derived from the schema so a 24th column fails by name. | One file, permanent. |
| Hot paths regress in a way duration cannot show | One measurement script on the attribution seam, `--baseline <file>`, exit non-zero on increase; baselines are issue artifacts, never committed. Frames per burst is a scheduler test. On Turso, query count per request is round trips per request. | One script. |
| The remote driver changes semantics the tests cannot see | The remote spike (gates that can fail) and the sync-append proof on a Turso database, both before the flip. | Two bounded issues. |

Nothing else is added. Permanent additions: the lint rule family, the scheduler and model tests,
the corrupt-blob test, the measurement script.

## 3. Two checklists

Every site is answered against the checklist for its phase. Each answer is a rule number from
the spec's §6, or "no rule": see §4.

**Stage A, a query site or span.**
1. Which of the spec's §2.7 constructs does it use, and what replaces each: `PRAGMA`,
   `sqlite_master` or introspection to the driver or migrations; every column named on an
   `OR REPLACE` conversion.
2. Which columns are JSON, and does the corrupt-blob oracle say quarantine or throw for each?
3. Which mapper lines are decisions and stay (rule 6), and which existed only because the driver
   returned `unknown` and go?
4. Do brands flow from `$type` (rule 3), or is a cast left, and why?
5. Does a span cross repositories, nest, or do read-decide-write, and does the conversion keep
   its boundaries and its immediate mode (rule 7)?
6. Does anything inside a span call something that is not the database? Note it in the ledger
   for B-prep; do not fix it here.
7. Does any bound parameter arrive as `undefined`, and what did the raw statement do with it?
8. Does a dynamic `IN` list bound the number of distinct SQL texts (the statement cache)?
9. Which test setups change (direct constructions, probes)? List them in the commit message.
10. Is the method on the brief's uncovered list? Then its golden test comes first.

**Stage B, a store consumer or state site.**
1. Is every call awaited, including statement-position and boolean-position calls? (The
   codemod's output for this file is empty.)
2. From what context is the store reached: handler, constructor, getter, callback, predicate,
   timer, boot, inside a write span?
3. Which spec §2.5 category, and which model: `create()`, batched read, single-flight, read
   scope, rights read under the lease, ambient routing?
4. Is a process-owned object mutated before commit or restored on failure, and which model
   applies?
5. Does the caller read a derived row immediately after a commit?
6. Does any await now sit between two reads a frame cache covered?
7. Which nested write becomes which post-commit mechanism, and does the outer promise wait for
   it?

## 4. When no rule covers a site

The worker converts the site in the most literal form and marks the line `// DECISION POD-<n>`,
the one token the lint allowlists. It files the decision with the exact command from its brief:

    podium issue create --parent-id 3221 --outside-scope --title "Rule: <question>" \
      --description "<one plain sentence>" \
      --brief "<site, question, candidate rules, other sites the rule would apply to>"

The coordinator resolves it by amending the spec's §6, never the site, and sends the answer to
each affected worker's session with `--urgency interrupt`, because an issue-mailbox message does
not wake a working agent. The worker does not wait; it lands the rest of its package. Stage A's
exit gate requires zero markers.

Banned in converted files: `as any`, `@ts-expect-error`, `biome-ignore`, `TODO`, `sql.raw` of
user input, a temporary second code path.

## 5. The sequence

Six phases with a coordinator checkpoint between each pair. Every exit gate is a command that
exits zero, or is named as a human gate. Checkpoints (§6) are issues with edges: nothing in the
next phase is ready until the checkpoint closes.

### Phase 0 — decide the interfaces and make every shared edit once

1. The two measurements on today's probe seam (0.1); the coverage census (0.2); the corrupt-blob
   oracle against today's implementation (0.3).
2. Retire the boot upgrades so the store facade holds no raw SQL (0.4); store-owned invalidation
   for the repos cache (0.5).
3. The executor prototype: the scheduler port with its bun:sqlite implementation, the token,
   ambient routing, the three post-commit mechanisms with synchronous implementations, the
   executor object, the interleaving harness and the model tests; a driver interface with the
   remote driver in mind (0.6).
4. The sync-adapter table injection (0.7); the lint family with fixtures (0.10); the
   writer-guard replacement (0.11);
   the shared edits, once, by the coordinator: the 34 constructor lines take the executor, the
   column modes and JSON decisions recorded in the schema, no migration (0.12); attribution at
   the execution seam with the probes moved and the baseline re-captured (0.13).
5. In parallel, gated by the human's Turso access (H): the Turso remote spike (0.9) and the
   sync-append proof on Turso (0.8).

Exit: the interfaces built by 0.6 and the numbers from 0.8 and 0.9 recorded in the spec by the
coordinator at R1 (human gate); everything else landed; `bun run lint:boundaries` shows ZERO NEW
violations against the base — see below. No
worker issue writes a spec; workers report in their handoff and the coordinator records at the
checkpoint.

NEVER MERGE A GENERATED MANIFEST; REGENERATE IT (coordinator's own defect, 2026-09-03, caught by
POD-3260). `apps/server/test-shards.json` and `apps/server/turbo.json` are produced together by
`bun scripts/server-test-shards.ts --write` from one import-closure scan. `test-shards.json` is an
EXPLICIT FILE LIST, not a glob.

Resolving a rebase, the coordinator merged it textually and landed the result. The merge dropped
entries neither side had deleted: `statement-probe.test.ts` fell out of the store shard entirely,
plus eleven dependency entries across two shards.

THE FAILURE MODE IS WHY THIS IS IN THE METHOD RATHER THAN A COMMIT MESSAGE: a shard fails when it is
EMPTY and never when it is SHORT. The file simply stops running, in no lane, with every gate still
green. The dropped file was POD-3281's statement probe — the thing the hot-path measurements now sit
on — so the gate protecting the measurement would have been silently unarmed while continuing to
report success.

RULE: after any rebase or merge that touches either file, run the generator and commit its output.
Never hand-resolve a conflict in them. The same reasoning applies to any generated artefact whose
consumer iterates an explicit list.

A NAME-MATCHING SCAN CANNOT CARRY A COMPLETENESS GATE (POD-3257, 2026-09-03). This method's first
principle is that completeness comes from the compiler and a lint, never from grep — and here is the
concrete proof, found by a worker on its own work rather than by a reviewer.

POD-3257 hoisted a repeated read out of a callback, exactly as rule 18 required. The site
(`native-login.ts:69`) then DROPPED OFF its own scanner's results — not because the store read moved
out of the callback, but because the callback now calls a local const instead of
`this.deps.authorize(...)`, and the scanner matches by NAME. The read is still there, behind a
closure the scan cannot follow. Only the `// DECISION POD-<n>` marker still carries that site.

TWO CONSEQUENCES, both binding:
- The zero-marker exit gate is NOT a completeness proof on its own. A marker can outlive the scan
  that found its site, and a legitimate refactor can hide a site from the scan without touching the
  hazard. When auditing Stage A's exit, the markers are the record of what was FOUND, not evidence
  that nothing else exists.
- Any lint written for a rule of this shape must resolve callees through the TYPE CHECKER. Matching
  on names both misses the closure case above and floods on `Map.get`/`Map.has`. POD-3257 explicitly
  did not propose its scanner as a lint for this reason, which was the right call.

GATE CORRECTED 2026-09-03 (POD-3252, POD-3314). This exit read "`bun run lint:boundaries` green"
and that gate is UNACHIEVABLE on this base and always was: `lint:boundaries` exits 1 on `dev/mw`
itself at f910e2671 with 26 architecture-manifest and 53 dependency-boundary violations, none of
them this epic's, byte-identical across `dev/mw`, the integration tip and a worker branch. Filed
outside the epic as POD-3314.

An absolute-green gate that cannot go green is worse than no gate: the first worker to meet it
either stops, or learns to read past a red, and after that a REAL violation is invisible. So every
gate in this epic that names a whole-tree lint or suite is a DELTA gate — the failure set is
byte-identical to a control run of the same command at the base commit, compared as a set of names
and not as a count. Where the epic's own new rules are concerned the gate stays absolute: the
boundary family's own fixtures must be green, and `STAGE_A_UNCONVERTED` must be empty at Stage A's
exit. Those are achievable because the epic owns them.

The same correction applies to `bun run test`, which cannot pass on this base either — its
workspace typecheck fails in `@podium/mobile` (POD-3303), a package that does not depend on
`@podium/server`, so no change inside this epic can turn it green.

**Checkpoint R1** reviews the subtree, the measurements and the spike numbers, decomposes the
Phase A placeholder into wave issues, and confirms the wave plan with the human.

### Phase A — drizzle conversion, one agent per package, in waves

Stage A is embarrassingly parallel once the shared edits are done. Small repositories in groups
of three to five by adjacency, one wave; then the five large repositories by family (shared
selects and mappers first, one family per worker or commit, cross-family spans with the last
family). Five to eight workers at a time as the box allows, each in its own worktree, each
producing one commit: its repository files, its golden tests (written before, against the
synchronous code, for the uncovered methods in its brief), and the setup edits of tests that
construct the repository directly. No `schema.ts`, no `store.ts`, no migration. Every site is
answered against the Stage A checklist; sync forms only; existing assertions untouched. One
reviewer per wave, two for the five large repositories.

Exit: lint family green with zero `DECISION` markers; the executor's legacy field deleted and
typecheck green (scoped to `@podium/server`, concurrency 1); corrupt-blob test green; the
measurement script green against the Phase 0 baseline.

**Checkpoint R2** confirms the gate as commands, checks every decision became a rule applied to
all its sites, re-inventories B-prep against the converted code, and confirms the B-prep plan
with the human.

### Phase B-prep — remove the hidden dependencies while everything is still synchronous

One agent per category, landable in small commits on the integration branch: hidden reads (B0.1), array-callback
batched reads (B0.2), timer guards (B0.3), mutable process-state models with their tests over
an injected async fake (B0.4), span side-effect classification into the three mechanisms (B0.5),
read-scope adoption with the frame caches, the visibility prefetch and admission inside the read
scope (B0.6), the test store helper and the await preparation for tests only, the twelve
timing-sensitive suites excluded and listed by name in the flip issue (B0.7).

Exit: every ledger row in the flip issue has a commit or a decision issue; the twelve suites are
listed.

**Checkpoint R3** confirms the ledger, the suites and the codemod's dry run, and agrees the
freeze window, the lock holder and the affected sessions with the human.

### Phase B — the minimal flip, then the post-flip list

The flip (B1): one integration branch under the freeze lock `freeze:pod-3221-flip` over
`apps/server/src/**` and `packages/sync/src/**`, renewed by the coordinator and stated in every
concurrent session's brief. Port types, repository signatures, `SessionStore.open()`, the
scheduler wired, ambient routing live; the codemod awaits every store call; the red is followed
to green, in worktrees off the flip branch per module if the box allows; the twelve suites
convert in the branch; a "no rule" is resolved by the coordinator inside the freeze; two
reviewers; the mechanical test-diff rule. Every branch that rebases across the landed flip runs
the codemod before it lands.

The post-flip list on the integration branch, no freeze: lifecycle and awaited shutdown with the migration bracket
and the parked-transaction test (B2.1); the watchdog (B2.2); the ADR amendments (B2.3); deletion
of the synchronous helper, the synchronous port types, the executor's legacy field and the
codemod (B2.4).

Exit: existing suite green; scheduler and model tests green; measurement script green; the
synchronous helper deleted and typecheck green; ADRs amended (human gate at R4).

**Checkpoint R4** confirms the gate as commands, compares pre- and post-flip measurements, and
replans Stage E with the spike's and the proof's real numbers, confirmed with the human.

### Phase E — the Turso backend

The durability port with the bun:sqlite implementation unchanged and the Turso implementation
empty (E.3); Turso backend enablement: the libsql driver implementation of the executor, open and
migrate over the remote connection, FTS5 per boot, the operator paths as clients, configuration,
per-backend acceptance (E.5); the tenant import by platform file import with the feed identity
and migration ledger verified (E.4).

Exit: the spec's §5.2 as commands and evidence.

**Checkpoint R5** walks the definition of done item by item with evidence, verifies every
temporary instrument is deleted, tests the complete result on the integration branch, then with
the human's confirmation rebases the integration branch onto the current `dev/mw` and merges it
back into `dev/mw`. `main` is left alone.

## 6. Coordinator checkpoints

Five issues, one between each pair of phases and one at the end. Each has the same standing
instruction: review the whole subtree and every handoff and artifact of the phase just finished;
review the state of the work on the integration branch, the measurements against their baselines, the gates, the
decision markers and decision issues, and anything deferred; replan by adding, removing,
re-sequencing or rewriting sub-issues and briefs and writing new specs where the design changed;
check in with the human before any change to scope, the definition of done, the sequence, the
freeze timing or a decision on record; close only when the next phase's ready issues have briefs
that match the current spec and method and the human has confirmed. Each checkpoint's brief adds
the questions specific to its position.

## 6a. Review points

The human does not review every sub-issue. Six independent review issues sit at the points
where a mistake would be expensive to find later, each with the same standing instruction (a
fresh reviewer session with no prior context, a different model from the implementers where
possible, reviewing the landed commits rather than the issues' claims, running the gate
commands, reading the removed lines of every test file, hunting escape hatches and unfiled
decision markers, delivering a review artifact and an issue mail with a verdict) plus what is
specific to that point. A review gates the checkpoint that follows it; the coordinator resolves
every critical and high finding before that checkpoint closes.

| Review | Reviews | Gates |
|---|---|---|
| V1 Executor prototype review | 0.6, with every harness test proven able to fail | 0.8, 0.12, 0.13, B0.1, B0.4, B0.5, B0.6, B0.7 |
| V2 Phase 0 landing review | every other Phase 0 landing, spike and proof numbers reproduced | R1 |
| per-wave reviews | each conversion wave, created with the wave at R1; two reviewers for the five large repositories | the next wave touching the same families |
| V3 Stage A conversion review | the whole converted store, the five large repositories in full | R2 |
| V4 B-prep review | all of B-prep, inventory re-run | R3 |
| V5 Flip review (two reviewers) | the flip branch before it merges | B2.1 to B2.4, R4 |
| V6 Post-flip and Turso review | B2.1 to B2.4, E.3, E.4, E.5 | R5 |

## 7. What is deleted, and when

When a temporary instrument lands, the same issue creates its deletion issue, blocked by the
phase-exit checkpoint, with the file paths in the brief. The tracker holds the deletion.

| Instrument | Deleted at |
|---|---|
| The executor's `legacy` field | Stage A exit (B2.4 deletes it if still present) |
| The codemod | B2.4 |
| The synchronous transaction helper and the synchronous port types | B2.4 |
| The freeze lock | flip merged |
| The ledger table | lives in the flip issue |

Permanent: the lint rule family, the scheduler and model tests, the corrupt-blob test, the
measurement script. No test that pins the transition is written.

## 8. Roles

A coordinator who owns the spec, the decisions, the shared edits of Phase 0, the freeze, the
landings and the checkpoints, and converts no repository (see `pod-3221-coordinator-brief.md`).
Workers who own one package, one category, or one module each, in their own worktree created
with `bun run setup:worktree`, with a brief that names their files, the checklist, their
uncovered-method list, the decision command, the freeze lock name while it is held, and the
spec's §5 and §6. One reviewer per wave, two for the five large repositories and the flip. The
human grants Turso access, confirms each checkpoint's plan, and takes the decisions the
coordinator escalates.

## 9. The issue tree

Prefix gives the order; edges in the tracker give the real dependencies
(`podium issue tree 3221 --max-nodes 200`).

| Prefix | Issue | Depends on |
|---|---|---|
| H | POD-3289 Turso platform access (human) | none |
| 0.0 | POD-3242 Query layer confirmation | closed 2026-09-03: drizzle with two drivers; driver facts in spec §3.7; typecheck cost measured by the first wave |
| 0.1 | POD-3243 Hot-path measurement baseline | none |
| 0.2 | POD-3244 Store coverage census | none |
| 0.3 | POD-3245 Corrupt-blob oracle test | none |
| 0.4 | POD-3246 Boot upgrades retirement | none |
| 0.5 | POD-3247 Repos cache invalidation seam | none |
| 0.6 | POD-3248 Executor prototype and harness | none |
| 0.7 | POD-3249 Sync adapter table injection | 0.0 |
| 0.8 | POD-3250 Turso sync-append proof | 0.6, H |
| 0.9 | POD-3251 Turso remote spike | H |
| 0.10 | POD-3252 Store boundary lint family | 0.0, 0.4 |
| 0.11 | POD-3253 Issues writer-guard replacement | 0.0 |
| 0.12 | POD-3254 Shared schema and constructor edits | 0.3, 0.6 |
| V1 | POD-3291 Executor prototype review | 0.6 |
| 0.13 | POD-3281 Attribution at execution seam | 0.6, V1 |
| V2 | POD-3292 Phase 0 landing review | every other Phase 0 issue, V1 |
| R1 | POD-3284 Phase 0 checkpoint and replan | every Phase 0 issue, V2 |
| A | POD-3255 Repository conversion waves (placeholder, filled at R1 with one review sub-issue per wave) | R1 and its Phase 0 prerequisites |
| V3 | POD-3293 Stage A conversion review | A |
| R2 | POD-3285 Phase A checkpoint and replan | A, V3 |
| B0.1 | POD-3256 Hidden store reads | 0.6 |
| B0.2 | POD-3257 Array-callback batched reads | none |
| B0.3 | POD-3258 Timer single-flight guards | none |
| B0.4 | POD-3259 Mutable process-state models | 0.6 |
| B0.5 | POD-3260 Span side-effect classification | 0.6 |
| B0.6 | POD-3261 Read-scope adoption and prefetch | 0.6, 0.1, 0.13 |
| B0.7 | POD-3262 Test store helper and awaits | 0.6, V1 |
| V4 | POD-3294 B-prep review | B0.1 to B0.7 |
| R3 | POD-3286 Pre-flip checkpoint and replan | R2, B0.1 to B0.7, 0.8, V4 |
| B1 | POD-3263 Async port flip | R3 |
| V5 | POD-3295 Flip review (two reviewers) | B1 |
| B2.1 | POD-3264 Scheduler lifecycle and shutdown | B1, V5 |
| B2.2 | POD-3265 Transaction watchdog | B1, V5 |
| B2.3 | POD-3266 ADR amendments | B1, V5 |
| B2.4 | POD-3267 Transitional instrument deletion | B1, B2.1, V5 |
| R4 | POD-3287 Post-flip checkpoint and replan | B1, B2.1 to B2.4, V5 |
| E.3 | POD-3270 Durability port for Turso | R4, B1, B2.1 |
| E.5 | POD-3272 Turso backend enablement | R4, 0.9, E.3, B1, H |
| E.4 | POD-3271 Turso database import | E.5, H |
| V6 | POD-3296 Post-flip and Turso review | B2.1 to B2.4, E.3, E.4, E.5 |
| R5 | POD-3288 Epic close checkpoint | E.4, E.5, B2.4, V6 |
| E.1 | POD-3268 Engine decision record | closed: decision taken 2026-09-03 |
| E.2 | POD-3269 Schema form and journal | archived: not needed under one dialect |

Ready at the start: H, 0.1 to 0.7, 0.11, B0.2, B0.3 (0.0 is closed). The Turso items wait on
H. The placeholder A is filled at R1. Also in the table: 0.8 and 0.12 depend on V1.
