# Handoff → single-binary, "configure which parts run where" Podium

> From the agent that re-integrated **multi-machine** onto Bun `main` (branch
> `feat/multi-machine-on-bun`, parked for merge). Your job builds directly on it, so this
> note tells you what exists, how the pieces authenticate and route, the invariant you must
> not break, and — most important — where the genuinely-unsolved part of your task is.

## Your mission (as I understand it)

A **single downloadable binary** (e.g. macOS) that the user starts, then **configures which
parts of Podium run where**:
- run the **server** (coordinator: relay + HTTP/tRPC + WebSockets, owns the DB) on this machine,
- run one or more **daemons** (PTY/agent workers) here and/or on other machines,
- and **hand off to a server on a different machine, transferring data**.

Two of those three are mostly a *config/wiring* job on top of what already exists. The third
("hand off to a different server + data transfer") is a **design problem that is NOT solved by
the multi-machine feature** — read that section before you promise it.

---

## 1. What already exists — build on these, don't reinvent

### The three process MODES already have entry points (on `main`)
- `scripts/server.ts` — **server only**: relay + HTTP/tRPC + client/daemon WebSockets. Does NO
  PTY work. Owns the SQLite DB. Daemons connect to it over `ws://…/daemon`.
- `scripts/daemon.ts` — **daemon only**: all per-agent work (abduco/tmux PTY attach, transcript
  tailing, agent-state, discovery, host metrics). Connects to a server, reconnects with backoff.
- `scripts/host.ts` — **both in one process** (in-process daemon; the dev/single-box convenience).

The live deployment runs server.ts + daemon.ts as **two systemd user services** (see the
`podium-server`/`podium-daemon` split). So "configure which parts run where" is largely:
*pick which of these entry points to launch, with what config* — you are adding a mode/config
front-end, not writing the processes.

### The single-binary BUILD already exists
- `scripts/build-bun.ts` produces `bun build --compile` single-file binaries for **server** and
  **daemon**, into `dist-bun/`. It pre-builds + embeds the vendored **abduco** so the compiled
  daemon has no `abduco.c` to compile at runtime (`packages/agent-bridge/src/abduco-bin.ts`,
  `scripts/daemon-compiled.ts`, `scripts/embedded-abduco.ts`).
- **PTY under Bun:** `@podium/agent-bridge` selects `node-pty` under Node vs **`Bun.Terminal`**
  under Bun at runtime — so the compiled Bun binary needs **no native addon**. This is why a
  single self-contained binary is even possible. Don't reintroduce a hard `node-pty` dependency
  in any code the compiled binary loads.
- **SQLite** is the runtime-neutral shim `@podium/core/sqlite` (`bun:sqlite` under Bun,
  `node:sqlite` under Node) — no native addon either.

### The PARKED packaging branches (your real starting point for the UX)
Per the project memory `packaging-distribution-effort`: `feat/packaging-phase1` (headless
bundle), **`feat/packaging-phase2` (setup/MODE layer)**, `feat/packaging-phase3` (Tauri desktop),
`feat/packaging-phase5` (auto-update) are **done + opus-reviewed but PARKED unmerged**, stacked
1→2→3→5 off **old** bases. **Phase 2 is exactly your "which parts run where" surface** — a
`podium` CLI with a setup/mode layer. Rebase/harvest it onto current main rather than rebuilding.
Phase 4 (cross-target dist CI, needs a Mac) is not started. Gotchas from that effort: ship the
`podium` binary as a Tauri **resource** (not externalBin — patchelf corrupts Bun binaries);
Tauri's updater endpoint must be https.

### This branch — multi-machine
`feat/multi-machine-on-bun` (tip `5d5cc5a`, parked for merge): one server orchestrates daemons on
N machines. This is what makes "multiple daemons" and "daemon on another machine" *work*. **It is
not yet merged** — coordinate with the user; you likely want it in before/with your work.

---

## 2. The runtime architecture you're packaging

