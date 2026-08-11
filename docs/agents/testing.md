# Running tests — which lane, when

Doctrine for agents working in this repo [spec:SP-0be7]. Tests are end-of-task evidence,
not an editing ritual. Do not run tests after each edit or intermediate commit, and do not
accumulate overlapping lanes merely to say more commands were run.

## The normal agent path

At the end of an ordinary runtime-affecting task, run:

    bun run test:agent

This is the lean confidence gate. It runs four exact hermetic boot/configuration files with one
worker:

| Test file | What it cheaply protects |
| --- | --- |
| `packages/runtime/src/boot.test.ts` | Runtime boot/configuration assembly |
| `apps/server/src/router.setup.test.ts` | Server router construction and required wiring |
| `apps/daemon/src/connection-state.test.ts` | Daemon connection-state startup contract |
| `scripts/test-configuration.test.ts` | Lane membership, exclusions, hermetic setup, and the lean gate's own composition |

It does not run typecheck, the package sweep, repository rewrite audits, real processes, PTYs,
ports, browsers, performance probes, or agent CLIs. It deliberately does not enter the shared
validation queue: this bounded one-worker probe must not wait behind or delay heavyweight suites.
Docs, copy, fonts, formatting, and generated artifacts may skip it when they cannot affect
runtime; say so in the handoff.

Only add a specialized lane when the diff matches a trigger below. If that specialized lane
already proves the relevant basic wiring, use it instead of `test:agent`; otherwise run the
two commands once each, sequentially, at the end. “More confidence” without a concrete risk
is not a reason to add a lane.

## Exhaustive command and ownership map

### Lean, package, and selection lanes

| Command | Tests live in / selection rule | Also executed by | Run when |
| --- | --- | --- | --- |
| `bun run test:agent` | The four exact files above via the `node` project in `vitest.unit.config.ts` | No parent command; lock-free | Default end-of-task gate for ordinary runtime code |
| `bun run test` | Package-owned `*.test.*` / `*.spec.*` under `apps/*`, `packages/*`, and `scripts/*`; one Turbo `test` task per owner; server expands to five shards; exclusions come from `vitest.unit.config.ts` | `test:unit`; `oracle` as its `unit` component; CI `unit-tests` | Scheduled CI, merge batches, release validation, or explicit request—not ordinary agent work |
| `bun run test:unit` | Exactly the same command and scope as `test` | Alias only | Compatibility only; prefer `test` when a full sweep is intentionally required |
| `bun run test:web` | `apps/web/**/*.{test,spec}.*` through `apps/web/vitest.config.ts` | `test:cached`; full `test` | A broad web package change where a few exact tests cannot represent the risk |
| `bun run test:mobile` | `apps/mobile/**/*.{test,spec}.*` through `apps/mobile/vitest.config.ts` | `test:cached`; full `test` | A broad mobile package change |
| `bun run test:cached` | The web and mobile package tasks above | No parent command | A deliberately cross-client change; never as generic confidence |
| `bun run test:affected` | Turbo package tasks for changed package sources and dependents; root/process files are uncovered | No parent command | Optional package-wide checkpoint when the selected set is known to be useful; not a mandatory agent gate |
| `bun run test:related -- <files>` | Unit tests reachable in Vitest's import graph from the named files; root `node` and `normalized-wire` projects | No parent command | A regression needs exact unit evidence or the user explicitly asks for focused tests |
| `bun run test:changed` | Same projects, selected from files changed since `HEAD` | No parent command | Optional diagnosis only; do not run automatically after edits |
| `bun run test:watch` | Same projects in non-terminating watch mode, one worker | No parent command | Human-requested test-driven iteration only |
| `bun run test:bun:unit` | Exact file `packages/runtime/test/sqlite.bun.test.ts` using `bun:test` | Full `test`; `test:bun` | Focused runtime SQLite changes |

### Server package shards

The generated `apps/server/test-shards.json` is the authoritative file roster. Each shard is
independently Turbo-cached inside the server aggregate used by `bun run test`.

