# Handoff: bring multi-machine onto Bun `main` (rebase-or-reimplement)

> Self-contained brief for an independent agent. You have NO prior context — everything you need is here. Deliver a branch + a report; a reviewer will inspect it afterward to decide whether to build on it.

## Your goal

Podium has a **multi-machine** feature (one server orchestrates agents across N machines; pairing; per-machine routing; a Machines UI) that was fully implemented on a branch **before** a big "Bun migration" landed on `main`. Bring that feature onto **current `main`**, green and verified. **Try a compatible rebase first; if the rebase is too tangled, re-implement on current `main` instead — re-implementing is explicitly fine and is the expected likely outcome.** Use the old branch's design+plan as the spec and its code as a per-file reference.

Repo: `/home/user/src/other/podium` (a Bun-workspace monorepo). `main` is `dbebf32` (moves over time — rebase onto whatever `main` is when you start).

## Where the prior work is

- **Implementation branch:** `worktree-multi-machine-agents-impl` (tip `e897e60`) — the real implementation, **54 files, +4931/−362**, branched from `6dcfdcf` (which is PRE-Bun-migration).
- **Docs branch:** `worktree-multi-machine-agents` (`bbc3485`) — design+plan docs only.
- **The spec (read these first):**
  - `git show worktree-multi-machine-agents-impl:docs/superpowers/specs/2026-06-17-multi-machine-agents-design.md`
  - `git show worktree-multi-machine-agents-impl:docs/superpowers/plans/2026-06-17-multi-machine-agents.md`
- Inspect any branch file with `git show worktree-multi-machine-agents-impl:<path>`.

## What the feature delivers (from the design doc)

- **Stable `machineId`** (UUID, persisted in `~/.podium/daemon.json`) per daemon; hostname is display-only.
- **Pairing flow:** a new daemon sends `pair{code, machineId, hostname}` with a one-time code → server mints a token → daemon saves it → future boots send `hello{machineId, token, hostname}`. The **in-process local daemon** gets a server-minted **bootstrap token** and skips the pairing code.
- **DB v4 migration:** a `machines` table (`id` PK, name, hostname, token_hash, created_at, last_seen_at); `machine_id` columns on `sessions`/`conversations`/`repos`; `repos` re-keyed to `PRIMARY KEY (machine_id, path)` + `origin_url`. Existing rows stamped `'__local__'`; the first bootstrap daemon rewrites them to its real `machineId`.
- **Server-startup adoption:** at startup, BEFORE any daemon connects, adopt `'__local__'` rows to a stable `'local'` machine (`relay.ensureLocalMachine(hostname())`). This is the **data-can't-vanish safety net** — see the hard-won lesson below.
- **Protocol changes** (`packages/protocol/src/messages.ts`): `DaemonHandshake` union (pair/hello) + `DaemonHandshakeReply`; `SessionMeta.machineId`/`machineName`; a `machinesChanged` server→client message; `HostMetricsWire` keyed by `machineId`.
- **Server registry** (`apps/server/src/relay.ts`): replace the single `daemonSend` with a `Map<machineId, DaemonConn>` + per-machine pending queues; route control messages by `session.machineId`; on a daemon disconnect, only THAT machine's live sessions go `reconnecting`.
- **Repo identity:** normalized git origin URL (`git@host:repo.git` / `https://host/repo` → `host/repo`).
- **Web UI:** machine-aware New-panel dropdown (MRU machine first; disabled for repos a machine lacks), a **Settings → Machines** panel (`apps/web/src/MachinesPanel.tsx`), a machine badge shown only when >1 machine is connected, and merge-by-repo (same git repo on multiple machines collapses to one workspace entry).

## Why a plain rebase is hard — the substrate moved (Bun migration on current `main`)

A trial merge of `e897e60` onto `main` produced **12 conflict files**, and the heavy ones are not hunk-picks but rewrites because `main`'s foundation changed:

- **`apps/server/src/store.ts`** — the branch uses `node:sqlite`'s `DatabaseSync` **directly**; current `main` goes through a runtime-neutral shim: `import { openDatabase } from '@podium/core/sqlite'` (dispatches `bun:sqlite` vs `node:sqlite`). The branch's **DB v4 migration + machine tables must be re-expressed through the shim's `SqlDatabase` interface** (`.exec()`/`.prepare()` are API-compatible, but it's a semantic port, and it must be tested on BOTH runtimes).
- **`apps/server/src/relay.ts`** — heaviest. The branch rewrites `SessionRegistry` (single `daemonSend` → `Map<machineId>`); meanwhile current `main`'s relay grew file-relay, an MCP route, and quota hooks. Both sides rewrote it → resolving = re-deriving the registry to carry both.
- **`apps/daemon/src/daemon.ts`** — current `main` is ~600 LOC larger (new Cursor/Opencode/Codex agent observers + quota/upload modules + a `PtyProcess` abstraction with a `Bun.Terminal` adapter + crash-net/watchdog). The branch's identity-load + handshake-send + bootstrap must splice into that larger startup.
- **PTY + SQLite are both abstractions now** (`packages/agent-bridge/src/pty/`, `packages/core/src/sqlite/`); the branch predates both. node-pty is optional; Bun is the runtime; release is `bun build --compile`.
- Other conflict files: `wsServer.ts`, `router.ts`, `server.ts`, `session.ts`, `messages.ts`, `connection.ts`, plus several `apps/web/*`.

