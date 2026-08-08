# AGENTS.md

Guidance for AI agents working in this repository.

## Verifying UI / interaction changes

Automated tests, build, and review do not replace runtime verification for changed
UI/interaction behavior (clickable elements, terminal link clicks, editor open/save).
Before calling such work done, drive the real app and observe the behavior (a real
click, a real new tab, the file actually changing on disk).

See **[docs/agents/driving-podium.md](docs/agents/driving-podium.md)** for how to drive
Podium with Playwright — the `?e2e=1` test API, navigating the current DOM, reading
terminal output, clicking terminal cells, and the harness vs. the live instance.

## Testing independent instances

When changing instance identity, state, endpoints, CLI routing, agent ownership, or lifecycle
behavior, follow **[docs/multi-instance.md](docs/multi-instance.md)** and run
`bun run test:multi-instance`. The acceptance lane starts fully separate concurrent runtimes;
do not substitute multiple clients routed to one server.

## Issue tracking with Podium

This project uses Podium's issue tracker for work management. If you are running inside a Podium
session, use the `podium issue` CLI (start with `podium issue prime`). Track durable/discovered
work as issues, not markdown TODO lists. Full guide: **[docs/agents/podium-issues.md](docs/agents/podium-issues.md)**.

### Landing on main

Hard procedure — not a preference. Under the merge lock, refresh **local `main`**, rebase the
**issue branch** onto it, `git merge --ff-only` the issue tip into local main, push, release.
**Never** cherry-pick onto main or push a temp tip: that leaves a closed issue “ready to merge”
in the sidebar forever. Done when the issue tip is an ancestor of `origin/main`
(`git merge-base --is-ancestor <issue-tip> origin/main`, or `gitState.merged`) — not merely
when `gitState.ahead` is 0 (ahead is measured against `parentBranch`, which can be a dead
sibling for stacked issues). Full write-up:
**[docs/agents/podium-issues.md § Landing on main](docs/agents/podium-issues.md#landing-on-main)**
(prime text: `MERGE_LANDING_RULE` in `@podium/protocol`).

## Delegating to other agents

`podium agent spawn` puts another agent on an issue. Podium infers nothing about a delegate —
no roles, no write-claim, no auto-isolation [spec:SP-4ef9] — so what you tell it in the spawn
prompt is the only lever: its job, a title to give itself, who else is on the issue, and who
owns which files. Full guide: **[docs/agents/delegating.md](docs/agents/delegating.md)**.

## Cached checks

Run `bun run typecheck` and trust a cache hit. Never force a recompute: a forced run
costs ~3m14s of CPU against ~2s cached (110x, measured on 22 packages) on a host
shared with a live Podium instance. The cache key covers source files, `bun.lock`,
`package.json`, `tooling/tsconfig`, and — via `scripts/typecheck.ts`'s environment
fingerprint (`PODIUM_CHECK_ENV_HASH` in `turbo.json` `globalEnv`) — `bunfig.toml`
and the `node_modules/@podium` link census. Installs, linker changes, and git base
swaps therefore invalidate the cache by themselves; you do not need `--force` after
a merge. A checkout with no usable `node_modules/@podium` links is refused outright
(a cached green there is not evidence — POD-1343).

If you have a concrete reason to believe the cache is wrong, state it:

```
bun run typecheck -- --uncached-because="<what the cache key is missing>"
```

and file the gap as an issue so the key gets fixed. Bare `--force` and `TURBO_FORCE`
exit with an error.

### Cached package test lanes

`bun run test` is the default. It enters `scripts/test.ts`, which runs the 28
package-owned `test` tasks through Turbo with task concurrency set to one.

| Lane | Scope | Cache / safety |
| --- | --- | --- |
| `bun run test` | all 28 package tasks: one per package with tests (scripts, desktop, web/mobile, the runtime Bun unit) plus `@podium/server`'s aggregate and its five cache shards | Turbo-cached; package tasks run one at a time |
| `bun run test:unit` | compatibility alias for the default command | same |
| `bun run test:web`, `test:mobile`, `test:cached` | focused cached app probes | Turbo-cached |
| `bun run test:affected` | changed package tasks and their dependents | refuses files no package task can cover |

Every package task inherits the shared `@podium/source` resolution, hermetic setup
files, two-worker ceiling, retry policy, and unit exclusion list. The runtime task owns
the focused `*.bun.test.ts` unit file instead of invoking it from a root sweep.

`@podium/server` is the one package whose task is an aggregate: five independently cached
shards (`contracts`, `store`, `services`, `boundary`, `normalized-wire`) whose membership
and file-level Turbo inputs are **generated** from the import closure. `apps/server/test-shards.json`
and `apps/server/turbo.json` are not hand-editable; re-run `bun scripts/server-test-shards.ts --write`
after adding, moving, or deleting an `apps/server` test file, or the drift guard in the
default lane fails. The `contracts` shard also reuses one Vitest runner across the files a
static scan clears — see **[docs/agents/testing.md](docs/agents/testing.md)** before adding
or debugging a server test.

All commands pass through the install fingerprint (`PODIUM_CHECK_ENV_HASH`) and the
same missing-link refusal as typecheck. Bare `--force`/`TURBO_FORCE` is rejected;
use `-- --uncached-because="<reason>"` only when a cache-key gap is understood and
filed.

Tell a hit from a miss by Turbo's summary line:

```
Cached:    28 cached, 28 total          Time:   ... >>> FULL TURBO   <- hit, nothing ran
Cached:    27 cached, 28 total          Time:   ...                  <- one task executed
```

`>>> FULL TURBO` means no task executed. The cache key is honest: every task includes its
package files plus the shared configs, hermetic hooks, lockfile, and install fingerprint;
web/mobile include source-imported workspace packages, while scripts includes the repository
trees its architecture/configuration audits read. `dependsOn: ["^test"]` does not carry source
content into a task whose dependency has no test task, so those inputs are explicit.

The 28-task graph is deliberate. `@podium/terminal-client-react` has no test files and no
task; every default test file has a package owner and a real config/task. Adding another
package requires the same config, hermetic setup, exclusion, and Turbo-input audit.

Evidence for the cache-key coverage table: **[docs/agents/pod-1378-cache-evidence.md](docs/agents/pod-1378-cache-evidence.md)**.

## Affected-only tests

`bun run test:affected` runs the `test` turbo task filtered to the packages your change
actually touches — the ones whose sources changed, plus every package that depends on them.

**Today that means all 28 package test tasks.** The graph includes scripts, desktop,
web/mobile, the five `@podium/server` shards behind their aggregate, and the runtime Bun
unit file. It reads the
task graph rather than package.json, so a package task is selected for changed package
sources and for every package that depends on them.

**This is a fast inner-loop approximation. It does not replace `bun run test` before a
commit.** It cannot scope the root-level lanes that start real processes or external tools:

- `test:integration` — real processes, PTYs, server boots
- `test:acceptance` — loop-split load suite
- `test:e2e` — full-stack server/daemon suites
- `test:browser` — Playwright browser suites
- `test:multi-instance` — separate concurrent runtimes
- `test:smoke:agents` — real agent CLIs and LLM quota

Because those lanes are invisible to a package filter, the entry point **refuses to run
rather than print a green it did not earn**: if any changed file is not in a package turbo
can actually run `test` for, it exits 1, names the file and the reason, and tells you to
run `bun run test`. Use `--allow-uncovered` only once you have run the full lane yourself.

Every default unit/Bun file is now owned by a package task. Root integration, acceptance,
browser, multi-instance, and agent-smoke files remain explicit opt-in lanes and are listed
as uncovered by design when `test:affected` sees them.

Inert files — `*.md`, `LICENSE`, `NOTICE` — do not trigger the refusal, since prose cannot
change a test outcome. The exception is a doc a test actually reads: `docs/TELEMETRY.md`
is asserted against `packages/telemetry/src/docs-drift.test.ts`, so editing it still
refuses. If you add a test that reads a repo-root doc, the drift guard in
`scripts/test-affected.test.ts` will fail and tell you to list it in `DOCS_READ_BY_TESTS`.

The base is resolved, never hardcoded: the merge base against the *closest* of your
upstream, `origin/main`, and `origin/project/*`. Worktrees cut from a long-lived project
branch therefore diff against that branch, not against main. Override when needed:

```
bun run test:affected -- --base=<ref>     # or PODIUM_TEST_BASE=<ref>
```

Uncommitted and untracked changes count, and a checkout with no usable
`node_modules/@podium` links is refused for the same reason `typecheck` refuses it.
Note that editing `turbo.json` or anything in `globalDependencies` selects every package
task in the graph — safe, but you get no speedup on such a branch.

Measured selection sets: **[docs/agents/pod-1688-affected-evidence.md](docs/agents/pod-1688-affected-evidence.md)**.

## Vitest inner loop

For a quick edit-run loop, use the root Vitest scripts:

- `bun run test:changed` runs the Vitest unit tests reachable from files changed since `HEAD`.
- `bun run test:related -- path/to/file.ts` runs tests reachable from an explicit file list; pass more paths after `--` when needed.
- `bun run test:watch` keeps the unit projects warm in plain watch mode for repeated edits.

These scripts use the root Vitest config and its `node`/`normalized-wire` projects as a fast inner loop. They do not replace the package-owned default lane: Vitest rebuilds its module graph for each invocation, and module-graph selection cannot see tests that consume files through filesystem reads instead of imports. For example, changing `docs/TELEMETRY.md` does not select `packages/telemetry/src/docs-drift.test.ts`, which reads that file with `readFileSync`; `test:changed` can therefore pass with zero selected tests for that edit. This is a documented limit, not a detected dependency: target the reader explicitly with `bun run test:related -- packages/telemetry/src/docs-drift.test.ts` when needed. This lane does **not** replace `bun run test` before a commit; the full suite is still required before committing.
`test:affected` takes the opposite posture—refusing with exit 1 when a changed file is invisible to its package task graph—because this inner loop deliberately keeps zero-test green useful for ordinary docs/inert edits and leaves `bun run test` as the commit gate.

## Testing policy

Match testing effort to regression risk. Simple, low-risk changes may skip automated tests when
they do not alter runtime behavior, are fully mechanical, or are already protected by existing
coverage; state the reason in the handoff. Do not test trivial wiring, static types, framework
contracts, or assertions already covered at another layer.

When coverage is warranted, write the smallest focused set that protects the changed behavior.
Prefer extending existing tests or adding table-driven cases over creating parallel suites. Run
`bun run test` before commits containing substantive code changes; docs, copy, formatting, and
other test-independent edits may skip it. Add integration, E2E, multi-instance, or agent-smoke
lanes only when the change matches the decision table in
**[docs/agents/testing.md](docs/agents/testing.md)**. Do not create or run long, complex E2E flows
for small or local changes; reserve them for critical cross-boundary behavior or regressions that
require the real stack. Real-agent smoke tests require an explicit human request. Changed
UI/interaction behavior still requires runtime verification.

## Reference docs for agents

- [docs/multi-instance.md](docs/multi-instance.md) — operate and test fully independent instances on one machine.
- [docs/agents/driving-podium.md](docs/agents/driving-podium.md) — drive the Podium UI with Playwright to verify features at runtime.
- [docs/agents/agent-state-classification.md](docs/agents/agent-state-classification.md) — how agent run-state is classified from transcripts.
- [docs/agents/podium-issues.md](docs/agents/podium-issues.md) — use the `podium issue` CLI to track work from inside a session.
- [docs/agents/delegating.md](docs/agents/delegating.md) — spawn other agents: placement, naming, concurrency, advisory locks.
- [docs/agents/testing.md](docs/agents/testing.md) — every test lane, which one to run when, the generated `@podium/server` shards, and the shared-host `test:heavy` lease.
