# POD-1688 — affected-only test selection: evidence

What `bun run test:affected` selects, measured. Entry point: `scripts/test-affected.ts`.

## Selection

Measured with `turbo run <task> --filter='...[<merge-base>]' --dry=json` on a clean
worktree, one edit at a time, reverted between runs. Base = `git merge-base HEAD origin/main`.

| change | packages selected |
| --- | --- |
| clean tree | 1 — `@podium/scripts` |
| doc only (`README.md`) | 1 — no change |
| leaf (`packages/telemetry/src/index.ts`) | 6 — `telemetry` + `cli`, `server`, `telemetry-relay`, `web` |
| app leaf (`apps/web/src/…`) | 2 — `web` only; nothing depends on it |
| hub (`packages/model/src/index.ts`) | 24 — the whole workspace |

`@podium/scripts` appears in **every** row including the clean tree: this branch's own
commit adds `scripts/test-affected.ts`, which is a real change versus the base. That is
correct selection, not noise — subtract it to read the deltas.

Doc-only adds nothing, a leaf pulls in exactly its dependents, and the hub pulls in
everything. Untracked and uncommitted files count toward selection.

### These numbers were measured against `typecheck`, not `test`

Stated plainly so a later reader does not assume otherwise: **the lane has never been run
end to end.** At the time of measurement POD-1687 had landed nothing — there was no `test`
task in `turbo.json` — so every row above was produced with `turbo run typecheck`.

Package **selection** is task-independent (the `--filter` resolves the package graph
before any task is looked up), so the sets carry over to the `test` task unchanged. But
nobody has yet watched real test suites execute through this entry point. The first run
against a merged `test` task is still owed.

A dry-run against POD-1687's uncommitted `turbo.json` was attempted and discarded: copying
their file in made `turbo.json` itself a change versus the base, which — per the caveat
above — selected all 24 packages and told us nothing.

### Caveat: a turbo.json or root package.json edit selects everything

`turbo.json` and the entries in `globalDependencies` (`package.json`, `bun.lock`,
`tooling/tsconfig/**`) are global. Changing one invalidates the whole graph and
`...[base]` selects all 24 packages. This over-selects, which is safe — but it means
the affected lane gives you no speedup on a branch that touches those files, and it is
why a mid-experiment edit to `turbo.json` will silently flatten a selection test.

## What this lane does not cover

A package filter can only select packages. These lanes sweep the monorepo from **root**
vitest configs and belong to no package, so no filter can scope them:

- `test:unit` — root vitest sweep (`vitest.unit.config.ts`)
- `test:integration` — real processes, PTYs, server boots
- `test:acceptance` — loop-split load suite
- `test:bun:unit` — bun-native `*.bun.test.ts` suites

Rather than let those drop out silently, the entry point **exits 1** when any changed
file is not owned by a package that defines a `test` script:

```
$ bun scripts/test-affected.ts
test:affected — base: merge base with origin/main (ecd55d614)
  1 changed file(s) vs base

this lane does NOT run, at any time:
  test:unit         — root vitest sweep over the whole monorepo
  …
run `bun run test` before you commit.

test:affected refused: these changed files are INVISIBLE to the `test` task —
no package filter can select them, so a pass here would not mean they are tested:

  scripts/test-affected.ts
    @podium/scripts defines no `test` script
```

Verified refusal cases: a `vitest.unit.config.ts` edit (no owning package) and a
`scripts/` edit (owning package has no `test` script). Both select no real package and
would otherwise have printed a clean green.

### Inert files do not refuse

Prose cannot change a test outcome, and refusing on a README edit would only train people
to reach for `--allow-uncovered` until the refusal stops meaning anything. So `*.md`,
`LICENSE`, and `NOTICE` are treated as covered by construction. The list is deliberately
narrow: `scripts/`, `vitest.*.config.ts`, `turbo.json`, and `tooling/` are **not** inert
and keep refusing.

One carve-out, and it is load-bearing: `packages/telemetry/src/docs-drift.test.ts` reads
the repo-root `docs/TELEMETRY.md`. Editing that doc can turn a real suite red, and no
package filter will select telemetry for it — turbo hashes only telemetry's own directory.
So `docs/TELEMETRY.md` is listed in `DOCS_READ_BY_TESTS` and keeps refusing.

That list would rot the moment another test starts reading a repo doc, so
`test-affected.test.ts` carries a drift guard: it greps the suites for repo-root doc reads
and fails if one is missing from the list. Confirmed non-vacuous — it currently finds
`docs/TELEMETRY.md`.

## Base ref

Resolved, never hardcoded — the merge base against the **closest** of: an explicit
`--base` / `PODIUM_TEST_BASE`, the configured upstream, `origin/main`, and
`origin/project/*`. Only `main` and `project/*` are candidates, so another agent's issue
branch can never become the base and move the fork point forward.

Closest-wins matters because agents work in worktrees cut from long-lived branches: a
worktree off `project/testing` must diff against that branch, not against `main`.

## Known gap

`turbo run test` fans out to the ~20 packages that define a `test` script, and those
per-package scripts run **without any vitest config** — no `@podium/source` condition, no
hermetic setup files, none of the unit lane's exclusions. `packages/telemetry` fails
outright today. Filed as POD-1693; it is a property of the per-package scripts, not of
this filter.