```
            ┌─────────── machine A ───────────┐     ┌──── machine B ────┐
  browser → │  podium SERVER  ──ws:/daemon──  │     │                   │
  (web UI)  │  (relay, tRPC,   ↘ local daemon │     │  podium DAEMON    │
            │   owns SQLite DB)  (PTY work)   │ ◀───┼── (PTY work)      │
            └─────────────────────────────────┘ ws  └───────────────────┘
                                                (pairing-code auth, then token)
```

- The **server** owns the single SQLite DB and all client/daemon WebSockets. One server.
- A **daemon** is a stateless-ish PTY worker. There can be many, one per machine (the local one +
  remote ones). Each authenticates and is tracked by a stable `machineId`.
- The web UI is served by / talks to the **server**, deriving the backend address from
  `window.location` (same-origin) — see memory `podium-auto-relay-endpoint`. So "which machine the
  user points their browser at" = the server's machine.

---

## 3. Auth & identity — how a daemon attaches to a server (your config surface)

`startDaemon(opts: DaemonOptions)` where the relevant options are:
```ts
{ serverUrl,           // ws(s)://<server-host>:<port>  — the connection target
  bootstrapToken?,     // the LOCAL same-host shared secret (hello token for machineId:'local')
  pairCode?,           // one-time code for a NEW remote daemon with no stored token yet
  name?,               // display name to register on first pair (defaults to hostname)
  machineId?,          // override; the local daemon passes LOCAL_MACHINE_ID ('local')
  identityDir? }       // where daemon.json lives (defaults to the state dir)
```

Two auth paths, **unified** (one `hello`/`pair` gate, no special-case — `wireDaemonSocket` in
`apps/server/src/wsServer.ts` → `registry.authenticateDaemon`):

- **Local, same host as the server:** a persistent shared secret file
  `$STATE_DIR/daemon.secret` (mode 0600), which BOTH the server and the local daemon read
  (`apps/server/src/local-machine.ts:readOrCreateDaemonSecret`). The daemon presents it as the
  token in `hello{machineId:'local', token:secret}`. No pairing, no manual step. The server
  pre-registers `'local'` with `sha256(secret)` at startup (`ensureLocalMachine`).
- **Remote daemon (the interesting case for you):** pairing.
  1. The server/UI mints a one-time code: tRPC `machines.pairingCode` → `registry.mintPairingCode()`.
  2. The remote daemon connects with `pair{code, machineId, hostname, name?}`.
  3. The server redeems the code, mints a token, replies `paired{token}`.
  4. The daemon persists `{machineId, token}` in `~/.podium/daemon.json` (`apps/daemon/src/identity.ts`).
  5. Every later boot sends `hello{machineId, token}` — no code needed again. Each reconnect re-auths.

`machineId` is a **stable UUID** persisted in `daemon.json` (`loadIdentity`); hostname is
display-only and renamable (Settings→Machines). `'local'` is the one reserved id.

**So "configure a daemon to use a server on another machine" =** launch the daemon-mode binary
with `serverUrl=wss://<that server>` and, the first time, a `pairCode` the user copies from the
server's UI (Settings→Machines → "Add machine" shows a code). That UI + the tRPC procedure already
exist (`apps/web/src/MachinesPanel.tsx`). Your packaging needs to surface `serverUrl` + `pairCode`
(and the chosen mode) as user config/flags and route them into `startDaemon`/`startServer`.

**Network reality:** the bundled local daemon uses `ws://localhost:<port>`. Remote daemons need
the server's *real, reachable* address and almost certainly **wss/TLS**. The dev host fronts the
server with `tailscale serve` TLS (memory `podium-dev-host`); a shipped product needs a real story
for server reachability + certs (tailscale, a relay, or user-provided TLS). This is a packaging
design decision, not yet built for the general case.

---

## 4. Data model & the host-locality fact that constrains everything

- The **server** owns ONE SQLite DB. State dir = `$PODIUM_STATE_DIR ?? ~/.podium`
  (`local-machine.ts:stateDir`). Tables include `machines`, and `sessions`/`conversations`/`repos`
  carry a `machine_id` (DB migration is at schema **v5** on this branch — main used v4 for drafts).
