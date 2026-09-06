# POD-3526 — is the store shard's standalone red an artefact of invocation?

WIP notes. The question POD-3506 left open: is `cd apps/server && bun run test:store` the
same environment Turbo gives that task? Until that is settled, none of the 56 may be
attributed to anything.

## Established by reading the configuration (no test run needed)

1. `test:store` IS a real Turbo task. It is not in the root `turbo.json` — it is in the
   generated Package Configuration `apps/server/turbo.json` (`extends: ["//"]`), together
   with the `test` aggregate whose `dependsOn` is the five shards. Root `turbo.json` has
   no `test` task at all, only the per-package `#test` entries for the other packages.
2. Both paths run the SAME command string. Turbo executes the package script verbatim:
   `bun ../../scripts/validation-admission.ts focused --label @podium/server:test:store --
   bun --bun ../../node_modules/vitest/vitest.mjs run --config vitest.store.config.ts`,
   with cwd `apps/server`. So `globalSetup`, `setupFiles`, the pre-migrated schema image,
   the fork pool and the 20s `testTimeout` are identical by construction — they come from
   `vitest.store.config.ts` -> `vitest.shard.ts` -> `sharedVitestConfig`, not from Turbo.
   A "missing globalSetup or lane env" cannot be the explanation in the shape the issue
   guessed it.
3. THE ENVIRONMENT IS NOT THE SAME, and this is measured, not recalled. `turbo run
   test:store --filter=@podium/server --dry=json` reports, for this task:

       envMode: strict
       environmentVariables: {"specified":{"env":[],"passThroughEnv":null},
                              "configured":[],"inferred":[],"passthrough":null}

   Turbo 2.10.5 defaults to `strict`, and the task declares no `env` and no
   `passThroughEnv`. The only repo-declared vars are the root `globalEnv`
   (`PODIUM_CHECK_ENV_HASH`) and `globalPassThroughEnv`
   (`PODIUM_VALIDATION_RESOURCE_HELD`). Everything else in an agent session's environment
   is dropped before the script starts.

## What that strips, and which of it the hermetic scrubber would NOT have stripped anyway

`test-hermetic-env.ts` runs as a `setupFiles` entry in BOTH arms and deletes
`PODIUM_AGENT_RELAY`, `PODIUM_SESSION_RELAY`, `PODIUM_ISSUE_RELAY`, `PODIUM_SESSION_ID`,
`PODIUM_PORT`, `PODIUM_INSTANCE`, `PODIUM_HOOK_PORT`, `PODIUM_AGENT_RELAY_PORT`,
`PODIUM_AGENT_HOME`, `PODIUM_ADOPT_STATE`, `ABDUCO_SOCKET`, `ABDUCO_SESSION` and the
`PODIUM_CODEX_HOOK_*` prefix. Those therefore cannot differ between the arms.

Present in this session and NOT scrubbed, so present in arm A and absent in arm B:

  PODIUM_TEST_WORKERS=1        the one with a mechanism. `resolveTestWorkerLimit()` in
                               vitest.config.ts reads it AT CONFIG LOAD in the main
                               process, before any setupFile runs, so the scrubber never
                               sees it. Arm A: maxWorkers 1. Arm B: unset -> the
                               DEFAULT_TEST_WORKERS of 2. Different fork concurrency for a
                               lane whose failures are 20s timeouts.
  PODIUM_LOG_LEVEL=trace       logger verbosity, not scrubbed
  PODIUM_HOME, PODIUM_WEB_DIR, PODIUM_MOBILE_WEB_DIR
  PODIUM_INSTANCE_UUID, PODIUM_SESSION_INSTANCE   (note: PODIUM_INSTANCE is scrubbed,
                               these two are not)
  PODIUM_VALIDATION_SLOTS=1    admission only
  MEMORY_PRESSURE_WATCH, BROWSER

So the answer to "is it the same environment" is already NO, before any test has been run.
What is NOT yet established is whether any of that difference MOVES the 56 — that is the
whole-shard A/B in progress.

## What is NOT being claimed here

- Not that the difference explains the failures. A different environment that produces the
  identical failure set is still an environment artefact hypothesis REFUTED.
- Not that the hangs are child-process-environment sensitive. Read against the guess in the
  brief: `snapshot-verifier.test.ts` spawns NO real child — every case injects a fake via
  `spawnProcess`. `restore.test.ts` touches `process.env.PODIUM_DB_PATH` only, and sets it
  itself. Neither reads any of the vars above.
- Nothing about the services or boundary shards. POD-3506 owns those.

## Confound to state in the verdict

flatblock is shared and was at load average 7.7-11 with ~35 other vitest processes when
these arms started. A 20s timeout is a wall-clock threshold. Both arms ran sequentially,
never concurrently with each other, but not on a quiet box.

