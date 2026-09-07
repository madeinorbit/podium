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

### F4 — LOW: three doc comments still describe the deleted `executor.legacy`
member as live.

The FLIP_UNDELETED ledger item holds: `StoreExecutor`
(executor.ts:66-82) has no `legacy` member, and no runtime `legacy:` is built
in the executor composition root — the field POD-3267 was to delete is gone,
and `issue-storage.ts:451`'s `legacy` is an unrelated local. But three doc
comments still describe it as a live member repositories read:

- `apps/server/src/store.ts:116` — "An unconverted repository reads
  `executor.legacy`… POD-3267 deletes that field at the end of Stage A" (that
  deletion has happened; the comment is now describing the past as the
  present).
- `apps/server/src/store/executor/executor.ts:11-17` — "THE OBJECT
  REPOSITORIES TAKE is `{ drizzle, transact, read, legacy, context }`… legacy
  — the raw handle for repositories not yet converted."
- `apps/server/src/store/executor/bun-driver.ts:279,288,295` — three mentions
  of "the legacy handle."

What realistically goes wrong: nothing at runtime; but this is the exact
comment-contradicts-code drift that rules 56 and 57 both turned out to be
symptoms of, in the inverse direction. A reader trusting executor.ts:11's
inventory would look for a member that is not there. The specific change:
update the three comments to describe the converted-only object; the
conversion is complete, so the "not yet converted" framing is stale.

## Verification log (gates run on the tip, real output)

- Per-project typecheck (24 projects, direct, turbo bypassed): apps/server 0,
  all packages/* 0, apps/daemon/cli 0; apps/web **1** (F1), apps/mobile 4
  (inherited), scripts **93** (POD-3508). See F2.
- `lint:promise-truthiness`: `--probe` exits 0 (instrument fires), gate
  reports zero shipping findings and zero known-elsewhere. GREEN.
- `check-span-effects.ts`: exits **1**, 19 failures. See F3.
- Removed-assertion sweep over the range: 8 hits, all mechanical/import, no
  deleted behavioural assertion (see above).
- Removed-assertion sweep over the flip commit faf345269 itself (2861 raw
  removed expect-lines): normalized claim-level residue reduces to executor/
  ledger post-commit test REWRITES (the mechanism-vs-behaviour split, rule 50)
  plus the `expect(() => …)`→`await expect(…).rejects` shape — no behavioural
  assertion deleted without a mechanism deletion to match.
- POD-3494 rollback isolation: wrote a throwaway probe
  (`store/pod3295-probe-rollback.test.ts`, deleted after) — the root-prepared
  `change_latest` statement DOES route into the enclosing executor span; an
  appended latest-state row is discarded on rollback. The landed tests only
  cover the commit case; isolation is correct but UNTESTED (see below).
- `check-statement-intent.ts` (POD-3426): CANNOT COMPLETE on this tip. The
  gate runs the unit corpus via vitest (`check-statement-intent.ts:133-141`)
  and refuses to trust its count unless the corpus runs clean; the corpus
  includes `executor.test.ts`, whose two POD-3506 tests hang to timeout. So
  this gate, like F3's span-effect gate, is BLOCKED by the unlanded POD-3506
  fix — a second exit-gate the freeze has taken offline. Not a defect in the
  gate; a consequence of shipping the review before POD-3506 lands.

## Coverage gap (not a defect)

POD-3494's memoized root-prepared statements have no rollback test. I verified
isolation holds with a probe, but the suite would stay green if a future edit
re-bound them to a span instance in a way that leaked writes past a rollback.
Recommend adding the enclosing-rollback case to `sync-prepared-span.test.ts`.

## Substantive fixes read — all sound

POD-3499 (five defects), POD-3496 (19 producer-call restorations), POD-3494
(root-prepared statements), POD-3498 (unified span path + `Omit<'transaction'>`
guard), POD-3500 (four void ports widened + awaited), POD-3488 (lease-renewal
refusal), POD-3487/3485 (async ceiling/notification): each read at the diff.
No deleted behavioural assertion, no escape hatch, no re-introduced union port.
POD-3498's `Omit<FullStoreDrizzle,'transaction'>` is a genuine type-level
guard that makes reinstating the second-BEGIN branch a compile error.

## Verdict — APPROVE WITH CHANGES

The flip's central claim ("apps/server at 0 errors") reproduces and holds at
project scope, and the substantive repairs are correct. But the flip range is
NOT green tree-wide, and the "0 errors" headline is exactly as weak as the
coordinator warned: two of the three reds outside the filed set (F1, apps/web)
are the flip's own promise class, and F1 is a genuine FIFTH defect class the
existing instruments cannot see.

Blocking before checkpoint R4:
- F1 (HIGH): wrap the three `ReturnType<>` tRPC output declarations in
  `Awaited<>`; apps/web is red until then. Candidate spec rule 58.
- F2 (HIGH): file the fail-fast typecheck-gate truncation alongside POD-3508
  (apps/web hidden the same way scripts/ was).
- F3 (MEDIUM): the span-effect gate is red and POD-3498 blinded its
  repository-port entry; re-point it and adjudicate the 19 failures before it
  can gate the next landing.

Non-blocking: F4 (stale `executor.legacy` comments), the POD-3494 rollback
coverage gap, and the note that both check-span-effects and
check-statement-intent are offline until POD-3506 lands.


## Statement-intent recovery — 2026-09-07 (POD-3530)

The historical F3 validation note above no longer describes the blocker. After
POD-3506, the corpus ran but five files failed. POD-3530 repairs the remaining
async conversion gaps: daemon ingress now awaits runtime-event recording before
acknowledgement; maintenance pruning retains its victim SELECT as a SQL subquery;
and the store tests await gateway completion, subscriber commits, prefix lookups,
and preference rejections.

The statement-intent gate is restored to the next landing's exit-gate list:
`bun run lint:statement-intent` (under `test:heavy`). Its existing CI registration
remains in place. The gate implementation and incomplete-corpus refusal are unchanged.

Measured on the POD-3530 candidate based on `752f34f38`, with one worker:
50 files and 667 tests passed in 101.91 seconds, with no unhandled errors.
The probe passed; the audit examined 19,352 statements, including 11,862 gradable
read declarations (6,954 outside the executor), and found zero writes declared as
reads. Exit status: 0. This is the gate's store corpus, not the exhaustive package sweep.

The workspace lean gate stopped during mobile typechecking on four unrelated errors
tracked in POD-3615; its runtime probes did not run. Source comparison with
`aa7f620bc` confirms pruning originally kept the query unexecuted and the subscriber
and prefix tests originally used synchronous APIs. No control-arm test run is claimed.
