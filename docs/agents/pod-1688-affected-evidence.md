# POD-1688 — affected-only test selection: evidence

What `bun run test:affected` selects and runs, measured. Entry point:
`scripts/test-affected.ts`.

POD-1687 is merged into this branch at `ef36a6e9c`, so everything below except the
clearly-marked proxy table was measured against the **real `test` task**.

## What the task can run at all

`turbo run test` is deliberately **pinned** — `turbo.json` defines `@podium/web#test` and
`@podium/mobile#test` and no generic `test` entry. So the lane can only ever run those two
packages, and `--filter` cannot widen it:

```
$ turbo run test --dry=json
tasks: [@podium/mobile#test, @podium/web#test]
```

That pin is POD-1687's response to POD-1693: ~20 other packages ship a bare
`vitest run --passWithNoTests`, and run from the package directory vitest does not walk up,
so it finds no config — no `@podium/source` condition, no `setupFiles`, none of the unit
lane's exclusions.

**Those packages are not untested.** They are tested by the root `test:unit` sweep, which
uses vitest's default `**/*.test.ts` from the repo root. Verified directly:

```
$ bun --bun node_modules/vitest/vitest.mjs run --config vitest.unit.config.ts \
    --project node packages/telemetry/src/scrub.test.ts
Test Files  1 passed (1)      Tests  24 passed (24)
```

That same file **fails** when run the per-package way (`Failed to resolve entry for package
@podium/model`), because the root config is what supplies the `@podium/source` condition.
So the correct framing is: these packages are covered by `bun run test`, and structurally
*not* coverable by `test:affected`. That is why refusing on them is correct rather than
merely cautious.

## Selection, against the real `test` task

Clean worktree, one edit at a time, reverted between runs, `--filter='...[HEAD]'`:

| change | tasks selected |
| --- | --- |
| clean tree | none |
| doc only (`README.md`) | none |
| `apps/web/src/…` | `@podium/web#test` |
| `packages/model/src/…` | `@podium/web#test`, `@podium/mobile#test` |
| `packages/runtime/src/…` | `@podium/web#test`, `@podium/mobile#test` |

A `packages/*` edit pulls in both suites because POD-1687 declared
`$TURBO_ROOT$/packages/*/src/**` as an explicit input — the web and mobile suites import
those packages as source. Note the asymmetry that follows: editing `packages/model` re-runs
the web and mobile suites *that consume it*, but model's **own** tests still do not run, so
the lane refuses (below).

### End-to-end, really executed

Not a dry run — real suites, with an `apps/web` edit:

```
@podium/web:test  Test Files  207 passed (207)
                  Tests       1661 passed
 Tasks:    1 successful, 1 total        Time: 5m19s
```

Only `@podium/web#test` was selected and run. An unrelated re-run on a clean tree returns
`Cached: 1 cached, 1 total  Time: 428ms >>> FULL TURBO`.

One honest note: the first such run reported 2 failed files out of 207. Re-running the
identical edit gave 207 passed, and that run's timings were pathological (748s import,
392s environment) on a loaded host. Treated as flakiness in the web suite under load — not
caused by this lane and not reproducible.

### The earlier table used `typecheck` as a proxy

Superseded, kept for provenance. Before POD-1687 landed there was no `test` task, so the
first selection table was measured with `turbo run typecheck`: doc-only selected nothing, a
`packages/telemetry` edit selected 6 packages (it + 4 dependents), `packages/model` selected
all 24, `apps/web` selected 2. Package *selection* is task-independent, so those sets were
sound as far as they went — but they described the whole workspace graph, not the pinned
two-task graph the lane actually runs. The table above replaces them.

### Caveat: a turbo.json or root package.json edit selects everything

`turbo.json` and the `globalDependencies` entries (`package.json`, `bun.lock`,
`tooling/tsconfig/**`) are global. Changing one invalidates the whole graph, so the lane
gives no speedup on such a branch. It also silently flattens selection experiments — an
attempt to dry-run against POD-1687's then-uncommitted `turbo.json` by copying it in made
`turbo.json` itself a change versus the base, selected all 24 packages, and proved nothing.

## What this lane does not cover

A package filter can only select packages. These lanes sweep the monorepo from **root**
vitest configs and belong to no package, so no filter can scope them:

- `test:unit` — root vitest sweep (`vitest.unit.config.ts`)
- `test:integration` — real processes, PTYs, server boots
- `test:acceptance` — loop-split load suite
- `test:bun:unit` — bun-native `*.bun.test.ts` suites

Rather than let those drop out silently, the entry point **exits 1** when any changed file
is not in a package turbo can actually run `test` for:

```
$ bun run test:affected          # after editing packages/model/src/index.ts
test:affected — base: explicit base "HEAD"
  turbo can run `test` for 2 package(s): @podium/mobile, @podium/web

test:affected refused: these changed files are INVISIBLE to the `test` task —
  packages/model/src/index.ts
    @podium/model has no `test` task in turbo.json — turbo would run nothing
    and exit 0 (POD-1693)
```

### Coverage comes from the task graph, not package.json

This is the integration bug that the pinned design exposed, and it is worth stating
because the first implementation got it wrong in the dangerous direction.

Coverage was originally decided by "does this package define a `test` script in
package.json". Under the pin that is false comfort: 14 packages define that script and have
**no turbo task**. Editing one passed the coverage gate, ran `turbo run test --filter=…`,
matched no task, ran nothing, and exited **0** — a green for tests that never ran. The
refusal path was intact; the check in front of it was lying.

Coverage now comes from `turbo run test --dry=json`, the only authority on what turbo can
execute. The lane therefore widens by itself: when POD-1693 gives a package a real config
and a task, it becomes covered with no change to `scripts/test-affected.ts`.

### Inert files do not refuse

Prose cannot change a test outcome, and refusing on a README edit would only train people
to reach for `--allow-uncovered` until the refusal stops meaning anything. So `*.md`,
`LICENSE`, and `NOTICE` are covered by construction. The list is deliberately narrow:
`scripts/`, `vitest.*.config.ts`, `turbo.json`, and `tooling/` are **not** inert.

One carve-out, and it is load-bearing: `packages/telemetry/src/docs-drift.test.ts` reads the
repo-root `docs/TELEMETRY.md`. Editing that doc can turn a real suite red, and no package
filter selects telemetry for it. So it is listed in `DOCS_READ_BY_TESTS` and keeps refusing.

That list would rot the moment another test starts reading a repo doc, so
`test-affected.test.ts` carries a drift guard that greps the suites for repo-root doc reads
and fails if one is unlisted. Confirmed non-vacuous — it finds `docs/TELEMETRY.md` today.

## Base ref

Resolved, never hardcoded — the merge base against the **closest** of: an explicit
`--base` / `PODIUM_TEST_BASE`, the configured upstream, `origin/main`, and
`origin/project/*`. Only `main` and `project/*` are candidates, so another agent's issue
branch can never become the base and move the fork point forward.

Closest-wins matters because agents work in worktrees cut from long-lived branches: a
worktree off `project/testing` must diff against that branch, not against `main`.