## The strict-mode allowlist, measured rather than recalled

A throwaway two-package workspace in the session scratchpad, run with the SAME turbo binary
(`node_modules/.bin/turbo`, 2.10.5) and a task whose script is `env | sort`, invoked with
`PODIUM_TEST_WORKERS=1 PODIUM_LOG_LEVEL=trace PODIUM_HOME=/x FOO_PROBE=bar turbo run envdump`:

  none of PODIUM_TEST_WORKERS, PODIUM_LOG_LEVEL, PODIUM_HOME or FOO_PROBE reaches the script.

What does survive is exactly turbo's system allowlist plus its own and the package manager's
vars: COLORTERM, COREPACK_ENABLE_AUTO_PIN, DBUS_SESSION_BUS_ADDRESS, HOME, LANG, NODE, PATH,
PWD, SHELL, SHLVL, TERM, TURBO_HASH, TURBO_INVOCATION_DIR, USER, XDG_DATA_DIRS,
XDG_RUNTIME_DIR, npm_*.

FOO_PROBE is the canary: an unrelated name proves the dump is showing a filtered environment
and not merely an environment that happened to lack the Podium vars.

So: under Turbo the store shard runs at vitest's `DEFAULT_TEST_WORKERS` of 2. Run directly
from an agent session it runs at `maxWorkers: 1`. That is a real, mechanical difference in
how a lane whose failures are 20s wall-clock timeouts is executed.

## THE ANSWER: the 56 are NOT an artefact of invocation

Whole-shard A/B, same checkout (integration tip, fc2d197e4), sequential,
never concurrent with each other, diffed BY TEST NAME from untruncated logs.

| arm | invocation | env | maxWorkers | failed | passed | files | errors | duration |
|---|---|---|---|---|---|---|---|---|
| A | `cd apps/server && bun run test:store` | full agent-session env | 1 | 56 | 1213 | 12 failed / 91 | 16 | 336.03s |
| B | `turbo run test:store --filter=@podium/server --force` | turbo strict (all PODIUM_* stripped) | 2 | 56 | 1213 | 12 failed / 91 | 16 | 195.67s |

- **In A but not B: none. In B but not A: none.** All 56 names match exactly.
- Per-file failed counts are identical across all twelve failing files.
- The hang-shaped set is identical: the same 9 tests time out at 20000ms in both arms.

The environments really were different and really did change execution — the arm B run is
140s faster on the same 1269 tests, which is the doubled fork concurrency. Concurrency
doubled, every Podium variable stripped, and not one test name moved.

**So the alternative explanation is refuted.** These are not an effect of running the shard
outside Turbo. Attribution may proceed.

## Correction to the issue brief's shape of the problem

The brief describes the failures as "ten of which hang for twenty seconds", which reads as
if hanging were the characteristic mode. Measured, arm A:

  9 tests at 20002-20009ms   (the 20000ms testTimeout)
  2 tests at ~1010ms
  45 tests under 200ms       (the largest at 197ms)

Forty-five of the 56 are ordinary fast assertion failures, and they are the bulk of the
finding. The tenth hang POD-3506 counted is 'keeps live-tail and completion-reconcile
overlap exact after reload': it FAILS in both of my arms, but at 10157ms / 10313ms, under
the timeout. So the hang-shaped SET is not stable run to run even though the FAILING set
is — one test crosses the 20s line on some runs and not others.

## One shared artefact still to rule out

Both arms share `node_modules/.cache/podium-test-schema/<digest>.db` — POD-523's
pre-migrated schema image, keyed on a hash of the migration manifest and built once per
checkout. An A/B inside one checkout cannot distinguish "the code is red" from "this
checkout's cached image is bad". The dev/mw arm below has its own node_modules and so
rebuilds its own image, which answers this and the attribution question in one run.

---

# ATTRIBUTION: all 56 are regressions of this epic. None predates it.

Control arm at **dev/mw = 2e06fa9a4**, which is also the merge-base of the integration
branch (`git merge-base dev/mw HEAD` = 2e06fa9a4 — the integration branch has not been
rebased onto a moved dev/mw, so "the base" is unambiguous). Own detached worktree
`/home/mgw/pod3526-base-devmw`, own `bun install --frozen-lockfile`, own
`node_modules/.cache` — so this arm also rebuilds POD-523's schema image from scratch and
retires the shared-cache confound noted above.

The shard boundary MOVED, so the base arm is two shards, not one. At the base the store
shard is 41 files; at the tip it is 91. Two of the failing files (`authz-matrix.test.ts`,
`modules/operations/engine.test.ts`) were in the **contracts** shard at the base and are in
**store** now, because their import closure now reaches `src/store` (shardOf rule 5). Both
base shards were run.

