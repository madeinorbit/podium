# Running tests — which lane, when

Doctrine for agents working in this repo [spec:SP-0be7]. The normal path is one
cacheable package-owned default; the remaining lanes stay explicit because they start
real processes, browsers, PTYs, or agent CLIs that cannot be safely hidden in a unit cache.

## Default and explicit lanes

| Lane | Command | What's in it | Cost / guard |
| --- | --- | --- | --- |
| **Default package tests** | `bun run test` (`test:unit` is a compatibility alias) | 23 Turbo tasks covering all 998 default files: package Vitest suites, scripts, desktop, web/mobile, server normalized-wire, and the runtime Bun unit | Cached; tasks serial, Vitest capped at 2 workers |
| **Focused package probes** | `bun run test:web`, `bun run test:mobile`, `bun run test:cached` | One or both app package tasks | Cached; same install fingerprint |
| **Affected package tests** | `bun run test:affected` | Package tasks for changed packages and dependents | Refuses files no package task can cover |
| **Inner loop** | `bun run test:changed`, `test:related`, `test:watch` | Root `node` and `normalized-wire` projects selected by Vitest | Fast approximation; not a commit gate |
| **Integration** | `bun run test:integration` | `vitest.integration.config.ts` plus acceptance: process/PTY/abduco/daemon suites, real-port boots, and loop-split load | Minutes; shared test lease |
| **E2E** | `bun run test:e2e` | Full-stack server + daemon Vitest files under `tests/e2e/**` with `@podium/source` | Minutes; heavy; no browser |
| **Browser** | `bun run test:browser` | Playwright browser suites under `tests/e2e/browser/**.browser.e2e.ts` | Tens of minutes; heavy; see browser census. Scope one suite with `-- --suite <name>` (do not hand-roll `playwright test`) |
| **Agent smoke** | `bun run test:smoke:agents` | Five real agent CLIs, gated by `PODIUM_REAL_CLI=1` | Real money; explicit human request only |
| **Multi-instance** | `bun run test:multi-instance` | Separate concurrent runtimes plus installer coverage | Minutes; heavy; see [multi-instance.md](../multi-instance.md) |
| **Full Bun lane** | `bun run test:bun` | All `*.bun.test.ts` suites, including compiled-daemon/lifecycle integration | Heavy; `bun test`, never Vitest |

The default package task is the command to run before a commit. It keeps every default
test attributable to an owner and lets Turbo repeat only tasks whose inputs changed.
The root process lanes remain explicit so a green unit cache cannot imply a green server,
browser, multi-instance, or real-agent run.
`test:bun:unit` remains a compatibility probe for the runtime file; normal agents should use
`bun run test` so that file is not run twice.
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


## Shared-host resource guard

The shared forked Vitest configuration defaults to at most two workers and keeps one worker available as the floor. This is the safe setting for the six-core, 11 GB development host so a test run leaves headroom for the live Podium instance and other agent sessions. Set `PODIUM_TEST_WORKERS=<positive integer>` to choose another ceiling, or `PODIUM_TEST_WORKERS=auto` to restore Vitest's CPU-count default on a dedicated CI/test host. `fileParallelism` remains enabled.

The package default (`bun run test`) and `bun run test:affected` automatically acquire the
`test:heavy` advisory lease from a live Podium session. Root process lanes that call
`scripts/test-heavy.ts` do the same (`test:integration`, `test:acceptance`, `test:e2e`,
`test:smoke:agents`). `test:browser` / `scripts/browser-lane.ts` take the lease inside
the lane body so both the package script and a bare script invocation serialize.
Direct package and multi-instance commands do not; when an agent runs those by hand:

    podium lock acquire test:heavy --ttl 30m --wait
    bun run test:multi-instance
    podium lock release test:heavy

A hand-rolled Playwright invocation that bypasses the lane still skips the lease and
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

The wrapper renews the 30-minute lease every 10 minutes while the child runs. If renewal fails, it terminates the child rather than allowing an unleased test to continue; an interrupted process still has the 30-minute TTL as the recovery path.

Automatic lease acquisition is identity-gated on `PODIUM_SESSION_ID`. CI and other non-session runs retain the safe two-worker default but do not serialize against live sessions; a dedicated host can opt out explicitly with `PODIUM_TEST_WORKERS=auto bun run test`.

A human running `bun run test` in a terminal without `PODIUM_SESSION_ID` takes no automatic lease and can still collide with an agent run. On the shared host, acquire `test:heavy` manually first, or leave the default worker ceiling in place.

## Decision table

| Situation | Run |
| --- | --- |
| Iterating on changed source | `bun run test:changed` — Vitest's module graph selects tests reachable from the files changed since `HEAD` |
| Iterating on an explicit file list | `bun run test:related -- path/to/file.ts` — add more paths after `--` as needed |
| Repeating edits interactively | `bun run test:watch` — plain watch mode keeps the Vitest process warm |
| Before every commit | `bun run test` (fast default) |
| Touched agent-bridge / daemon / server process, PTY, or abduco code | Also `bun run test:integration` |
| Full-stack flows, before landing UI/server interaction work | `bun run test:e2e` |
| Touched instance identity, state roots, port derivation, CLI routing, agent ownership, or lifecycle | Also `bun run test:multi-instance` |
| Changed a web UI surface a `*.browser.e2e.ts` suite covers | Also `bun run test:browser` (scope it: `bun run test:browser -- --suite <stem>` or `-- --suite <stem> --project=chromium-pixel`) — and do not cite a suite as runtime verification without re-running it. Prefer the lane over a hand-rolled `playwright test` invocation: positional filters cannot narrow the full-lane argv, `--project` is variadic (use the `=` form), and piping through `tail`/`grep` masks Playwright's exit status |
| Real agent CLI behavior | `bun run test:smoke:agents` — ONLY on explicit human request |

Always invoke Vitest through the repo's direct Bun entry point (`bun --bun node_modules/vitest/vitest.mjs run ...`), never plain `vitest` and
never `bun test` for vitest files.

The three inner-loop scripts are deliberately a fast approximation, not a replacement
for the full suite. They run only the root unit projects (`node` and
`normalized-wire`); they do not cover the web/mobile, integration, acceptance, or
`bun:test` lanes. Vitest rebuilds its module graph for each invocation, so these scripts
do not provide CI caching. Module-graph selection also cannot discover tests that read a
changed file directly from disk rather than importing it. For example,
`packages/telemetry/src/docs-drift.test.ts` reads `docs/TELEMETRY.md` with
`readFileSync`, so changing only that doc can make `test:changed` pass with no selected
tests. This is a documented limit, not a detected dependency; target the reader with
`bun run test:related -- packages/telemetry/src/docs-drift.test.ts` when needed. Run
`bun run test` before a commit.

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
