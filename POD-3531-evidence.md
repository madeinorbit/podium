# POD-3531 — the direct `@podium/server` test path ran nothing

## The decision, stated

`cd apps/server && bun run test` is a **convenience alias**. It is the documented-looking
command in the package directory and it must run the same five shards Turbo runs.

The alternative reading — a deliberately narrow entry point that refuses and points at the
shards — was rejected. `test` is the name of the lane in every other package, the shard split
is an internal caching detail, and an entry point that refuses to do the obvious thing teaches
people to stop reading it.

So the default now **runs**, and the run **accounts for itself**.

## What was wrong

`@podium/server#test` is a Turbo *aggregate*: `dependsOn` names the five shard tasks and the
package's own `test` script was only ever the roster check. Under Turbo that is honest. Run by
hand it was not:

```
$ cd apps/server && bun run test
@podium/server test shards — 445 unit files across 5 shards:
  contracts         99  …
  store             91  …
  services         132  …
  boundary         121  …
  normalized-wire    2  …

real 0m0.332s     EXIT=0
```

445 files announced, 0 run, exit 0, in a third of a second.

## The shape of the fix (POD-3517's, not a patch)

1. Each shard's Vitest config now writes a **JSON report of the files it executed** to
   `apps/server/.test-shard-reports/<shard>.json`. Declared as the shard task's Turbo
   `outputs`, so a cache hit restores the evidence along with the result.
2. `reconcile()` in `scripts/server-test-shards.ts` refuses unless every announced file
   appears in some shard's report — per shard, by name, with both counts.
3. Run directly, the aggregate runs the five shards itself (`bun run test:<id>`, the same
   script Turbo runs, so the two paths cannot drift), sequentially, **without fail-fast** —
   a fail-fast would abandon shards the roster still claimed, which is the accounting hole
   POD-3517 closed for typecheck.
4. Run under Turbo (`TURBO_HASH` set — verified empirically against turbo 2.10.5, whose
   strict env mode passes a task nothing else), the shards ran as dependencies, so the
   aggregate reconciles their reports instead of re-running them.
5. `--roster` is the only way to get the list without the lane, and it says out loud that it
   ran nothing.

## Evidence

### Control arm (rule 56a: the control cannot show a refusal, because the old runner never refused)

Same probe, both arms: the real CLI, with the per-shard command replaced by a recorder.

| arm | shards invoked | exit | output |
| --- | --- | --- | --- |
| **HEAD (before)** | **0** | **0** | roster only |
| this branch | 5 | 0 | `445 unit files announced, 445 executed across 5 shards.` |

The control arm was taken by copying the four changed tracked files to the session scratchpad,
`git restore --source=HEAD --worktree`-ing them, running the probe, and copying back — no
stash, because the stash stack is shared by every worktree of this repo.

The first test in `scripts/server-test-shards-run.test.ts` asserts exactly the left column's
absence: `expect(result.invoked).toEqual([five shard ids])`. Against HEAD it fails on 0.

### Discrimination from the other side: collected ≠ announced

A **real** short report, not a stub: the `contracts` shard config was run over 4 of its 99
files, then the aggregate was asked to reconcile.

```
server test lane refused: the run did not account for the 445 files it announced.

  [short-shard] shard "contracts" announced 99 files but executed 4; did not run:
      apps/server/src/codex-auth.test.ts, … +90 more
  [unrun] shard "store" announced 91 files but left no record of running any:
      …/.test-shard-reports/store.json is missing or unreadable: ENOENT
  [unrun] shard "services" announced 132 files …
  [unrun] shard "boundary" announced 121 files …
  [unrun] shard "normalized-wire" announced 2 files …
  [roster-mismatch] the roster announced 445 unit files across 5 shards; the run executed 4

EXIT=1
```

Isolating: the shard, both counts, the specific files — not a timeout and not a bare non-zero.

### Tests

`scripts/server-test-shards-run.test.ts` — 9 tests, all passing:

- runs every shard it announced, and says so *(the control arm)*
- refuses, naming the shard and both counts, when a shard runs fewer files than it announced
- refuses when a shard leaves no record of having run — and still runs the other four
- `--roster` prints the list, runs nothing, and says that it ran nothing
- `reconcile()` accepts an exact run; refuses an unclaimed file; refuses a failed shard
- the default per-shard command is the same `test:<id>` script Turbo runs
- each shard declares its report as a Turbo output *(the cache-restore guarantee)*

Existing guards re-run green: `server-test-shards.test.ts`, `server-test-reuse.test.ts`,
`test-configuration.test.ts` — 56 tests.

### Real shard, real report

The unmodified `vitest.contracts.config.ts` run wrote
`apps/server/.test-shard-reports/contracts.json` covering **both** projects of the reuse split
(`server:contracts:reused` and `server:contracts:isolated`) — the case where a half-covered
report would have read as a short shard.

## Files

- `apps/server/test-shard-report.ts` *(new)* — the fixed path both sides agree on, and the
  report parser. Fixed rather than passed in: Turbo's strict env gives the aggregate no way to
  hand its sibling shard tasks anything.
- `apps/server/vitest.shard.ts` — root-level JSON reporter, never per-project.
- `scripts/server-test-shards.ts` — `reconcile()`, `runShards()`, the rewritten CLI.
- `apps/server/turbo.json`, `apps/server/test-shards.json` — regenerated
  (`bun scripts/server-test-shards.ts --write`); shard tasks gained their report `outputs`,
  every shard gained `test-shard-report.ts` as a lane input.
- `.gitignore` — `apps/server/.test-shard-reports/`.

`apps/server/package.json` is unchanged: the fix lands entirely behind the script the `test`
alias already pointed at. `scripts/typecheck.ts` was read as the precedent and not modified.

## Probe seams (setup edits, per the preamble)

- `PODIUM_SERVER_SHARD_COMMAND` — replaces the per-shard command; the test drives the real CLI
  against a stub instead of 445 files.
- `PODIUM_SERVER_SHARD_REPORT_DIR` — relocates the report directory so a test never touches the
  checkout's own reports.

Neither can reach the gated lane: Turbo's strict env mode passes a task nothing it has not
declared, and neither is declared.

## Host load, and what it does and does not touch here

Per POD-3221's box-level warning: flatblock is 8 cores; load average while this work ran was
**41–128** (peaks around 128 early, 41 at the time of writing), with ten sessions live.

**Unaffected.** Every discriminating result above is an assertion or a count, not a duration:
shards-invoked 0 vs 5, announced-vs-executed file counts, the text of each refusal. Contention
does not change an expected value.

**Affected, and corrected.** The `contracts` shard reported 3 failures
(`release-approval.test.ts` ×2, `local-participant.test.ts` ×1). All three are **20s vitest
timeouts — hang-shaped**, which is the one failure this box cannot currently produce honestly.
They reproduced under the untouched root `vitest.unit.config.ts`, at load ~18–45, which rules
out this change as their cause but does **not** establish them as code defects. They need a
re-run under load < 16 before anyone writes them down as red.

Timing figures in this report are therefore wall-clock under contention and are not
measurements of anything.

`PODIUM_TEST_WORKERS` was **not** set.
