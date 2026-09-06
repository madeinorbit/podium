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

(populated as the review proceeds)

## Pending

- Per-project typecheck census (POD-3508 lead: what else the fail-fast gate
  hides) — running.
- Diff reading of the substantive fixes (POD-3499, 3488, 3487, 3485, 3494,
  3496, 3483, 3426, rule-55 fixture).
- Ledger-construct absence check (podium_sp_, depths WeakMap,
  runSynchronousSpan, legacy-handle-probe.ts, StoreExecutor.legacy).
- Fifth-defect-class hunt.
