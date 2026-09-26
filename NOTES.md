# NOTES — POD-4588 (Hc3 hand-rolled lifecycle walls)

Scratchpad for this issue only. Deleted before landing; the record of note is
`docs/measurements/POD-4588-c3.md`.

## Situation (2026-09-26)

- Branch based on integrate/4545-round-three. Blocked by POD-4587 (Hc2, still WIP on this branch).
- Coordinator addendum: time ONLY on flatblock, own checkout `~/podium-timing-4588`,
  under `bench:flatblock`, MobX lanes first. Matrix: `--arms noop,control,hand
  --scales 1 --rounds 4 --samples 5 --scenarios coldBootstrap,principalSwitch,rescope`.
  `entries.test.ts` must be green before any browser run.
- Live lanes to avoid: POD-4705 (arms/mobx/pool), POD-4702 (harness/lint,
  shared/src/gen/changes.ts), POD-4694 (arms/hand/pool/worklist). Mail before
  touching their files. I do NOT plan to touch any of them: harness reused
  unchanged; worklist/* read-only.
- `bench:flatblock` currently held by POD-4702 (TTL ~240m), queue: 4694, 4286.
  I am NOT in the queue yet; will acquire when 4702/4694 timing is done and
  4705 has timed (its numbers are the fairer MobX comparison).

## Pre-timing gates (done 2026-09-26, this worktree)

- entries.test.ts green 2/2 (hand -> handPoolArm, mobx -> mobxPoolArm).
- Hand bootstrap counts green (`bootstrap.test.ts`, 148s, 1 passed).
  1x lazy: 59,313 live cells; member 2,736; rank/placement/rowViewParts 732;
  filing 9,734 = 2 x filedIssues 4,867 (EVERY known issue incl. 2,131 cold);
  issuePartSets 4,867 (every known issue); verdicts 61; rollupParts 497;
  sessPartSets 1,758. built total 116,437. 4x linear (237,536 live).
  => ~12.2 cells per known issue, ~81 per visible row. Same SHAPE as MobX's
  miss (per-known-issue construction incl. cold rows nothing reads), ~4x
  smaller constant (59k cells vs 213k observables), cells cheaper than
  computeds+reactions+closures.

## Open questions

- Does the hand arm's bootstrap build anything per known issue that a plain
  one-pass compute (control ~109ms build) avoids? Yes: 2 filing cells + a
  visibility part set per known issue (cold incl.). Fix = lazy filings, in
  worklist/rollup.ts + visible.ts = POD-4694's files. Likely outcome: report
  mechanism, no code change (Mc3 precedent), maybe spin follow-up.
- Dispose path (pool.ts + arm.ts) looks thorough; survivor fence in matrix
  will verify. Heap-by-constructor: reuse /tmp/mc3-heap.ts pattern for hand;
  commit into harness/browser if used (additive; mail coordinator first).
- POD-4705 (MobX lazy nodes) not landed: note both MobX numbers in the doc.
- CaughtException watch (4705 addendum): check hand heap for the same
  exception-as-control-flow signal.

## Timing runs

- (pending lock) matrix hc3-life on flatblock; summarize; heap snapshots.
