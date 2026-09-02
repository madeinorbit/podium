# Execution method for the drizzle async store epic (POD-3221)

Companion to `pod-3221-drizzle-async-store-plan.md` (the specification, revision 11). That
document says what the end state is and which rules apply. This one says in what order the work
lands, how every occurrence is found, how each one is judged, and how a problem that no rule
covers becomes an architectural decision instead of a local fix.

## 1. Four principles

1. **Completeness comes from the compiler and a ratchet, never from grep or memory.** A stage is
   complete when a type the old code needed no longer exists and the audit's count for that
   family is zero. Grep proves positives only; the audit's detectors are anchored on syntax
   forms and each count says what it counts.
2. **Every occurrence has a classification and a decision, or it blocks.** No site is converted
   by feel. Each is put through the question set for its kind (§4), and every answer maps to a
   rule in the specification's §7 or to "no rule covers this".
3. **Decisions are made once, as rules; occurrences apply rules.** A new kind of occurrence is a
   decision record, filed and resolved by the coordinator with the plan amended, then applied to
   every site the audit lists for it. Nobody resolves a new kind locally.
4. **No intermediate state may land that the next step cannot see.** The audit baseline may only
   go down and must be updated in the same commit as the improvement; an issue cannot close
   while an undeclared site remains; the two port flips (Stage A's type deletion, Stage B's
   async ports) are single short-lived changes with a freeze around them.

## 2. The instruments (built before anything is converted)

### 2.1 The store-rewrite audit

`scripts/store-rewrite-audit.ts` with `scripts/store-rewrite-audit-baseline.json`, in the exact
shape of `scripts/rearch-audit.ts`: detectors per family, a committed baseline, `count >
baseline` fails, `count < baseline` fails until locked in with `--update-baseline`, `--sites`
prints every file:line, `--phase POD-xxx` refuses to pass while an undeclared site mapped to that
issue remains, and an exact site may be declared with an in-repo reason and an expiry. Detectors
use the TypeScript compiler API (already a dependency of `scripts/`) for structural forms, and
text matching only inside string and template literals for SQL constructs.

Families, each with its unit stated:

| Family | Unit | Detector | Floor |
|---|---|---|---|
| A1 raw statement sites | `.prepare(` / `.exec(` calls on a `SqlDatabase` in repositories | AST | 0 at end of Stage A |
| A2 dynamic SQL | `prepare(`/`exec(` whose argument is not a literal | AST | 0 (each is a decision; today: the boot machine-identity upgrade, retired by step 9) |
| A3 SQLite-only constructs | the §1.7 list inside SQL literals and `sql\`\`` bodies in repositories, outside the `SearchIndex` port | text in literals | 0 at end of Stage A |
| A4 unnamed-column upserts | `INSERT OR REPLACE` / `onConflictDoUpdate` naming fewer columns than the table | AST + schema | 0 |
| A5 legacy type reach | imports of `LegacySqlDatabase` | AST | 0 at end of Stage A (then the type is deleted) |
| B1 store consumers per module | `store.<aggregate>.<method>(` and narrowed-deps lambdas that reach the store, grouped by module | AST | tracked, not floored; the flip converts them |
| B2 frame caches | `queueMicrotask` in `store/**` and services | AST | 0 before the flip |
| B3 hidden reads | store calls inside constructors and getters | AST | 0 before the flip |
| B4 store calls inside array callbacks | `map`/`filter`/`sort`/`forEach` callbacks that call the store | AST | 0 before the flip |
| B5 unguarded timers | `setInterval`/`setTimeout` callbacks that reach the store without a single-flight guard | AST | 0 before the flip |
| B6 mutable process state | `Object.assign(row, …)` and capture/restore pairs in services; every registry from step 14a | AST + list | each has a chosen model before the flip |
| B7 I/O inside spans | calls to mail, sockets, fetch, process from inside `transact`/`ledger.commit`/`funnel.run` bodies | AST | 0 before the flip |
| B8 sync transaction helper reach | imports of the depth-counting `transaction()` | AST | 0 at end of Stage B (then deleted) |
| T1 store constructions in tests | `new SessionStore(` | AST | 0 after `openTestStore()` |
| X1 escape hatches in converted files | `as any`, `@ts-expect-error`, `biome-ignore`, `TODO`, `sql.raw` outside the port | text | 0 always |