- **abduco PTY masters and git worktrees are HOST-LOCAL to the daemon that created them.** A
  running agent's terminal lives in an abduco master in a systemd scope on that daemon's machine
  (memory `podium-abduco-backend`, `podium-redeploy-kills-sessions-cgroup`). You **cannot move a
  live PTY across machines.** Sessions are bound to their daemon's `machineId`; repos are keyed
  `(machineId, path)` with absolute host paths.
- The data-safety net (DO NOT BREAK — this feature was once ROLLED BACK over data loss): the
  server **adopts `'__local__'` placeholder rows → `'local'` at STARTUP, before any daemon
  connects** (`relay.ensureLocalMachine(hostname(), secret)` in `apps/server/src/server.ts`,
  before it listens). So single-box sessions/repos are attributed and visible even if the daemon
  never authenticates. If your mode/launch layer changes startup ordering or how the server is
  invoked, **keep `ensureLocalMachine` running at startup**, synchronously, before serving.

---

## 5. "Configure which parts run where" — concrete mapping

| User intent | What to launch |
|---|---|
| Everything on this machine | `host.ts` mode (in-process), or server.ts + daemon.ts as two processes |
| Server here, agents on other machines | `server.ts` here; each remote machine runs daemon mode → this server (pair once) |
| This machine is just a worker | daemon mode → `serverUrl=wss://<remote server>` + `pairCode` first time |
| Several worker machines | one server; N daemon-mode installs, each paired, each its own `machineId` |

Your binary needs: a **mode selector** (server | daemon | both) + config (`serverUrl`, `pairCode`,
`PODIUM_PORT`, `PODIUM_STATE_DIR`, machine display name). Phase 2's setup/mode layer is where this
goes. Persist the chosen config (state dir) so restarts are non-interactive. The web Settings→Machines
panel is the place to issue pairing codes from the server side; consider a `podium pair <code>`
CLI path too for headless remote daemons.

---

## 6. THE HARD PART — "hand off to a server on a different machine (data transfer)"

**Multi-machine does NOT give you this.** It gives you *one server, many daemons*. It has **no
server↔server transfer, no second server, and no sync layer.** Be precise with the user about
which of these two very different things they want:

**(a) Relocate the coordinator** (move the server from machine A to machine B, keep the data):
- The server's identity is its SQLite DB. "Moving" it = copy `$STATE_DIR/podium.db` (+ `daemon.secret`,
  pairing state) to B and start the server there.
- But: machine A's **agents/worktrees stay on A**. For B's server to keep orchestrating them, A must
  now run a **daemon** pointed at B (re-paired) — i.e. A flips from "local" to "a remote daemon".
  The formerly-`'local'` sessions on A would need re-attribution to A's new (non-local) `machineId`,
  OR you teach the new server to treat the imported DB's `'local'` rows as "machine A". This
  re-attribution is **new code** (analogous to `adoptLocalRows`, but `'local'`→`<A's machineId>`).
- Live PTYs survive on A (abduco masters persist) and reattach via A's daemon — they do **not**
  migrate to B.

**(b) Migrate a user's data between two independent installs** (A and B each a full Podium):
- This is a metadata export/import (sessions/repos/conversations rows), not a live move. Worktrees
  and PTYs don't transfer. You'd build `podium export`/`import` over the store layer. There is **no
  sync engine** — offline-first sync (RxDB+SQLite, Postgres-CDC) was *evaluated and deferred*, see
  memory `podium-persistence-direction`. Don't assume it exists.

**My recommendation:** treat "data transfer" as an explicit feature with its own brainstorm. The
cleanest first cut is probably (a)-narrow: the server's DB is portable; shipping it to a new host +
re-pairing the daemons is the "hand-off", with a documented caveat that running agents stay reachable
only while their original daemon host is up and paired. Confirm scope with the user before building —
the abduco/worktree host-locality is a hard physical constraint, not a thing to engineer around.

---

## 7. File map / integration points

