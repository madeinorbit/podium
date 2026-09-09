# Cross-platform experiments

Throwaway spikes that need a real answer from linux, macOS and Windows — not a guess,
and not three machines borrowed by hand.

Each experiment is one directory here. `.github/workflows/platform-experiment.yml` runs
it on every platform in the matrix and uploads what it produced.

## The contract

`scripts/experiments/<name>/run.ts` is the entrypoint. The harness invokes it as
`bun run.ts` on each runner, with `EXPERIMENT_OUT` set to a per-platform directory.

`run.ts` must:

- write `result.json` (and anything else worth keeping) into `$EXPERIMENT_OUT`;
- append a markdown summary to `$GITHUB_STEP_SUMMARY` when that variable is set;
- **exit 0 whenever the experiment ran.** A negative finding is a result, not a CI
  failure. Exit non-zero only when the harness itself is broken — fixtures will not
  compile, a required tool is missing.

Nothing else is assumed. `bun install` is opt-in (`install: true`), so an experiment
with no workspace imports starts in seconds.

## Running one

Once `platform-experiment.yml` is on the default branch, dispatch it directly with the
experiment name. Before then — a spike branch that never lands on main — copy
`ipc-pipe-spike.yml`: a thin wrapper that `uses:` this workflow and carries a temporary
`push:` trigger scoped to its own branch. `workflow_dispatch` only resolves workflows
that exist on the default branch; a `push:` trigger resolves on the pushed branch.

Read results with `gh run list --workflow <wrapper>.yml` and `gh run view <id>`, or from
the run's step summary, which carries each platform's table.

## Keeping them

The **workflow** is the reusable artifact and should stay. The fixtures under an
experiment directory are throwaway: delete them once the spike's report is written, or
leave them as the executable record of how an answer was reached.
