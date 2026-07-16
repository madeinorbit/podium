# Running tests — which lane, when

Doctrine for agents working in this repo [spec:SP-0be7]. The suite is split into four
lanes so the default stays fast and hermetic, and nothing expensive (real processes,
real PTYs, real agent CLIs billing LLM quota) runs implicitly.

## The four lanes

| Lane | Command | What's in it | Cost |
| --- | --- | --- | --- |
| **Unit (default)** | `bun run test` (= `test:unit` + `test:web` + `test:bun:unit`) | Hermetic vitest suites (`vitest.unit.config.ts`), apps/web happy-dom tests, bun:sqlite runtime store. No real servers, PTYs, or agent binaries. Retries: 0 — a flaky unit test is a bug. | Target <1min |
| **Integration** | `bun run test:integration` | `vitest.integration.config.ts`: process/PTY/abduco/daemon suites, `*.integration.*`, `*.pty.test.ts`, real-port server boots, `tests/e2e/**`. Spawns real processes; resource flakes may retry here. | Minutes |
| **E2E** | `bun run test:e2e` | `tests/e2e/**` only (real server + daemon + abduco + Playwright), via the integration config. | Minutes, heavy |
| **Agent smoke** | `bun run test:smoke:agents` | `vitest.agent-smoke.config.ts`: launches REAL agent CLIs (claude/codex/opencode/cursor). Gated on `PODIUM_REAL_CLI=1`, which only the npm script sets — never set it yourself implicitly. **Bills real LLM quota.** | Real money |
| **Multi-instance** | `bun run test:multi-instance` | Acceptance lane for instance identity/state/endpoints/CLI routing/lifecycle ([docs/multi-instance.md](../multi-instance.md)): starts fully separate concurrent runtimes plus the installer suite. Do not substitute multiple clients routed to one server. | Minutes |

Bun-test files (`*.bun.test.ts`) run via `bun test`, never vitest; `bun run test:bun`
covers the full bun-test set (compiled daemon + lifecycle integration stay out of CI).

## Decision table

| Situation | Run |
| --- | --- |
| Iterating on one package/file | Scoped: `bun --bun vitest run <path> --config vitest.unit.config.ts` |
| Before every commit | `bun run test` (fast default) |
| Touched agent-bridge / daemon / server process, PTY, or abduco code | Also `bun run test:integration` |
| Full-stack flows, before landing UI/server interaction work | `bun run test:e2e` |
| Touched instance identity, state roots, port derivation, CLI routing, agent ownership, or lifecycle | Also `bun run test:multi-instance` |
| Real agent CLI behavior | `bun run test:smoke:agents` — ONLY on explicit human request |

Always run vitest under Bun (`bun --bun vitest run ...`), never plain `vitest` and
never `bun test` for vitest files.

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
- **CI runs the unit lane only** (installs with `--ignore-scripts`, so node-pty's
  native addon never exists there). Integration/e2e/smoke run locally, on request.