- Server entry/startup: `apps/server/src/server.ts` (`startServer`, `ServerHandle.bootstrapToken`,
  `ensureLocalMachine`). Process entry: `scripts/server.ts`.
- Daemon: `apps/daemon/src/daemon.ts` (`startDaemon`, `DaemonOptions`), identity in
  `apps/daemon/src/identity.ts`. Process entry: `scripts/daemon.ts`. In-process: `scripts/host.ts`.
- Auth gate: `apps/server/src/wsServer.ts` (`wireDaemonSocket`). Registry/routing + pairing:
  `apps/server/src/relay.ts` (`authenticateDaemon`, `attachDaemon`, `toMachine`, `ensureLocalMachine`,
  `mintPairingCode`, `listMachines`, `renameMachine`, `revokeMachine`). Pairing codes:
  `apps/server/src/pairing.ts`. Shared secret + state dir + `LOCAL_MACHINE_ID`:
  `apps/server/src/local-machine.ts`.
- tRPC machines API: `apps/server/src/router.ts` (`machines` sub-router). Web: `apps/web/src/MachinesPanel.tsx`,
  `NewPanelMenu.tsx` (machine-aware dropdown), `derive.ts` (merge-by-repo via `normalizeOriginUrl`).
- Single-binary build: `scripts/build-bun.ts`, `scripts/daemon-compiled.ts`, `scripts/embedded-abduco.ts`,
  `packages/agent-bridge/src/abduco-bin.ts`. PTY abstraction: `packages/agent-bridge/src/pty/`.
  SQLite shim: `packages/core/src/sqlite/`.

---

## 8. Gotchas (learned the hard way)

- **Runtime split:** the server can run under Bun. The daemon runs under Bun via `Bun.Terminal` OR
  Node via `node-pty`. Anything the **compiled** binary loads must not require the native `node-pty`
  addon. Default live deployment is still Node/tsx.
- **SQLite:** only through `@podium/core/sqlite`. NEVER add a `@podium/core` alias to any
  `vitest.config.ts` — it prefix-matches and breaks the `@podium/core/sqlite` subpath. Bare
  `@podium/core` resolves via the package exports map.
- **Tests:** web component tests need the `apps/web` happy-dom config (`cd apps/web && bun run test:unit`),
  NOT root `bun run test` (root lacks happy-dom → `document is not defined`). Backend/protocol/core run
  under root. `.e2e.test.ts` ARE collected by the default run and bind fixed ports.
- **Never touch the live host's `:18787` / `~/.podium`** — the live backend runs from `main`'s working
  tree and redeploys on HEAD move (memory `main-checkout-is-live-source`, `podium-dev-host`). For any
  smoke test use `PODIUM_STATE_DIR=$(mktemp -d)` + a non-standard port; kill only by specific pid/path,
  never broad `pkill`.
- **The packaging branches are off OLD bases** — rebase/harvest, don't blind-merge.
- **Don't auto-merge multi-machine** — it was rolled back once; the user merges it deliberately.

---

## 9. State of `feat/multi-machine-on-bun` you're inheriting

22 commits off `main` `58471ad`, 9 SDD tasks each review-clean + a final whole-branch review =
"ready with noted follow-ups", PARKED for the user to merge. Verified: typecheck 8/8, e2e 3/3
(two-daemon routing + startup adoption), single-box byte-for-byte unchanged, live host untouched.
**Pre-merge TODO (the one thing automation couldn't prove):** live in-browser verification of the
multi-machine new-agent dropdown submenus/disabled-tooltips + the Settings→Machines pairing dialog
(Base-UI portals, unit-uncovered). Deferred non-blocking: host-scoped op fan-out
(`repoOp`/`harnessExec` use `defaultMachine`); a same-daemon-after-server-restart reconnect test;
a guard on `revokeMachine('local')` (currently self-heals on restart). Plan + the original
re-integration handoff: `docs/superpowers/plans/2026-06-22-multi-machine-on-bun.md`,
`docs/superpowers/multi-machine-phase6-handoff.md`. The known-good per-file reference is the old
pre-Bun branch tip `e897e60`.