| Command | Tests live in / config | Also executed by | Run when |
| --- | --- | --- | --- |
| `bun run --cwd apps/server test:contracts` | Generated contracts roster; `apps/server/vitest.contracts.config.ts` | Server aggregate → full `test` | Request/response contracts, schemas, command parsing, validation |
| `bun run --cwd apps/server test:store` | Generated store roster; `apps/server/vitest.store.config.ts` | Server aggregate → full `test` | Database access, migrations, repositories, durable state |
| `bun run --cwd apps/server test:services` | Generated services roster; `apps/server/vitest.services.config.ts` | Server aggregate → full `test` | Server service logic without a real process boundary |
| `bun run --cwd apps/server test:boundary` | Generated boundary roster; `apps/server/vitest.boundary.config.ts` | Server aggregate → full `test` | Routers, auth boundaries, external-facing composition |
| `bun run --cwd apps/server test:normalized-wire` | Generated normalized-wire roster; `apps/server/vitest.normalized-wire.config.ts` | Server aggregate → full `test` | Normalized wire encoding and its bounded benchmark guard |
| `bun run --cwd apps/server test:unsharded` | Old whole-package configs | No parent command | Diagnose a suspected shard/configuration discrepancy only |

### Explicit process, browser, rewrite, and performance lanes

| Command | Tests live in / exact selection | Also executed by | Run when |
| --- | --- | --- | --- |
| `bun run test:integration` | Patterns and explicit files in `vitest.integration.config.ts`: `*.integration.*`, `*.pty.test.*`, process/daemon/server boot suites; then `test:acceptance` if Vitest is green | `oracle`; CI oracle matrix | Changed real process, PTY, abduco, daemon/server boot, updater process, or agent-bridge behavior |
| `bun run test:acceptance` | Exact file `scripts/loop-split-load.integration.test.ts` via `vitest.acceptance.config.ts` | Successful `test:integration` | Loop-split load scheduling or its acceptance threshold |
| `bun run test:acceptance:process` | Exact Bun file `scripts/loop-split-process.acceptance.bun.test.ts` | No parent command | Publication worker, user-systemd recovery, janitor/process recovery |
| `bun run test:e2e` | Non-browser `tests/e2e/**/*.test.{ts,tsx}` selected through `vitest.integration.config.ts` | `oracle`; CI oracle matrix | A changed full-stack server↔daemon↔client flow cannot be covered at one boundary |
| `bun run test:multi-instance` | Exact runtime file `scripts/multi-instance-runtime.integration.bun.test.ts`, exact managed-account file `scripts/managed-account-spawn.integration.test.ts`, and `scripts/install-sh.test.sh` | `oracle`; CI oracle matrix | Instance identity, state roots, ports, CLI routing, ownership, lifecycle, installer |
| `bun run test:browser -- --suite <stem>` | Named `tests/e2e/browser/<stem>.browser.e2e.ts` via `tests/e2e/playwright.config.ts` | Full browser command/CI project matrix | Only when the requested behavior requires a real browser interaction; scope to the changed surface |
| `bun run test:browser` | Every `tests/e2e/browser/*.browser.e2e.ts`, across requested Playwright projects | CI browser matrix (non-blocking) | Scheduled browser census or explicit full-browser request; never normal agent validation |
| `bun run test:bun` | `apps/daemon/test/**`, `packages/runtime/test/sqlite.bun.test.ts`, `scripts/lifecycle.integration.bun.test.ts` | No parent command | Bun-runner, compiled-daemon, worker isolation, or lifecycle changes |
| `bun run test:smoke:agents` | Real-agent files selected by `vitest.agent-smoke.config.ts` and `vitest.smoke-requirements.ts` | No parent; deliberately excluded from oracle | Only on explicit human request after changing real CLI adapters; spends credentials/quota |
| `bun run test:rearch` | Runs the `audit:rearch` baseline check, then exact file `scripts/rearch-audit.test.ts` via `scripts/vitest.rearch.config.ts` | No default/package parent | Only rewrite migration/audit implementation or baseline changes; never ordinary product work |
| `bun run test:perf:frontend` | Frontend large-state benchmark in `apps/web/vitest.frontend-perf.config.ts` | CI unit job | Large-state rendering/projection work or scheduled performance monitoring |
| `bun run test:perf:sync` | Sync scaling benchmark in `packages/sync/vitest.perf.config.ts` | No parent command | Explicit sync scaling investigation on a bounded/dedicated host; deliberately quadratic |
| `bun run perf:typing` | `tests/e2e/typing-latency-bench.ts` against a live environment | No parent command | Typing/terminal latency work only |
| `bun run oracle` | Sequential `typecheck`, full `test`, `test:integration`, `test:e2e`, `test:multi-instance` from `scripts/oracle.ts` | No parent command | Rewrite phase boundary, release candidate, or explicit request; never a normal merge gate |

