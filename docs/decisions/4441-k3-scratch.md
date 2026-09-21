# K3 scratch (delete before landing) — README-only expectations, written before reading arm code

I did not build the TanStack arm. I read only `packages/worklist-proto/arms/tanstack/README.md`
(this file's §"Expectations" timestamped before any arm-code read) plus the K1 hand exercise
and the issue brief. Load >8 throughout, so verdicts rest on counts not walls.

## Expectations from the README recipe (dueSoon 6-step example + 7-place list)

- A (snooze: `snoozedUntil` hides row while `coarseNow` before it; reappear on passing tick):
  Expect `rules.ts` (pure predicate citing spec), `queries.ts` (carry input through `issuesN`,
  compute own-row in `summaryQ` fold), `rollup.ts` (include in compared value so changes emit),
  `store.ts` `refreshRow` + `rowsQ` fold (assemble into committed `SliceRow`), tests in
  `tanstack.test.ts`. Clock reappearance should be free: clock writes the locals row and
  "the joined queries re-run". Open question: `shared/src/slice-types.ts` is frozen and the
  oracle compares exactly those fields — snooze needs somewhere to live; either SliceRow
  already has a spare field or I need a coordinator exception. Hand arm needed no shared/
  change for C2, so maybe SliceRow suffices here too.
- B (continuation walk, legacy `issueContinuation` rule): own-row derived line, so
  `rules.ts` + `summaryQ` fold + `rowsQ`/`refreshRow`. No rollup subtree work expected.
  It should "ride beside the snapshot" like the hand arm's side map — but here there is no
  side map idiom; everything goes through queries, so expect a carried field through
  `summaryQ` → `rowsQ`.
- C (ask bubbles root from any descendant): subtree aggregate, so `rollup.ts` `compute`
  + compared value. Expect the narrow question: which descendants are visible to the walk
  (hand arm hit archived-detach here).
- C2 (worktree rows as second row kind): a new query in the chain (`laneQ` exists — maybe
  extend it), plus rollup seats, plus store commit-layer/order/groups, plus the SliceRow
  kind question (frozen shared/). Biggest change by far; expect 4-6 files.

Idiom guesses: foot-gun D = "add an input that the sync routing does not write into any
collection" (brief says exactly this); E = remove an explicit removal branch (`dropSession`
or the `ingestIssue` removal branch) since "sync deletes are silent"; F = `for` loop over
a collection inside `react/list.tsx` Row.
