# Vitest under the Bun runtime (POD-552)

Spec: **SP-3f93** · Unblocks: **#499 / SP-4428** (drizzle-kit adoption)

## Goal

Run the vitest **unit** suite under the **Bun** runtime instead of Node, so a single
SQLite driver (`bun:sqlite`) is exercised in both tests and the `bun --compile`
binary. Keep the vitest framework and keep coverage/behavior identical.

## Why not `bun test`

454 root vitest files + 120 web files vs 11 `bun test` files. Migrating the framework
would be enormous churn against "keep behavior identical". Running vitest *under* Bun
flips `openDatabase()` to `bun:sqlite` automatically via the existing `isBunRuntime()`
check — no test rewrites for the driver.

## The core blocker (validated) and the chosen fix

Under Bun, `import { z } from 'zod'` (and any named import from a CJS dep) resolved to
`undefined`. Root cause: vitest 4.1.8's CJS interop (`module-evaluator.js:342`) does
`'__esModule' in mod`, which is `true` under Bun even for CommonJS (Bun defines
`__esModule` present-but-`undefined`), so it wrongly unwraps to `.default` and drops the
named export. This is upstream **vitest#10359**, fixed by **PR #10363** (a truthy
`mod.__esModule` check) — landed only in **vitest 5.0.0-beta.3**.

**Decision (user-approved):** upgrade `vitest 4.1.8 → 5.0.0-beta.6` across the 9 workspace
package.json files, rather than carry a local patch. Vite 8 (v5's peer) is already present.

Also: the vitest `threads` pool is broken under Bun; use `forks`/default.

## Runner / invocation

`bun run <script>` respects vitest's `#!/usr/bin/env node` shebang and runs it on Node.
The `--bun` flag forces the Bun runtime. So scripts change from `vitest run …` to
`bun --bun vitest run …`, and CI invokes the same.

## Empirical baseline (methodology)

Ran the identical non-web unit scope under both runtimes to isolate Bun-only regressions:

| Runtime | Files failed | Notes |
|---|---|---|
| Node (baseline) | 4 | pre-existing: 3 CLI-subprocess tests need a built dist; 1 static-data mismatch (`issue-authz`) |
| Bun (vitest 5-beta) | 14 | the 4 above + **10 Bun-only** |

The 4 Node-baseline failures are **not** caused by this work and are out of scope
(fresh-worktree/build + a pre-existing registry-classification mismatch).

## Bun-only regressions — 3 categories, all with clean fixes

**1. node:sqlite fixture builders (6 failing + 3 that silently skip).** Tests hand-build
old-schema DB fixtures via `node:sqlite`'s `DatabaseSync`, which doesn't exist under Bun.
Fix: seed via the repo's runtime-agnostic `openDatabase()` (its `SqlDatabase` interface —
`exec` / `prepare().run|get|all` / `close` — is a near drop-in). SQLite files are
driver-agnostic on disk, so fixtures remain valid for whatever reads them. Also removes
the guarded `try { await import('node:sqlite') } catch { skip }` fallbacks so those tests
actually run (preserving coverage) instead of skipping under Bun.
Files: `apps/server/src/store.test.ts`, `apps/server/src/store.machines.test.ts`,
`packages/agent-bridge/src/discovery/providers/{codex,codex-state,opencode}.test.ts`,
`packages/agent-bridge/src/agent-state/codex.test.ts`; plus un-skip the guarded ones in
`transcript-source.test.ts` and `agent-state/opencode.test.ts`.

**2. Runtime-conditional PTY-backend tests (1 file, 3 tests).**
`packages/agent-bridge/src/pty/index.test.ts` asserts "under Node: picks node-pty,
`isUnderBun()===false`". Under Bun those premises invert. Fix: make the assertions
runtime-aware (assert `bun-terminal` / `isUnderBun()===true` when running under Bun),
preserving the real coverage of the path the code actually takes.

**3. `ws` handshake-rejection tests (3 files).** Tests detect a rejected WS handshake only
via `ws.on('unexpected-response')`, which Bun's `ws` emulation never emits, so they hang
to a hook timeout. Prod already handles this (`daemon.ts:732`: under Bun a rejected
handshake surfaces as `'error'` → `'close'`). Fix: mirror prod — resolve "rejected" on
`'error'`/`'close'` too. Files: `apps/server/src/wsServer.client-auth.test.ts`,
`apps/server/src/wsServer.version-gate.test.ts`, `apps/daemon/src/connectivity-state.test.ts`.

## Config / CI changes

- `package.json` scripts: `test`, `test:unit` → run vitest via `bun --bun`.
- `vitest.config.ts`: set `pool: 'forks'` for the node project (threads is broken under Bun);
  keep the existing aliases/conditions.
- `.github/workflows/ci.yml`: the `unit-tests` job's root vitest step runs under Bun. The
  `bun test` steps (`test:bun:unit`) stay as-is (they directly test the bun:sqlite adapter).
- apps/web (happy-dom) scope: evaluate running under Bun too; if happy-dom+RTL under Bun is
  problematic, keep web on Node for now and record as deferred (it touches no sqlite).

## Acceptance

Full unit suite under Bun shows **no failures beyond the 4 pre-existing Node-baseline
failures** (ideally we also fix/quarantine those or confirm they're environmental). CI green.

## Out of scope

The drizzle applier change itself (#499). Prod `ws` `unexpected-response`/self-update
wiring under Bun (already tracked as #106). The pre-existing Node-baseline failures.