Files named `*.bench.test.ts` are excluded from generic package-owned and root node-unit
collection. A dedicated project may explicitly re-add a bounded guard such as the server's
normalized-wire benchmark. A benchmark that intentionally amplifies a known cost curve is not
merge-gate evidence merely because Vitest can collect it; give it an explicit performance lane
with the host budget appropriate to its measured peak.
The agent-smoke reporter prints ran-versus-skipped totals for each CLI. A CLI's
viability case starts a real turn and resumes it with retained context; an
installed but unauthenticated or broken binary runs and fails rather than being
reported as absent. The lane also fails when all five viability cases skip, or
when any CLI loses its registered case. Runner operators must explicitly choose
which authenticated binaries to install; absence remains a visible per-CLI skip.

Keep model-output quality evaluations out of this release viability lane. The
former Claude brevity evaluation intermittently produced four sentences against
a three-sentence prose contract despite successful start, turn, and resume; that
is stochastic instruction compliance, not evidence that the CLI transport works.
The lexical response-contract behavior remains protected by deterministic tests.


## The `@podium/server` lane is generated — regenerate it when you add a test

`@podium/server`'s `test` task is an aggregate over five independently cached shards
(`contracts`, `store`, `services`, `boundary`, `normalized-wire`) [POD-520]. Shard
membership AND the per-file Turbo input globs are **derived from the real import
closure**, so `apps/server/test-shards.json` and `apps/server/turbo.json` are generated
files: never hand-edit them, and never coarsen the globs to directories (that costs most
of the cache benefit). After adding, moving, or deleting any `apps/server` test file:

    bun scripts/server-test-shards.ts --write

`scripts/server-test-shards.test.ts` recomputes both files on every default run and fails
on any difference — including the inverse check that no `apps/server` file can change
without some shard's key noticing. It fails as a plain array diff, so a red naming server
test paths means the `--write` above, not a broken test.

Iterating on one shard: `bun run --cwd apps/server test:contracts` (likewise `test:store`,
`test:services`, `test:boundary`, `test:normalized-wire`; `test:unsharded` runs the old
whole-package shape).

Two mechanisms underneath that lane change how a server test behaves:

- **Store tests clone a pre-migrated database** [POD-523]. A globalSetup builds one schema
  image keyed by the migration manifest and every store test clones it, so a changed
  migration is a lane-level input that invalidates all five shards, not just `store`.
- **The `contracts` shard reuses one Vitest runner** [POD-527]: `isolate: false` for the
  files a static scan clears, the rest still forked, and an after-file leak guard that
  fails the offending file by name with the global/env key that moved. A contracts failure
  naming a moved key is that guard, not a flake. Do **not** stress reuse with a whole-shard
  `--sequence.shuffle.files`: it replaces Vitest's project-first sequencer, breaks the reuse
  chain, and exercises reuse *less* than the default order. Shuffle the reused project alone
  (`--project server:contracts:reused --sequence.shuffle.files`).

Measurements and rationale: [POD-520 cache shards](pod-520-server-test-cache-shards.md),
[POD-523 pre-migrated store fixture](pod-523-pre-migrated-store-fixture.md),
[POD-527 runner reuse](pod-527-runner-reuse.md).

## Shared-host resource guard

The shared forked Vitest configuration defaults to at most two workers and keeps one worker available as the floor. This is the safe default for a shared development host, so a test run leaves headroom for the live Podium instance and other agent sessions. Set `PODIUM_TEST_WORKERS=<positive integer>` to choose another ceiling, or `PODIUM_TEST_WORKERS=auto` to restore Vitest's CPU-count default on a dedicated CI/test host. `fileParallelism` remains enabled.

