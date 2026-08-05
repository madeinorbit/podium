# Running tests — which lane, when

Doctrine for agents working in this repo [spec:SP-0be7]. The suite is split into four
lanes so the default stays fast and hermetic, and nothing expensive (real processes,
real PTYs, real agent CLIs billing LLM quota) runs implicitly.

## The four lanes

| Lane | Command | What's in it | Cost |
| --- | --- | --- | --- |
| **Unit (default)** | `bun run test` (= `test:unit` + `test:web` + `test:bun:unit`) | Hermetic vitest suites (`vitest.unit.config.ts`), apps/web happy-dom tests, bun:sqlite runtime store. No real servers, PTYs, or agent binaries. Retries: 0 — a flaky unit test is a bug. | Target <1min |
| **Integration** | `bun run test:integration` | `vitest.integration.config.ts`: process/PTY/abduco/daemon suites, `*.integration.*`, `*.pty.test.ts`, real-port server boots, `tests/e2e/**`. Spawns real processes; resource flakes may retry here. | Minutes |
| **E2E** | `bun run test:e2e` | The 7 vitest files under `tests/e2e/**` (real server + daemon + abduco), via the integration config with the `@podium/source` condition. **No browser**: the Playwright suite has its own lane, below (POD-1227). | Minutes, heavy |
| **Browser** | `bun run test:browser` | The 70 Playwright suites `tests/e2e/browser/**.browser.e2e.ts` under their own `playwright.config.ts` (real Chromium + WebKit against the harness relay). Runs `scripts/browser-lane.ts`; quarantine is `scripts/browser-quarantine.ts`. In CI **non-blocking** while the red baseline is burned down — read the step output, never the checkmark. Census: [browser-lane-census.md](browser-lane-census.md). | Tens of minutes, heavy |
| **Agent smoke** | `bun run test:smoke:agents` | `vitest.agent-smoke.config.ts`: launches all five REAL agent CLIs (claude/codex/opencode/cursor/grok) when installed. Gated on `PODIUM_REAL_CLI=1`, which only the npm script sets — never set it yourself implicitly. **Bills real LLM quota.** | Real money |
| **Multi-instance** | `bun run test:multi-instance` | Acceptance lane for instance identity/state/endpoints/CLI routing/lifecycle ([docs/multi-instance.md](../multi-instance.md)): starts fully separate concurrent runtimes plus the installer suite. Do not substitute multiple clients routed to one server. | Minutes |

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

Bun-test files (`*.bun.test.ts`) run via `bun test`, never vitest; `bun run test:bun`
covers the full bun-test set (compiled daemon + lifecycle integration stay out of CI).

## Shared-host resource guard

The shared forked Vitest configuration defaults to at most two workers and keeps one worker available as the floor. This is the safe setting for the six-core, 11 GB development host so a test run leaves headroom for the live Podium instance and other agent sessions. Set `PODIUM_TEST_WORKERS=<positive integer>` to choose another ceiling, or `PODIUM_TEST_WORKERS=auto` to restore Vitest's CPU-count default on a dedicated CI/test host. `fileParallelism` remains enabled.

The root Vitest lanes (unit, integration, acceptance, E2E, and agent-smoke) and the cached web/mobile runner automatically acquire the test:heavy advisory lease when launched from a live Podium session. Other heavy commands, including browser or multi-instance lanes and direct package invocations, should acquire it before starting and release it immediately afterward:

    podium lock acquire test:heavy --ttl 30m --wait
    bun run test:integration
    podium lock release test:heavy

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
| Changed a web UI surface a `*.browser.e2e.ts` suite covers | Also `bun run test:browser` (scope it: `bun run test:browser -- --grep …`) — and do not cite a suite as runtime verification without re-running it |
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
  unit/integration/agent-smoke split and package.json script shape. If you add a test
  that spawns processes/PTYs/servers, name it so a lane pattern catches it
  (`*.integration.test.ts`, `*.pty.test.ts`, `*.smoke.test.ts`) or add it to the
  explicit lists in `vitest.integration.config.ts` (and its mirror exclusion in
  `vitest.unit.config.ts`).
- **Tmp hygiene**: never a bare `mkdtemp` without cleanup in tests. Per-run TMPDIR
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