**Low-conflict harvest (these are net-new — reuse them ~as-is, fixing imports/signatures):** `apps/daemon/src/identity.ts`(+`.test.ts`), `apps/server/src/pairing.ts`(+`.test.ts`), `apps/server/src/local-machine.ts`, `apps/web/src/MachinesPanel.tsx`, and the `*.machines.test.ts` suites (`relay.machines`, `repo-registry.machines`, `router.machines`, `store.machines`, web `derive.machines`).

## Suggested approach

1. **Read** the design + plan docs (the spec) and skim `e897e60` (the reference). Map current `main`'s substrate: `store.ts` (shim), `relay.ts` (single `daemonSend`, line ~85/231), `daemon.ts` (observers), `messages.ts`.
2. **Spike the rebase** in a throwaway worktree: `git worktree add /tmp/mm-rebase <new-branch> e897e60` then `git rebase main` (or `git merge main`) — assess conflict severity per file. Don't commit the spike; it's just to gauge.
3. **Decide per file:** harvest the net-new files cleanly; for the heavy files (`store.ts` DB-shim, `relay.ts` registry, `daemon.ts` handshake, `wsServer.ts` auth) prefer **re-implementing against the Bun substrate** using the branch version as a reference (a textual rebase of files both sides rewrote tends to silently drop logic). Re-express the DB v4 migration through `@podium/core/sqlite`.
4. **Preserve the safety nets** (see below).
5. **Verify** (see below).
6. **Report** honestly: what you rebased vs re-implemented, what passes, what's risky/incomplete, and your recommendation. The reviewer needs to judge whether to build on it.

## Critical constraints & hard-won gotchas (do not skip)

- **Work in a git worktree off CURRENT `main`. NEVER commit on `main`** — the live Podium backend runs from `main`'s working tree (redeploys on `.git/logs/HEAD`); broken source there crash-loops the live server. The live server runs on **`:18787`** against **`~/.podium`** — isolated smokes must use `PODIUM_STATE_DIR=$(mktemp -d)` and a non-standard port, and **never broad-`pkill`** (kill by specific path only). Don't touch `:18787`/`~/.podium`.
- **Base off current `main`**, not the parked packaging branches. NOTE: four packaging branches (`feat/packaging-phase1/2/3/5`) are parked unmerged and ALSO modify `protocol/messages.ts`, `server.ts`, `wsServer.ts`, `daemon.ts`, `cli.ts`. Keep multi-machine independent of them for now; whoever merges later reconciles. (Flag any overlap you notice.)
- **PRESERVE the data-can't-vanish safety net.** This feature was once **rolled back** because the split daemon couldn't get the in-process bootstrap token → never registered → `'__local__'` sessions/repos vanished on restart. The fix (which you MUST keep): (1) a persistent same-host shared secret (`~/.podium/daemon.secret`) both processes read so the local daemon authenticates with no pairing; (2) the server **adopts `'__local__'`→`'local'` at STARTUP before any daemon connects**. Single-box must never regress.
- **SQLite:** all DB code goes through `@podium/core/sqlite`'s `openDatabase()`/`SqlDatabase` — do NOT import `node:sqlite`/`bun:sqlite` directly. **Do NOT add a `@podium/core` alias to `vitest.config.ts`** — Vite string aliases prefix-match and break the `@podium/core/sqlite` subpath, failing the server suites. Bare `@podium/core` resolves via the package `exports` map.
- **Tests:** backend/unit via `bun run test` (vitest). **Web component tests need the `apps/web` happy-dom config** (`cd apps/web && bun run test:unit -- <file>`), NOT root `bun run test` (root lacks happy-dom → `document is not defined`). Pure tests run fine under root.
- Follow TDD; commit per logical step; keep `single-box mode byte-for-byte unchanged` at each stage (the original plan's rollout discipline).

## Verification (the bar)

- `bun run --filter '*' typecheck` clean; `bun run test` — server/daemon/protocol/core suites green (mind the happy-dom note for web).
- The branch's **e2e tests** are the real proof — port them: `tests/e2e/multi-machine.e2e.test.ts` (two fake daemons, routing, pairing) and `tests/e2e/split-local.e2e.test.ts`. Plus the `*.machines.test.ts` unit suites and the DB v4 migration test (must pass on BOTH `bun:sqlite` and `node:sqlite`).
- **Single-box unaffected:** a fresh `~/.podium` (or the startup adoption of `'__local__'`→`'local'`) yields working sessions/repos with no daemon registration required.
- Manually: pair a second (headless) daemon to a server and confirm its repos/agents become selectable and route correctly; disconnect it and confirm only ITS sessions go `reconnecting`.

## Deliverable

A branch (e.g. `feat/multi-machine-on-bun`) off current `main` with the feature integrated + tests green, and a written report covering: rebase-vs-reimplement per major file, what's verified, what's risky or incomplete, deviations from the original design, and your recommendation on whether it's solid to build on. Do NOT merge to `main` — leave it parked for review.