The baseline diff is the burn-down. The coordinator posts `--json` counts into the issue state
after every landing.

### 2.2 Type deletion as the final proof

Stage A introduces two types: `LegacySqlDatabase` (today's `SqlDatabase`) for unconverted
repositories and `Database` (the drizzle instance) for converted ones. The composition root
hands each repository the one it takes. Converting a repository changes its constructor's
parameter type, which the compiler checks. When the last repository converts, `LegacySqlDatabase`
is deleted from the store's imports; if anything still needs it, typecheck says so. Stage B
does the same with the sync `transaction()` helper and the synchronous port types: the flip
changes the types first and the compiler enumerates every site that has to change.

### 2.3 The oracles

- **Stage A:** the existing store and service tests, untouched in conversion commits. A
  reviewer rule, checked mechanically on the diff: a commit that touches `store/**` may add test
  files but may not modify existing assertions.
- **Stage B:** the captured conformance traces (spec §6.1): recorded from the synchronous
  implementation before the flip, replayed against the async one. The synchronous
  implementation stays behind a test adapter until parity holds.
- **Both:** the deterministic interleaving harness (barriers the bodies await) for the queue
  properties, admission, and the same-entity races of step 14a.

### 2.4 The measurements

Query count per request on feed bootstrap and issue frame reads; frames per burst on the boot
reconcile and a bind-storm fixture; bun statement-cache count and RSS after a feed bootstrap;
`apps/server` typecheck time. Each is captured before the first conversion and re-captured at
each gate.

## 3. The sequence

Each phase has an entry gate and an exit gate. Nothing in a later phase starts before the
earlier phase's exit gate is green, except where stated.

### Phase 0 — instruments and decisions

1. Build the audit (§2.1) and commit its baseline. From here, CI runs it.
2. Capture the measurements (§2.4).
3. The two prototypes of spec step 3b: the executor proof (queue, token, savepoints, post-commit
   mechanisms, async close, ambient routing, a service-shaped closure, the cross-service span)
   and the dual-backend vertical slice (locks, one aggregate with joins and JSON, sync append with
   feed-head allocation, boot, shutdown, on SQLite and Postgres). Each ends in decisions written
   into the spec: the dialect-query strategy, the schema-twin technique, the three-lane port
   shape, the after-commit contract, ambient versus explicit.
4. Stage A prerequisites 5a to 5d: attribution at the execution seam, repos cache invalidation,
   the transaction lint, the writer-guard replacement.
5. The interleaving harness and the trace recorder exist, even though the recorder is only used
   at the end of Stage A.

Exit gate: baseline committed; measurements recorded; the step 3b decisions are in the spec as
rules; 5a to 5d landed; the harness runs.

### Phase A — builder conversion, per family slice

Order: the small aggregates first (locks, accounts, read-watermarks, messaging-topics,
approvals, settings, secrets, settings-audit, users, grants, telegram-bindings, layout, read
positions, notification facts, quota history, maintenance, machines, automations, events,
superagent, observation checkpoints, operations store, conversations and its three
sub-repositories, the sync adapter), then the five large ones in family slices (shared selects
and mappers first, then one family per commit, cross-family spans with the last family):
messages, workflows, sessions, issues, shipping.

Per slice, in this order and as separate commits:

1. A schema-only commit where the slice needs one: `mode: 'boolean'`, the per-column JSON-mode
   decision, an `ord` column with its backfill. Its own migration. Lands before the query commit.
2. The conversion commit: the repository's queries on the builder, sync forms, every occurrence
   put through Q-A and Q-T (§4), the constructor type changed, the baseline updated in the same
   commit. Existing tests untouched. One corrupt-blob characterisation test added for the
   aggregate.
3. Review by a second agent with the question sets and the spec's §6.1 checklist; for the five
   large repositories, two reviewers with the depth split.
4. Landing on `main` behind the merge lock; the audit is the CI gate; the slice issue closes
   only when `--phase` passes for it.

Exit gate: A1, A3, A4, A5 at zero; `LegacySqlDatabase` deleted; every aggregate has its
corrupt-blob test; measurements re-captured with no query-count increase; X1 at zero.

### Phase B-prep — remove the async hazards while everything is still synchronous

This is most of Stage B's real work, and none of it needs the async ports. It lands per category
under the audit:

1. B3 hidden reads: constructors to `static async create()` shapes that are still sync today
   (the shape changes now, the `async` keyword arrives at the flip); getters to methods.
2. B4 array-callback store calls: batched reads before the loop.
3. B5 timers: single-flight guards.
4. B6 process state: the step 14a audit, a model chosen per registry, the barrier tests written
   against the synchronous implementation.
5. B7 I/O in spans: each nested write classified per the three post-commit mechanisms; the
   `store.read(fn)` and `store.transact(fn)` API shapes introduced now with synchronous
   implementations, so the fan-out passes and the frame caches adopt the read-scope shape (B2)
   before its semantics change.
6. T1: the `openTestStore()` helper and the three shared helper modules; the await-preparation
   pass for tests, scoped as spec step 11a.
7. Record the conformance traces from the synchronous implementation.

Exit gate: B2 to B7 at zero or declared with a reason and an expiry that is the flip issue;
traces recorded; T1 at zero.

### Phase B — the flip, then the modules

1. **The flip**, one branch, days not weeks, under a freeze: a lock name over `apps/server/src/
   store`, `packages/sync` and `relay.ts` that every other session on the repo must respect; no
   other store work lands until it is merged. It changes the port types (`TransactPort<Uow>`,
   the async Authority methods, the `Awaitable` opener, `SessionStore.open`), lands the
   scheduler, the token, ambient routing, the post-commit mechanisms, admission inside the read
   unit of work, the `forBatch` prefetch, and follows the red until typecheck is green. Its
   review runs the queue harness, the admission barrier test, and the traces.
2. **Modules top-down**, one per commit: relay, then each module. Each is compared against its
   trace; each converts its B1 sites; each is reviewed with Q-C.
3. Delete the sync `transaction()` helper and the synchronous port types (B8 to zero).

Exit gate: traces equal; harness green including frames per burst; shutdown and parked-body
tests; query counts unchanged; B1 converted; B8 at zero; the ADR amendments landed.

### Later, outside this issue

Stage B′ (backend enablement) and the Postgres epic (Stage C), against the requirements the
spec records.

## 4. The question sets

Every occurrence is judged against the set for its kind. Each answer is either a rule number
from the spec's §7 (or a step number), or "no rule": see §5.

**Q-A, a query site (Stage A).**
1. Statement kind and family; is the SQL a literal (A2 if not)?
2. Which §1.7 constructs does it use, and what replaces each (rowid: which class in step 6; OR
   REPLACE: every column named; PRAGMA, `sqlite_master`, `lastInsertRowid`: which port)?
3. Which columns are JSON, and is each quarantined or throwing (rule 4)?
4. Which mapper lines are decisions and stay (rule 6), and which existed only because the driver
   returned `unknown` and go?
5. Do brands flow from `$type` (rule 3), or is there a re-entry cast left, and why?
6. Is the parameter list hand-built (chunking), and does the builder replace it?
7. Does the oracle cover this statement? If thin, which golden test is added first?
8. Is it on a hot path (attribution says so), and does it need `prepare()`?
9. Does it read another aggregate's table (accepted cross-aggregate read, or routed)?

**Q-T, a transaction span (Stage A and B).**
1. What does the span cover, and which repositories does it cross?
2. Is it nested or re-entrant today (savepoint), and from where?
3. Is there a read-decide-write inside it, and is the decision's read inside the span?
4. Is there any call inside the body that is not a database call (B7), and which of the three
   post-commit mechanisms does it become, or does it stay in the unit of work as a durable
   nested write?
5. Does anything publish or notify inside the body today by convention (`announce: false`)?
6. Does it mutate a process-owned object before commit, and restore it on failure (B6)?
7. What is the transaction mode (immediate), and does the conversion preserve it?
8. Which harness case proves it after the flip?

**Q-C, a store consumer (Stage B).**
1. From what context is the store called: request handler, constructor, getter, callback,
   predicate, timer, boot?
2. Which §1.5 category, and which model applies (create(), batched read, single-flight, read
   scope, precomputed view under the lease)?
3. Does the caller read a derived row immediately after a commit (the re-entrant timing
   contract)?
4. Is the caller reached from inside a write span (ambient routing applies)?
5. Which trace scenario covers it?

**Q-S, a process-state site (Phase B-prep).**
1. What object is mutated before commit, and who else reads it?
2. Which model from step 14a: write unit of work with reader leases, immutable draft installed
   after commit, or its own mutex?
3. What is the rollback path today, and what replaces restore-by-assignment?
4. Which barrier test (two updates, rollback racing a commit, in-memory read during a parked
   write) proves it?

**Q-M, a migration (Stage A).**
1. Additive only? Never a primary-key change on a parent table (rule 10).
2. Is there a backfill, and is it hand-written in the migration?
3. Does the write path fill the new column under the write lane?
4. Is the table one of the archived or exempt ones (`upstream_outbox`, the FTS tables)?
5. Does the pre-migrated test image regenerate, and does the foreign-keys bracket cover it?

**Q-X, a test (both stages).**
1. Does the commit change an existing assertion? (Conversion commits: no.)
2. Does an inserted `await` sit between two reads a frame cache covers?
3. Is the store closed, or are timers `unref`'d?

## 5. The bubble-up protocol

When any answer in a question set is "no rule covers this":

1. The worker stops on that occurrence. It does not choose locally.
2. The worker declares the site in the audit with the reason `decision pending: D-n` and an
   expiry that is the decision issue, so the ratchet stays green without hiding the site.
3. The worker files a decision sub-issue under the epic with: the occurrence, the question that
   had no answer, the candidate rules, and the audit's `--sites` list of every other occurrence
   the rule would apply to.
4. The coordinator resolves it by amending the spec's §7 with a rule, not by editing the site,
   and records it in the decision digest appended to the spec. If the rule changes an earlier
   decision, the affected sites are listed and re-opened.
5. The rule is applied to every site on the list, in the slices that own them.

Banned, and enforced by X1 at floor zero in converted files: `as any`, `@ts-expect-error`,
`biome-ignore`, `TODO`, `sql.raw` outside the port, a "temporary" second code path, a declared
site without an expiry.

## 6. Roles and cadence

- **Coordinator** (this issue's session or its successor): owns the spec, the rules, the audit,
  the decision queue and the freeze; does not convert code; posts the burn-down after every
  landing; runs the phase gates.
- **Workers:** one per slice sub-issue, each in its own worktree created with
  `bun run setup:worktree`; the brief names the slice's files, the question sets, the spec's
  §6.1 and §7, and the lock names of the files it may not touch. A worker that is idle for a
  slice's expected time is checked by sampling its worktree, not its stage.
- **Reviewers:** per slice, against the acceptance text; they read the removed lines of any
  test file; the five large repositories and the flip get two reviewers with the depth split.
- **Landing:** per slice, on `main`, behind the merge lock; the audit is the CI gate; `--phase`
  is the close gate.
- **Cadence:** small slices land daily; the big-five families over a couple of weeks; the flip
  is scheduled for a window when no other store work is in flight and announced on the repo.

## 7. What complete means

| Phase | Complete when |
|---|---|
| 0 | Baseline committed; measurements recorded; step 3b decisions in the spec; 5a–5d landed; harness runs |
| A | A1, A3, A4, A5 zero; `LegacySqlDatabase` deleted; corrupt-blob tests per aggregate; query counts unchanged; X1 zero |
| B-prep | B2–B7 zero or declared with expiry; T1 zero; traces recorded |
| B | Traces equal; harness and admission tests green; frames per burst equal one; B1 converted; B8 zero; ADR 2, 6, 9 amended |

Nothing here is finished by a stage label. Each row is a command that exits zero.
