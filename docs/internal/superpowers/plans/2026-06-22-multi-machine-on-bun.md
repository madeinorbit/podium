# Plan: bring multi-machine onto Bun `main` (port from `e897e60`)

## Context for every task (read this block)

We are re-integrating the **multi-machine** feature onto current `main` (the Bun migration
substrate). The feature was fully implemented, opus-reviewed, and verified on branch
`worktree-multi-machine-agents-impl` (tip **`e897e60`**), but that branch was cut from a
**pre-Bun** base (`6dcfdcf`). We are porting, not inventing: **`e897e60` is the reference
spec — its code is known-good.** For any file, read the reference with
`git show e897e60:<path>` and the current substrate with the file on disk.

Design + handoff (read once for intent): `docs/superpowers/multi-machine-phase6-handoff.md`,
`git show e897e60:docs/superpowers/specs/2026-06-17-multi-machine-agents-design.md`.

### Global constraints (bind every task; reviewers get these verbatim)

- **SQLite goes through the shim.** All DB code uses `import { openDatabase, type SqlDatabase } from '@podium/core/sqlite'` and the `SqlDatabase` surface (`prepare`/`exec`/`close`, statements `run`/`get`/`all`). NEVER import `node:sqlite` or `bun:sqlite` directly. The migration must run on BOTH runtimes.
- **Do NOT add a `@podium/core` alias to any `vitest.config.ts`** — string aliases prefix-match and break the `@podium/core/sqlite` subpath. Bare `@podium/core` resolves via the package `exports` map.
- **PRESERVE the data-can't-vanish safety net** (this feature was once rolled back over it): (1) persistent same-host shared secret `~/.podium/daemon.secret` (`local-machine.ts:readOrCreateDaemonSecret`) both processes read; (2) the server **adopts `'__local__'`→`'local'` rows at STARTUP, before any daemon connects** (`relay.ensureLocalMachine(hostname())`). Single-box must never regress.
- **Single-box behavior stays byte-for-byte unchanged** when there is one machine: the machine badge shows only when >1 machine is connected; the new-panel dropdown's machine list only appears with >1 machine.
- **Tests:** backend/protocol/core via root `bun run test` (vitest). **Web component tests need the `apps/web` happy-dom config** — run `cd apps/web && bun run test:unit -- <file>`, NOT root. Follow TDD; commit per logical step.
- **Known-pre-existing baseline failures (NOT yours, do not chase):** root run — `packages/agent-bridge/src/cursor/cli.test.ts`, `opencode` CLI detection, `scripts/sd-notify.test.ts` (WATCHDOG_USEC); web happy-dom run — `apps/web/test/shell.structure.test.ts` (4 stale assertions). Everything else is green at baseline.

### What the feature delivers (intent)

One server orchestrates daemons on N machines. Stable `machineId` UUID per daemon
(persisted `~/.podium/daemon.json`); hostname is display-only. Pairing-code auth for remote
daemons; the local same-host daemon authenticates via the shared secret. DB v4 adds a
`machines` table + `machine_id` attribution. The server registry routes control messages
per-machine (`Map<machineId>`); a daemon disconnect only reconnects ITS sessions. Web gets
a machine-aware new-panel dropdown, a Settings→Machines panel, a >1-machine badge, and
merge-by-repo (same git origin on multiple machines collapses to one workspace entry).

---

## Task 1: Protocol + core foundation

**Goal:** land the wire-protocol and core helpers everything else imports. No behavior yet.

