# POD-1687 — cached web/mobile test lanes: evidence

All measured in the issue worktree on `flatblock`, turbo 2.10.5.

## The win

| Scenario | Result | Time |
| --- | --- | --- |
| Cold (nothing cached) | 2 successful, **0 cached** | **2m33s** |
| Re-run, no edits | 2 successful, **2 cached** `>>> FULL TURBO` | **302ms** |
| Edit unrelated package (`services/telemetry-relay/src/index.ts`) | 2 successful, **2 cached** `>>> FULL TURBO` | **249ms** |
| Edit a covered file (`apps/web/src/components/GitStamp.tsx`) | 2 successful, **1 cached** — web really re-ran, mobile stayed hot | 4m17s |

That is the deliverable: an unrelated edit skips both suites entirely, and a
covered edit re-runs only the lane that is actually affected.

### Caveat on "green": the web suite flakes under host load

The cold run above was green (207 files, 1661 tests). A later full run on a
**loaded** host was not: 4 failed / 203 passed, and 5m54s instead of 2m33s — a
~2.3x slowdown from concurrent work on the same machine.

Those four are **not** broken components, and not caused by this change:

- every one failed with `Test timed out in 5000ms` — **zero** assertion failures;
- all four pass in isolation (`4 passed, 19 tests`);
- this branch's diff versus `main` touches no test source at all — only
  `turbo.json`, `package.json`, `apps/web/package.json` (+1 line), `scripts/test.ts`
  and docs.

Root cause: the root `vitest.config.ts` sets `testTimeout: 20_000`, but
`apps/web/vitest.config.ts` is a standalone `defineConfig()` that inherits nothing,
so the web suite runs at vitest's **5000ms default** — 4x less headroom than every
other suite in the repo. Filed as POD-1694.

**A cached green from this lane is only as good as the run that produced it.** If
you cache a green from an unloaded host, that is real; a red under load is most
likely this timeout gap, so check the failure mode before believing it.

## The correctness work, which was the harder half

`$TURBO_DEFAULT$` alone would have shipped a **wrong green**. Both suites reach
outside their own package:

- `apps/web/test/shell.structure.test.ts` reads `packages/client-core/src` off disk.
- Both suites import ~6–12 `@podium/*` packages as **source**, via the
  `@podium/source` export condition.

`dependsOn: ["^test"]` does *not* carry that content into the hash — dependency
content reaches a task only through a dependency *task hash*, and the task is
pinned, so those tasks do not exist. The overrides therefore declare the sources
as explicit `$TURBO_ROOT$` inputs.

Proven rather than assumed, via `turbo run test --filter @podium/web --dry=json`:

```
touch packages/client-core/src/index.ts
  hash before  c27a575eafbb0d04
  hash after   ab21502734197ad0   -> MISS, correct
```

Without the `$TURBO_ROOT$` input that edit was a silent HIT.

## The POD-1343 hazard: a cached green in a broken environment

`scripts/test.ts` **imports** `fingerprint()` / `readCensus()` / `decideForce()`
from `scripts/typecheck.ts` rather than copying them, so the two entry points
cannot drift apart.

```
PODIUM_CHECK_ENV_HASH=envA -> 81eab0c58615a116
PODIUM_CHECK_ENV_HASH=envB -> bbb4ed1e8ef3064b     env drift IS a miss
```

```
$ mv node_modules/@podium /tmp/stash && bun run test:web
test refused: node_modules/@podium has no usable workspace links — this checkout
is not installed, and a cached green here would not be evidence (POD-1343).

$ bun run test:web -- --force
uncached test run refused.
```

Not hypothetical: **this worktree had no `node_modules` at all** when the issue
started. That guard is the only thing standing between that state and a
confident, meaningless green.

## What "vetted" means here — and what it does not

`apps/web` and `apps/mobile` were vetted for **cache-key correctness**: every file
the suite reads or imports is covered by the task's inputs, so a green cannot
survive a change it should have noticed. That is the claim the evidence above
supports, and it is the claim this issue set out to make.

It is **not** a claim that these two suites are hermetic. They are not:

| Guard | Root lane | `apps/web` / `apps/mobile` |
| --- | --- | --- |
| `setupFiles` — `test-hermetic-env.ts`, `test-hermetic-vitest-hooks.ts` (POD-555: strips ambient Podium session env so a suite cannot reach the **live instance**) | applied | **not applied** — both report `setup 0ms` |
| `testTimeout: 20_000` | applied | **not applied** — vitest default 5000ms |

Both app configs are standalone `defineConfig()` calls that inherit nothing from
the root. This is **pre-existing, not introduced by caching**: `nodeTestExclude`
carves `apps/web/**` and `apps/mobile/**` out of the root sweep, so these suites
have always run under their own config. Caching changes how often they run, not
what they run under. Filed as POD-1694; it is the web/mobile half of POD-1693's
root cause, where a config exists but does not inherit.

## What is deliberately NOT cached

The task is **pinned**: there is no generic `test` entry, only
`@podium/web#test` and `@podium/mobile#test`. Because turbo runs only defined
tasks, `turbo run test` resolves to exactly those two — verified both bare and
under `--filter='...[HEAD~1]'`, the form POD-1688's affected-only selection uses.

About twenty other packages define a bare `vitest run --passWithNoTests`. Run
from the package directory vitest does not walk up, so it finds **no config**:

- no `resolve.conditions: ['@podium/source']` — `@podium/model#test` fails
  outright on a clean install (confirmed independently by POD-1688 for
  `packages/telemetry`);
- no `setupFiles`, so `test-hermetic-env.ts` / `test-hermetic-vitest-hooks.ts`
  never run. That is the POD-555 guard stripping ambient Podium session env so a
  suite cannot touch the **live instance**.

Most pass by luck, not scoping.

**This is not "those packages are untested."** They *are* tested today, by the
root `test:unit` lane: `vitest.config.ts` sets no custom `include`, so the sweep
runs from the repo root over `**/*.test.ts`, and `nodeTestExclude` carves out
`apps/web/**` and `apps/mobile/**` but not `packages/**`. Those suites run there
*with* the hermetic guards applied. What they lack is a per-package task, not
coverage — and the hazard is precisely that running them **per-package** silently
drops a guard the root lane supplies.

So they stay out until POD-1693 gives each package a real config — pinned rather
than merely `cache: false`, because an unguarded suite that can reach the live
instance should not run from this task at all. The ordering matters: a package
joins the `test` task only *after* it has a real vitest config, never before.