| arm | files | tests | failed |
|---|---|---|---|
| base `test:store` | 41 | 338 | 1 |
| base `test:contracts` | 98 | — | 3 (3 files) |
| tip `test:store` | 91 | 1269 | 56 |

**Not one of the 56 names appears at the base.** The base's own four failures are
different tests in different files (`per-user-state-family`, `modules/shipping/queue`,
`modules/updates/local-participant`, `session-projection.audit`) and none of them is in
the 56 — those four ARE pre-existing on dev/mw, and they are somebody else's finding, not
this one.

## Per file

| file | failed | at the base | attribution |
|---|---|---|---|
| `migrations/restore.test.ts` | 19 | present, 6 epic commits, +89/-80 | **regression** — all 19 observed passing at base |
| `store/runtime-events.test.ts` | 11 | **did not exist** | new file, red |
| `migrations/snapshot-verifier.test.ts` | 9 | **did not exist** | new file, red |
| `modules/operations/engine.test.ts` | 5 | present, 8 epic commits, +333/-125 | **regression** ×4 observed passing at base; 1 is a new test |
| `authz-matrix.test.ts` | 3 | present, 1 epic commit, +9/-9 | **regression** — all 3 observed passing at base |
| `modules/automations/scheduler.single-flight.test.ts` | 3 | **did not exist** | new file, red |
| `store/user-preferences.test.ts` | 1 | present, 6 epic commits | **regression** — observed passing at base |
| `store/repos-read-cost.test.ts` | 1 | present, 9 epic commits | **regression** — observed passing at base |
| `store/maintenance.golden.test.ts` | 1 | **did not exist** | new file, red |
| `store/executor/span-side-effects.test.ts` | 1 | **did not exist** | new file, red |
| `migrations/snapshot-verifier-boundary.test.ts` | 1 | **did not exist** | new file, red |
| `migrations/pre-migrated-fixture.test.ts` | 1 | present, 2 epic commits | **regression** — observed passing at base |

  **29** existed at the base and are OBSERVED PASSING there
  **27** did not exist at the base (26 in six files the epic added, plus one new test in
         `engine.test.ts`)
  **0**  predate the epic

Zero of the failing files is unchanged since the base. Every one was either added by the
epic or rewritten by it.

## The canary, because "did not fail" and "did not run" look identical

The whole-shard base arm only tells you a name is absent from a failure list. So each of
the six pre-existing files was ALSO run at the base under `--reporter=verbose`, which
prints passing test titles, and the tip's failing titles were intersected with the base's
PASSING titles:

    base store canary     4 files, 4 passed  -> 22 of 22 tip failures observed PASSING
    base contracts canary 2 files, 2 passed  ->  7 of  8 tip failures observed PASSING
                                                 (the 8th, 'names the outcome with the
                                                  attempts and stalls that produced it',
                                                  is a test the epic added)

29 positive observations, not 29 absences.

## A second harness fact, found on the way and NOT the cause of anything here

`cd apps/server && bun run test` prints the five-shard roster and **exits 0 having executed
no tests**. Verified on the tip: "444 unit files across 5 shards", exit 0, 5s. That is a
runner that can be invoked in a way that lies — but it lies in the opposite direction to
this issue's hypothesis (it under-reports work done, it does not manufacture failures), and
under Turbo the aggregate `test` task's `dependsOn` runs all five shards, so the lane is
honest where it is actually gated. It did not affect any measurement here.

## WHAT I AM NOT CLAIMING

- **Not a cause for any of the 56.** This issue asked whether they are real; it did not ask
  which commit made each one red, and I did not bisect. "The epic did it" is a statement
  about the interval dev/mw..tip, not about a commit.
- **Not that the 27 new-file failures are regressions.** They are tests written during the
  epic that do not pass on the tip. Whether each is a red product or a red test is a
  question for its owner; a new test failing is not the same defect class as a test that
  used to pass.
- **Nothing about services or boundary.** POD-3506 owns those; I did not run them.
- **Not that the hang set is stable.** It is not: 9 tests crossed 20000ms in both of my
  arms, POD-3506 saw 10, and the tenth ('keeps live-tail and completion-reconcile overlap
  exact after reload') fails in my arms at ~10.2s. The FAILING set was perfectly stable
  across two arms; the HANGING subset of it was not.
- **Not measured on a quiet box.** flatblock was at load average 7-19 throughout, with other
  sessions' vitest runs. Every arm here is same-box and the arms were never concurrent with
  each other, but a 20s timeout is a wall-clock threshold and the 9/10 disagreement above is
  probably exactly that.
