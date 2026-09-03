# The merge gate, against main

Ordered by the post-integration staleness audit: gate the integrated tree
before any acceptance cell is re-read. This is that gate.

## What was run

Both arms ran the SAME command, `bun scripts/test.ts --filter @podium/daemon
--filter @podium/server`, with `PODIUM_SESSION_ID` and `PODIUM_TEST_WORKERS`
both unset.

| arm | commit | worktree |
| --- | --- | --- |
| epic | `530e537ad` (tip of `issue/1761-agent-runtime`) | this one |
| main (control) | `22e8e772e` (`origin/main`) | `/home/mgw/pod1761-main-control`, detached |

## Typecheck

GREEN on the integrated tree: **25/25 packages, 0 cached, 0 errors**. Zero
cached matters — the result was computed, not replayed.

## The confound was removed, not assumed away

The first suite run had `PODIUM_TEST_WORKERS=1` set from the session
environment, which is known to redden this gate. Re-running with it unset
produced **byte-identical tallies** (17/12/7/2 across the same lanes), so the
failures are a property of the tree and not of the environment. Stated because
a number from a lane whose width you did not control is not a number.

## Headline

Main fails the SAME FIVE LANES. "Five of six lanes red" is the BASELINE
CONDITION, not something the integration did. Anyone reporting the epic's raw
lane list as breakage is reporting main's own state back at themselves.

| lane | main | epic |
| --- | --- | --- |
| `server:store` | 1 failed / 42 | 0 failed / 45, +1 unhandled rejection |
| `server:services` | 4 failed / 96 | 12 failed / 106 |
| `server:boundary` | 13 failed / 106 | 17 failed / 109 |
| `daemon:test` | 2 failed / 81 | 7 failed / 114 |
| `server:normalized-wire` | 2 passed | 2 passed |

Do not read those counts as the finding. The two arms run DIFFERENT numbers of
test files (the epic adds tests), so a count delta is not a regression count.
The file sets are what carry the claim.

## The sets

Extracted from each run's own `FAIL` lines and RECONCILED against the runner's
tallies: 38 and 20, matching `Test Files ... failed` exactly. An earlier
extraction of mine returned 7 and 2 and was discarded for failing that check —
a hand-built regex that disagrees with the runner is wrong about the runner.

- **13 fail on BOTH** — pre-existing, not this epic's doing.
- **7 fail on MAIN ONLY** — green here, red there.
- **25 fail on the EPIC ONLY**, which split by whether the file exists on main:
  - **19 EXIST ON MAIN — these are the regression candidates.**
  - 6 are new in the epic: its own new tests failing. Real problems, but not
    regressions against main.

Full sets: `epic-failing-files.txt`, `main-failing-files.txt`.

## Verified, not inferred

"Passes on main" was checked by running three of the nineteen directly in the
control rather than concluding it from absence in a fail list:

    relay.test.ts, router.machines.test.ts, browser-open.test.ts
    => Test Files 3 passed (3), Tests 185 passed (185)

## Likely root causes — few, not nineteen

The 19 are not 19 independent breaks. The error census over the epic arm:

- **43x** `TRPCError: machine '<name>' is still probing whether <agent> is
  installed` (thrown at the same `router` line 671, 56 hits). A precondition
  the epic added that the existing fixtures never satisfy.
- **39x** `TypeError: The first argument must be of type string, Buffer, ... 
  Received undefined` — a bytes path handed nothing.
- **4x** `ctx.agentRuntime?.handleFor is not a function` — runtime wiring absent
  from the test context.
- **2x** `this.ports.inbox.handleControllerInputBytes is not a function` — a
  caller invoking a method its port does not define. This is the shape a merge
  seam makes when it typechecks but does not line up at runtime, and it is
  exactly what a green typecheck cannot catch.

Three or four fixes plausibly clear most of the nineteen.

## A real defect the tally hides

`server:store` reports `45 passed (45)` / `366 passed` and STILL exits 1, on one
unhandled rejection:

    RangeError: Cannot use a closed database
      listOpen     apps/server/src/store/interactions.ts:173
      closeSession apps/server/src/store/interactions.ts:336
      closeOpen    apps/server/src/modules/interactions/service.ts:714
                   apps/server/src/modules/interactions/service.ts:702

Line 702 fires `closeOpen` without awaiting, so the work outlives the database
teardown already closed. Every test passing is why this is worth catching: the
tally says clean, the lane says failed, and the lane is right. Main fails one
store file; the epic fails none but leaks this instead.

## Known bias, and which way it points

The control shares the epic's `node_modules` for third-party packages, with
`@podium/*` repointed at the control's own workspace (27 packages linked, no
`agent-runtime` — the correct signal that main's layout is what ran). If a
shared dependency version suits the epic better, that inflates MAIN's failures.
It therefore cannot manufacture a regression, only conceal one. The 19 stand
DESPITE the handicap being on main's side.