Validation uses a two-permit host budget from a live Podium session:

- Heavy lanes reserve both permits and retain the `test:heavy` advisory lease for
  compatibility with older/manual callers. This includes the default package gate,
  affected, integration, acceptance, E2E, browser, agent smoke, multi-instance, and the
  full Bun lane.
- Focused one-shot tests reserve one permit, so two small probes can coexist when no heavy
  lane or typecheck is admitted. Root changed/related and focused web/mobile/cached entry
  points use this tier, as do direct package test scripts.
- Typecheck reserves both permits because Turbo can run many `tsgo` children. Root and
  direct package typecheck scripts use this tier, so it does not overlap focused tests.
- Watch reserves one permit, forces `PODIUM_TEST_WORKERS=1`, and holds a singleton
  `validation:watch` lease. A second watcher is refused; one focused probe can still use
  the remaining permit.

A short `validation:admission` gate prevents a new focused probe from slipping ahead while
a heavy lane or typecheck is draining the permits. Lock notes name the command, so
`podium lock status` shows which validation is admitted and the admission-gate holder names
the work waiting for capacity. The gate and every partially acquired permit renew while
admission is blocked; timeout, interruption, and errors cancel the active waiter and release
partial acquisition in reverse order. Runtime leases renew while the child runs, and every
path releases only locks that invocation opened.

Root wrappers export `PODIUM_VALIDATION_RESOURCE_HELD`; Turbo passes it to package children
through `globalPassThroughEnv`, so direct package scripts self-guard without nested
acquisition or changing cache keys. An outer manually-held `test:heavy` remains caller-owned.

`acquire` refuses when a **sibling** — another session on your issue, or any session sharing
your worktree — already holds or is queued for that lock [POD-556]. That is the shared-root
checkout's normal case, and the refusal names the session so you can coordinate; pass
`--allow-sibling` only when serialized multi-session access is genuinely what you want.
Re-acquiring your own held lock renews it rather than queueing.

A hand-rolled Vitest or Playwright invocation that bypasses package scripts still skips admission and
will race other heavy work — and it shares the fixed default port 8799 with any other
Playwright run on the host (lease does not cover that). Prefer the package script when
you can. One-suite verification belongs on the lane (POD-536) so build, selection,
and exit status stay correct:

    bun run test:browser -- --suite <stem> --project=chromium-pixel

If you must bypass the lane, build first so webServer does not start against empty
dist (POD-535):

    bun scripts/browser-lane.ts --build-only
    bunx playwright test --config tests/e2e/playwright.config.ts --project=chromium-pixel <suite>

Use the equals form of `--project` (space form swallows the next arg). If dist is
missing, webServer fails fast with that build-only command rather than a deep
module-not-found.

The wrapper renews each 30-minute lease every 10 minutes while the child runs. If renewal
fails, it terminates the child rather than allowing an unbudgeted test to continue; an
interrupted process still has the 30-minute TTL as the recovery path.

Automatic lease acquisition is identity-gated on `PODIUM_SESSION_ID`. CI and other non-session runs retain the safe two-worker default but do not serialize against live sessions; a dedicated host can opt out explicitly with `PODIUM_TEST_WORKERS=auto bun run test`.

A human running validation in a terminal without `PODIUM_SESSION_ID` takes no automatic
budget lease and can still collide with an agent run. On the shared host, run validation
from a Podium session or coordinate a manual `test:heavy` hold for a heavy command.

### One lane at a time, inside your own session

Admission bounds work **across** sessions. It does not authorize overlapping validation
inside one session: the explicit marker exists for parent/child re-entry, and a same-session
acquire without that marker is refused when the wrapper can identify it. Hand-rolled
commands can still bypass the contract entirely.

Ordering is still yours to enforce. Run only the end-of-task gate selected above and, when a
concrete risk requires it, its one specialized lane—**one after another, each to completion**.
Do not background a lane and start the next (`&`, a second terminal, parallel tool calls), and
do not overlap typecheck with a test run.

