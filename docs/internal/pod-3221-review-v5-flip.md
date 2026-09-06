# V5 flip review — the post-flip stream, faf345269..db032b2a1

Reviewer: fable 5.1, independent, sole reviewer of the flip. Worktree at the
integration tip db032b2a1 (merged into the review branch), installed and
runnable. This reviews the LANDED COMMITS, not the issues' claims.

Status: IN PROGRESS — committed as it grows, per the coordinator's instruction.

Scope: 41 commits, 46 files, +2978/−199. Earlier deliverables from this issue:
the B1 addendum (`pod-3221-review-b1-addendum-3506.md`) attributed and then
dynamically confirmed the nine POD-3506 hangs; that work is accepted (rule 57)
and is not revisited here.

## Sweeps completed

### Removed test assertions (whole range) — CLEAN

`git diff faf345269..db032b2a1 -- '*.test.ts' '*.test.tsx'` removed-line sweep:
8 hits, all explained, none a deleted assertion:

- `apps/server/src/authz-matrix.test.ts` (5): mechanical async/await additions
  for the D20 block after `ceiling.canSee` went async; every asserted value
  transfers verbatim.
- `apps/server/src/modules/shipping/service.test.ts` (2): rule-48a sync
  `expect(() => …).toThrow` → `await expect(…).rejects.toThrow`, same error
  class asserted.
- `apps/server/src/modules/updates/service.test.ts` (1): import line only
  (adds `afterEach`).

### Escape hatches (added lines, whole range) — CLEAN with 4 notes

No `as any`, `@ts-expect-error`, `biome-ignore`, `TODO`, or `sql.raw` in any
added line. No `DECISION POD-n` markers added. Four `as unknown as` casts, all
in test files (harness/double plumbing, conventional):
multi-user.test.ts:335, shipping/service.test.ts:2485 and :2488,
updates/service.test.ts:1945. Severity: informational.

## Findings

### F1 — HIGH: a fifth defect class, with three live sites. A DECLARED type
bakes in `Promise<T>` via `ReturnType<>` of a newly-async function.

Rules 52/55/56/57 are all about promise VALUES the compiler cannot see. This
one is different: the flip changed what `ReturnType<>` EVALUATES TO inside a
type declaration, so the type system now asserts the promise as the value
type. No value flows wrongly — the declaration itself became wrong — so
TS2801, lint:promise-truthiness and the boundary lint are all blind to it,
and the only symptom is a compile error in whichever downstream consumer
materializes the type concretely. A consumer whose slot is generic, `unknown`,
or never read accepts it forever.

The derived set (mechanism: every tRPC procedure-type declaration in
apps/server; all others already spell `Awaited<ReturnType<…>>`, these three
miss it):

- `apps/server/src/modules/workflows/trpc.ts:125` —
  `output: ReturnType<(typeof WORKFLOW_QUERIES)[N]['run']>`. The flip
  (9f0d5c33e/0517e7c6f) made every `run` async, so all seven workflow query
  outputs are declared `Promise<T>`.
- `apps/server/src/modules/workflows/trpc.ts:93` — same for
  `WORKFLOW_COMMANDS[N]['handler']` (mutations).
- `apps/server/src/modules/automations/trpc.ts:86` — same for
  `AUTOMATION_COMMANDS[N]['handler']`; handlers verified async
  (registry.ts:61-76).

What realistically goes wrong: at runtime tRPC awaits the returned promise,
so the wire is fine TODAY; the damage is (a) apps/web is RED — one real error
at `apps/web/src/features/workflows/use-workflows.ts:163` where
`setDetail(next)` receives a `Promise<…>`-typed value — and (b) every typed
client consumer of these 3 surfaces reasons about `Promise<T>` where the
value is `T`, which is exactly the shape rules 52/55 warn becomes a silent
bug the moment someone "fixes" the type at the consumer end (e.g. by awaiting
a value that is not a promise, or spreading it — rule 55).

The specific change: wrap all three in `Awaited<…>`, matching
fleet/issues/lock/settings/specs/superagent/sessions/derived-family, and add
the class to the spec (candidate rule 58): in a DECLARED type, `ReturnType`
of a function an async pass touched must be spelled `Awaited<ReturnType<…>>`;
the check is derivable (grep declared-output positions for bare
`ReturnType<`).

How verified: per-project typecheck census (below) surfaced the apps/web
error; the type chain read end-to-end; the file is byte-identical to the epic
base, so the redness is the flip's, not the app's.

### F2 — HIGH: the truncated typecheck gate hid more than scripts/ (extends
POD-3508).

Full per-project census, run directly (bypassing turbo) on the tip:

| project | errors |
|---|---|
| apps/server | 0 |
| apps/daemon, apps/cli, all 17 packages/* | 0 |
| apps/web | **1** (F1's symptom — NOT previously filed) |
| apps/mobile | 4 (inherited, on the not-ours list) |
| scripts | **93** (POD-3508, filed) |

So the answer to "what else does the fail-fast gate hide" is: apps/web. The
headline "apps/server typechecks at 0" HOLDS at project scope — I reproduced
it — but the epic-wide claim "the tree typechecks" does not, and the two reds
outside the filed set are both the flip's own class. The gate defect worth
filing alongside POD-3508: `bun run typecheck` (turbo) short-circuits
dependents on first failure AND its summary line reports N of M projects
without failing loudly about the projects it never reached.

### F3 — MEDIUM: the span-effect gate is red at the tip (19 failures), and
POD-3498's fix silently removed the repository span port from the lint's view.

`bun scripts/check-span-effects.ts` exits 1 on db032b2a1 with 19 failures:
1 "NEW observable effect inside a span" (subscriber delivery reached from the
Authority transact port, authority.ts:247/526/598/607), several UNCLASSIFIED
port members, 2 UNNAMED transaction openers (executor.ts:81, :678), and DEAD
span openers — among them
`sync-drizzle.ts#createOrJoinTransaction`, which died in this range:
POD-3498 (17ee0de3a) rewrote the method-form declaration into an arrow
property, and the lint can no longer resolve the SPAN_OPENERS entry, i.e. the
lint now scans fewer spans than it claims, exactly the failure mode its own
message warns about. executor.ts and authority.ts are unchanged in the range,
so those failures predate the range but postdate the flip (the flip created
executor.ts) — they are the flip's, inherited by every landing since.

What realistically goes wrong: rule 19's instrument is dark while the
post-commit landing freeze is in force — the one lint that would catch an
observable effect inside a span cannot go green, so nobody runs it, so a new
violation lands unseen.

The specific change: re-point the SPAN_OPENERS entry at the new declaration
form (or classify it in NOT_A_SPAN_OPENER with a reason), name the two
executor.ts openers, classify the listed ports, and adjudicate the
subscriber-delivery finding against ledger A row 3; then put the gate back in
the exit-gate list for the next landing.

## Pending

- Per-project typecheck census (POD-3508 lead: what else the fail-fast gate
  hides) — running.
- Diff reading of the substantive fixes (POD-3499, 3488, 3487, 3485, 3494,
  3496, 3483, 3426, rule-55 fixture).
- Ledger-construct absence check (podium_sp_, depths WeakMap,
  runSynchronousSpan, legacy-handle-probe.ts, StoreExecutor.legacy).
- Fifth-defect-class hunt.