**Files (port from `e897e60`, reconcile onto main's larger versions):**
- `packages/protocol/src/messages.ts` (+ `messages.test.ts`): add the `DaemonHandshake` union (`pair{code,machineId,hostname,name?}` | `hello{machineId,token,hostname}`) + `DaemonHandshakeReply` (`paired{token}` | `helloOk` | `helloRejected`); `SessionMeta.machineId` + `machineName`; a `machinesChanged` server→client message carrying `MachineWire[]`; `MachineWire` ({id,name,hostname,online,lastSeenAt}); key `HostMetricsWire` by `machineId`. main added +210 lines here — ADD alongside, don't replace.
- `packages/core/src/git.ts` (+ `git.test.ts`, export in `index.ts`): net-new `normalizeOriginUrl` (`git@host:repo.git` / `https://host/repo(.git)` → `host/repo`). Clean add.
- `packages/terminal-client/src/connection.ts` (+ `connection.test.ts`): the machine-aware connection delta. Reconcile onto main.

**Test gate:** `bun run test packages/protocol packages/core packages/terminal-client` green (new machines/handshake/normalize cases included).

---

## Task 2: Store — DB v4 migration + machine persistence (through the shim)

**Goal:** persist machines and attribute sessions/conversations/repos by `machine_id`, on both runtimes.

**Files:**
- `apps/server/src/store.ts` (+ `store.machines.test.ts`, reconcile `store.test.ts`): port the v4 migration from `git show e897e60:apps/server/src/store.ts` but express ALL DDL/queries through `this.db` (the shim's `SqlDatabase`) — the reference already uses `.prepare()/.exec()/.all()/.get()`, which is API-compatible, so this is a semantic slot-in onto main's shim-based store, NOT a driver rewrite. Deliver: `machines` table (id PK, name, hostname, token_hash, created_at, last_seen_at); `machine_id` columns on `sessions`/`conversations` (default `'__local__'`); `repos` re-keyed `PRIMARY KEY (machine_id, path)` + `origin_url` + `repo_name`; idempotent/transactional v3→v4 (guarded by `needsV4`); machine CRUD: `upsertMachine`, `getMachineByToken` (timing-safe), `listMachines`, `touchMachine`, `adoptLocalRows(machineId)` (rewrites all three tables `'__local__'`→machineId), `listRepos(machineId)`.

**Test gate:** `bun run test apps/server/src/store` green. The v4 migration test MUST pass under BOTH `bun:sqlite` and `node:sqlite` (the suite already parameterizes; confirm). Migrating a v3 DB preserves rows and stamps them `'__local__'`.

---

## Task 3: Net-new auth modules (clean harvest)

**Goal:** the identity + pairing + local-machine modules. These had ZERO merge conflicts — harvest near-verbatim, fix imports only.

**Files (copy from `e897e60`, then adjust imports to main):**
- `apps/daemon/src/identity.ts` (+ `identity.test.ts`): `loadIdentity({dir?})` → `{machineId (persisted UUID), token?}`, `saveToken`. Persists `~/.podium/daemon.json`.
- `apps/server/src/pairing.ts` (+ `pairing.test.ts`): `PairingManager` — `mintPairingCode()` (in-memory single-use codes), `redeem(code)`.
- `apps/server/src/local-machine.ts`: `LOCAL_MACHINE_ID='local'`, `stateDir()`, `readOrCreateDaemonSecret(dir?)` (0600, race-safe `wx`). Use the **latest** reference version (includes the secret-deletion operational-note comment).

**Test gate:** `bun run test apps/daemon/src/identity apps/server/src/pairing` green.

---

## Task 4: Relay — per-machine registry refactor (THE BIG ONE)

**Goal:** replace the single daemon link with a per-machine registry, routing control messages by `session.machineId`, WITHOUT losing any of main's relay features.

**This is a re-implementation, not a merge.** main's `relay.ts` defines `private readonly toDaemon: Send<ControlMessage>` and calls `this.toDaemon(...)` at ~10 sites. The reference replaces that whole scheme. Read BOTH: `git show e897e60:apps/server/src/relay.ts` (the target design) and the on-disk `relay.ts` (the substrate to preserve).

**Deliver (from the reference):**
- `private readonly daemons = new Map<string, Send<ControlMessage>>()` + per-machine pending queue; `private readonly toMachine = (machineId, msg) => …` (queues when that machine is offline, flushes on attach).
- `attachDaemon(machineId, send)`, `detachDaemon(machineId)` (only THAT machine's live sessions → `reconnecting`), `onDaemonMessageFrom(machineId, msg)`.
- `ensureLocalMachine(hostname?, secret?)` → registers `'local'` with `tokenHash=sha256(secret)` and calls `adoptPlaceholderRows('local')` (rewrites store rows + in-memory `s.machineId` from `'__local__'`, re-`broadcastSessions()`). The `LOCAL_PLACEHOLDER='__local__'` constant.
- `PairingManager` integration: `mintPairingCode()`, `authenticateDaemon(frame)` (hello→`getMachineByToken`; pair→redeem→mint token→`upsertMachine`).
- `latestHostMetrics` keyed by `machineId`; `listMachines()` (online = has a live entry in `daemons`); emit `machinesChanged`.
- Sessions carry `machineId`; new/resumed sessions bind `toDaemon: (msg) => this.toMachine(this.sessions.get(id)?.machineId ?? machineId, msg)`.

**CONVERT every one of main's `this.toDaemon(...)` call sites** to per-machine routing via the owning session's `machineId`. **PRESERVE main's additions:** file-relay (`knownPathsFor`, file RPC), the MCP route, quota hooks, telegram/ntfy `NotificationPushers`, `persist(session)` inside shell-busy `onActivity`, and the `lastSessionsBroadcast` byte-identical-dedup. Also port `apps/server/src/session.ts`'s `machineId` field (+ `session.ts` reconcile).

**Test gate:** `bun run test apps/server/src/relay` — `relay.machines.test.ts` (harvested) AND the reconciled `relay.test.ts` both green. Pay attention to the codex/title/recency tests main added — they must still pass.

---

## Task 5: Daemon socket auth + server startup + launchers

**Goal:** wire the handshake on the server side and provision the local machine at startup.

**Files:**
- `apps/server/src/wsServer.ts` (+ `wsServer.daemon.test.ts`): `wireDaemonSocket(ws, registry)` — pre-auth gate (drop non-handshake first frames), route the first `hello`/`pair` through `registry.authenticateDaemon`, then `attachDaemon` + `helloOk`/`paired`; subsequent frames → `onDaemonMessageFrom`; `close` → `detachDaemon`. NO bootstrap special-case (unified auth — the local machine is a normally-registered machine).
- `apps/server/src/server.ts`: `const bootstrapToken = readOrCreateDaemonSecret()`; `registry.ensureLocalMachine(hostname(), bootstrapToken)` BEFORE the HTTP server listens; expose `bootstrapToken` on `ServerHandle`.
- `scripts/daemon.ts`: `startDaemon({serverUrl, bootstrapToken: readOrCreateDaemonSecret(), machineId: LOCAL_MACHINE_ID})`.
- `scripts/host.ts`: pass `bootstrapToken: server.bootstrapToken, machineId: LOCAL_MACHINE_ID`.

**Test gate:** `bun run test apps/server/src/wsServer` green (the local machine authenticates via the normal hello; unknown hello → `helloRejected`; pair flow mints a token).

---

## Task 6: Daemon — handshake/identity splice

**Goal:** make the daemon present a stable machine identity and authenticate, spliced into main's larger startup.

**Files:**
- `apps/daemon/src/daemon.ts` (+ reconcile `daemon.test.ts`): add `DaemonOptions` `{bootstrapToken?, pairCode?, name?, identityDir?, machineId?}`; `const identity = loadIdentity(...)`, `const machineId = opts.machineId ?? identity.machineId`; on connect send a typed `DaemonHandshake` (bootstrapToken/stored-token → `hello`; else pairCode → `pair`; else fail); handle the reply (`paired`→`saveToken`; `helloOk`→ go live; `helloRejected`→reject). Add the `authenticated` gate so pre-auth frames belong to the handshake handler. SPLICE into main's startup, interleaving with main's async image-upload handler, the oversized-control-frame cap, and the reconnect-with-backoff loop (each reconnect re-authenticates).

**Test gate:** `bun run test apps/daemon` green (reconnect + handshake).

---

## Task 7: Router + repo-registry machine awareness

**Goal:** expose machines over tRPC and make repo scanning machine-aware + merge-by-origin.

**Files:**
- `apps/server/src/router.ts` (+ `router.machines.test.ts`, reconcile `router.test.ts`): a `machines` sub-router — `list`, `rename`, `revoke`, `mintPairingCode`; surface `machineId`/`machineName` where sessions are returned. Reconcile onto main's router (file-relay/MCP/quota procedures stay).
- `apps/server/src/repo-registry.ts` (+ `repo-registry.machines.test.ts`, reconcile `repo-registry.test.ts`): attribute repos by `machineId`; use `normalizeOriginUrl` for identity; fan out scan/metrics awareness for >1 machine (single-machine path unchanged).

**Test gate:** `bun run test apps/server/src/router apps/server/src/repo-registry` green.

---

## Task 8: Web — machine-aware UI

**Goal:** the dropdown, Settings panel, badge, and merge-by-repo. Single-machine UI unchanged.

**Files (port from `e897e60`; MachinesPanel is a clean harvest):**
- `apps/web/src/MachinesPanel.tsx` (new, harvest): rename/revoke/pairing-code, same-origin derivation.
- `apps/web/src/NewPanelMenu.tsx`: machine-aware dropdown — agent list quick-action targets the MRU machine that has the repo; a machine list appears only when >1 machine; machines lacking the repo (or offline) are disabled with a tooltip; per-machine submenu repeats the agent options.
- `apps/web/src/AgentPanel.tsx` + `HomeView.tsx`: per-session machine **badge**, shown only when >1 machine connected.
- `apps/web/src/SettingsView.tsx`: a Machines tab mounting `MachinesPanel`.
- `apps/web/src/derive.ts` (+ `apps/web/test/derive.machines.test.ts`): merge-by-repo via `normalizeOriginUrl` (same origin across machines → one workspace entry); machine-targeting helpers.
- `apps/web/src/store.tsx`: `onMachines` handler — refetch repos when the online-machine count climbs.
- `apps/web/src/types.ts`: machine view types.

**Test gate:** `cd apps/web && bun run test:unit -- test/derive.machines.test.ts` green (happy-dom). Do not regress the rest of the web suite beyond the known `shell.structure` baseline.

---

## Task 9: End-to-end proof

**Goal:** the real proof — two fake daemons routing/pairing, and the startup-adoption safety net.

**Files (port from `e897e60`):**
- `tests/e2e/multi-machine.e2e.test.ts`: server + two daemons (daemon1 = `LOCAL_MACHINE_ID`; daemon2 paired with a real UUID); assert a session created for daemon2's repo routes to daemon2 (`meta.machineId === daemon2Id && !== daemon1Id`).
- `tests/e2e/split-local.e2e.test.ts`: seed a `'__local__'` session + repo; assert startup adoption to `'local'` happens BEFORE any daemon connects, then a daemon (machineId=`LOCAL_MACHINE_ID`, secret from the file) attaches and the machine goes online.
- Harness `machineId: LOCAL_MACHINE_ID` additions: `tests/e2e/{serve,serve-min,serve-keyecho,serve-harness,run-claude-demo,run-resume-smoke,relay.e2e,browser/harness}.ts`.

**Test gate:** `bunx vitest run --exclude '' tests/e2e/multi-machine.e2e.test.ts tests/e2e/split-local.e2e.test.ts tests/e2e/relay.e2e.test.ts` green. Use an isolated `PODIUM_STATE_DIR` + non-standard port; never touch `:18787`/`~/.podium`.