Overlapping does not finish sooner on a host shared with a live Podium instance and every
other agent session; it multiplies the peak. The worker ceiling and the `test:heavy` lease
were both sized on the assumption that one session contributes one heavy run at a time, and
a CPU-starved run fails in timeout shapes that read like real regressions — costing a second
full run to disprove.

Never run two heavy things concurrently to save time. If a second heavy run genuinely has to
happen, submit it from another session and let `test:heavy` serialize it — it waits for the
lease and starts when the host is free, which is the outcome you wanted anyway.

## Selection caveats

`test:changed` and `test:related` are optional diagnostic tools, not required workflow steps.
They see only Vitest's import graph in the root `node` and `normalized-wire` projects; they do
not cover web/mobile package configs, process lanes, browser tests, or `bun:test`. They also
cannot discover a filesystem read. For example, changing `docs/TELEMETRY.md` does not select
`packages/telemetry/src/docs-drift.test.ts`; explicitly name that reader if its contract is the
thing being changed.

`test:affected` uses package ownership. It refuses uncovered runtime files rather than pretending
they are green, but that refusal is guidance to choose the relevant explicit lane—not an
instruction to run the full sweep. Inert prose such as ordinary Markdown, `LICENSE`, and `NOTICE`
is ignored. Its base is the closest merge base among the upstream, `origin/main`, and
`origin/project/*`; override with `--base=<ref>` when necessary.

Always invoke Vitest through repository scripts. A hand-rolled invocation bypasses admission,
hermetic setup, lane exclusions, and exit-status safeguards.

## Invariants

- **Lane membership is guarded**: `scripts/test-configuration.test.ts` asserts the
  package-owned scopes, normalized-wire serialization, hermetic setup, worker caps,
  heavy-lane split, and package.json script shape. Every new package test needs a real
  config and matching Turbo task/input audit. If you add a test that spawns processes/PTYs/servers, name it so a lane pattern catches it
  (`*.integration.test.ts`, `*.pty.test.ts`, `*.smoke.test.ts`) or add it to the
  explicit lists in `vitest.integration.config.ts` (and its mirror exclusion in
  `vitest.unit.config.ts`).
- **Tmp hygiene**: never a bare `mkdtemp` without cleanup in tests. Per-run TMPDIR
- **Root exclusions remain load-bearing**: `vitest.unit.config.ts` still excludes
  integration/e2e/PTY/agent-smoke and named heavy suites, while normalized-wire remains
  a separate serialized project; package configs reuse that exclusion list.
  containment exists (`test-hermetic-env.ts`) but it is a backstop, not a license —
  pair every `mkdtempSync` with `rmSync(..., { recursive: true, force: true })` in
  an afterAll/finally.
- **Tests never inherit the hosting instance**: `test-hermetic-env.ts` scrubs the
  session relay vars AND the instance-identity vars (`PODIUM_INSTANCE`, port/agent-home
  overrides), so a suite launched from inside a live (possibly named) instance runs as a
  hermetic throwaway. For a live-like isolated deployment, use a named instance
  ([docs/multi-instance.md](../multi-instance.md)) instead of hand-rolled
  `PODIUM_PORT`/`PODIUM_STATE_DIR` overrides.
- **CI runs the oracle: unit + typecheck + integration + e2e + multi-instance**
  [POD-295]. The light jobs (lint/typecheck/migrations/unit) install with
  `--ignore-scripts`, so node-pty's native addon never exists there; the `oracle`
  matrix job is the exception — it installs fully and adds abduco, because its
  lanes spawn real PTYs. Agent-smoke is NEVER in CI (it bills real LLM quota) and
  runs only on explicit request.
- **The oracle is the rewrite's behavioral contract** [POD-295]: `bun run oracle`
  runs all five lanes locally in one command (sequentially — the heavy lanes bind
  fixed ports). The lane set lives in `scripts/oracle.ts`; a drift guard in
  `scripts/test-configuration.test.ts` pins it against the CI matrix and the
  package.json scripts, so a lane cannot fall out of CI silently. Land-flow
  convention: acquiring the merge lock for main wants a green oracle on the
  candidate sha (see docs/rearchitecture-v3.md) — advisory, with CI as backstop.
