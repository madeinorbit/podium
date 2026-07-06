# Headless process model: setup orchestrates independent server + daemon

Issue: #98 (epic #96 — Podium on a new VPS). Status: design, no code yet.

## Problem

A fresh headless install (`podium` on a new VPS) runs **all-in-one in a single process** —
`scripts/cli.ts` imports `startServer` + `startDaemon` and hosts both in one PID. That is the
exact topology the team already retired on the dev host: `scripts/systemd/README.md` calls the
combined backend "the **legacy** single-process unit … kept as a disabled fallback," and the
canonical dev deployment runs a **split** pair (`podium-server.service` + `podium-daemon.service`).
`scripts/server.ts` states the rationale directly: keeping per-agent work out of the coordinating
process "is the whole point: a reattach storm or a misbehaving agent can never starve this
coordinating loop, so /health and the UI stay responsive."

So the packaged default contradicts the project's own production topology, and the isolation asset
is already built but unused: the headless bundle ships standalone `podium-server` / `podium-daemon`
binaries that all-in-one never launches.

Two concrete failure modes motivated this design:

- **No isolation / no wedge-recovery headless.** A wedged-but-alive daemon (the documented
  big-paste msg-loop wedge, or an agent starving the loop) freezes the whole in-process backend.
  Nothing recovers it without systemd's `Type=notify` + `WatchdogSec` — which the single process
  doesn't get.
- **Force-kill orphans + double-run.** The desktop app spawns the in-process `podium` sidecar with
  no `PR_SET_PDEATHSIG`, and picks a *free port each launch*. Force-quitting the app (SIGKILL does
  not cascade to children on Unix) orphans the backend; relaunch picks a new port and spawns a
  **second** full backend — two daemons contending over the same `~/.podium` (`discovery.db` is
  owned exclusively by one worker) and the same abduco sessions. There is no pidfile / reclaim
  anywhere today.

## Goals

- A fresh headless `podium` walks the user into setup, then runs server and daemon as **two
  independent OS processes** — never one.
- Setup offers a clear persistence choice: **install as a systemd service** (survives reboot,
  supervised) or **not** (detached, best-effort).
- A per-machine **run registry** so any launcher can answer "is it already running?", reclaim a
  stale/orphaned backend, and drive `status` / `stop`.
- Reuse what exists: the split entrypoints (`podium server` / `podium daemon`), the systemd unit
  templates, the session-reattach-on-boot heal path.

## Non-goals (deferred)

- **Splitting the desktop app** onto two processes. Desktop keeps its in-process all-in-one
  sidecar; it only gains run-registry reclaim. Tracked as a deferred follow-up.
- **Non-systemd wedge-recovery** (auto-restarting a wedged-but-alive process without systemd).
  Requires a liveness heartbeat the daemon has no HTTP surface for; deferred. Covers desktop and
  the detached-VPS case together if/when it matters.
- Windows/macOS service managers. systemd (`--user`) is the only supervised target here.

## Architecture

### Components

Exactly two long-lived components, each the **one** `podium` binary re-invoked in a
single-component mode (both already implemented in `resolvePlan`):

| Process | Command | Responsibility |
|---|---|---|
| Server | `podium server` | relay + HTTP/tRPC + client/daemon WebSockets on `:18787`; no PTY. |
| Daemon | `podium daemon --server ws://localhost:18787` | all per-agent PTY / transcript / discovery / metrics; dials the server. |

The standalone compiled `podium-server` / `podium-daemon` binaries are removed from the build
(`scripts/build-bun.ts`) and the headless bundle; the single `podium` binary is the only artifact.
The in-process all-in-one path in `cli.ts` is **retained only as the desktop sidecar mode** — no
headless/human path reaches it.

### Run registry

Directory `~/.podium/run/` (under `PODIUM_STATE_DIR` when set). One JSON pidfile per role:

```
~/.podium/run/server.pid   → {"pid":1234,"port":18787,"role":"server","startedAt":"…","mode":"detached"}
~/.podium/run/daemon.pid    → {"pid":1240,"port":18787,"role":"daemon","startedAt":"…","mode":"detached"}
~/.podium/run/all-in-one.pid → …            (desktop only)
```

- **Written** by each component at startup (after it binds / connects), **removed** on clean exit
  (SIGTERM/SIGINT handler).
- **Keyed by role**, not port — desktop's free-port strategy must still reclaim correctly.
- **Liveness** = `process.kill(pid, 0)` succeeds (PID alive) AND the recorded `role` matches. A
  pidfile whose PID is dead (or reused by an unrelated process — verified by a recorded
  start-time / argv sanity check where cheap) is treated as stale and overwritten.
- **Reclaim on start:** before a component binds, it reclaims its own role — a live holder gets
  `SIGTERM`, then `SIGKILL` after a short grace (e.g. 3 s). Safe because agent PTY sessions are
  detached from the backend (own `systemd-run --scope` / abduco masters) and the fresh daemon
  re-adopts them on boot via the existing reattach/heal path.

Reclaim, pidfile read/write, and liveness live in one small module (proposed
`packages/core/src/run-registry.ts`) consumed by `cli.ts` and the component boots.

### Launch flows

**`podium` (no subcommand):**
- Unconfigured + TTY → `podium setup` (the already-shipped [#96] first-run-launches-setup change).
- Unconfigured + no TTY → print setup guidance (unchanged headless fallback).
- Configured → **ensure up**: for each component, if the run registry shows it down, start it in
  the configured persistence mode (systemd: `systemctl --user start`; detached: spawn); then print
  status + URL.

**`podium setup`:** the existing interactive flow, extended so that after writing config it asks
**"Keep Podium running as a systemd service (survives reboot)? [Y/n]"** and then starts the backend:
- **Yes →** render + install two `--user` units, `loginctl enable-linger`, `systemctl --user
  enable --now podium-server podium-daemon`.
- **No →** **detached spawn**: `setsid` each component with stdout/stderr redirected to
  `~/.podium/logs/{server,daemon}.log`, write pidfiles, and the `podium` parent waits until the
  server's `/health` answers and the daemon reports connected, then exits 0.

**`podium status`:** read the run registry (+ `systemctl --user is-active` when mode=systemd) and
print each component: up/down, pid, port, uptime, persistence mode.

**`podium stop`:** systemd mode → `systemctl --user stop`; detached → SIGTERM pidfile PIDs
(SIGKILL after grace), remove pidfiles.

**`podium logs [-f]`:** tail `~/.podium/logs/*.log` (detached). systemd mode prints the
`journalctl --user -u podium-server -u podium-daemon` hint instead.

### systemd units

Two parameterized `--user` templates rendered at setup into
`${XDG_CONFIG_HOME:-~/.config}/systemd/user/`:

- `podium-server.service`: `ExecStart=%h/.local/bin/podium server`, `Type=notify`,
  `WatchdogSec=30`, `Restart=always`.
- `podium-daemon.service`: `Type=notify`, `WatchdogSec=30`, `Restart=always`,
  `After=podium-server.service`, with a **parameterized** `ExecStart`:
  - **local split (this box hosts the server):** `podium daemon --server ws://localhost:<port>`.
  - **`--join` (daemon-only, remote server):** `podium daemon` — resolves `serverUrl` from config,
    exactly as the current `install.sh --join` unit does.

  i.e. one daemon template with the server-URL argument filled per case; the `--join` flow keeps
  its config-driven form.

These replace the hardcoded-`/home/user`, run-from-source templates in `scripts/systemd/` for the
packaged path. The `sd-notify` watchdog petting already exists
(`scripts/sd-notify.ts`) and is a no-op without `NOTIFY_SOCKET`, so it is safe in detached mode.

## Data flow

1. `podium` reads `~/.podium/config.json` + argv → `resolvePlan`.
2. Unconfigured → setup writes config (mode, publicUrl, persistence) and either installs+starts
   systemd units or detached-spawns the two components.
3. Each spawned component: reclaim its role → bind/connect → write its pidfile → pet watchdog (if
   `NOTIFY_SOCKET`) → on signal, remove pidfile + exit.
4. `status`/`stop`/`ensure-up` operate purely through the run registry (+ systemd when applicable).

## Error handling

- **Port held by a non-podium process:** server start fails with the existing `portInUseMessage`
  (no pidfile match to reclaim) — actionable, non-crashing.
- **Reclaim can't kill a stale holder** (EPERM): warn and abort the start with guidance rather than
  double-run.
- **Stale pidfile, dead PID:** silently overwritten.
- **setup on a non-TTY:** never blocks on a prompt; falls through to printing guidance.
- **Daemon can't reach server:** existing reconnect backoff; systemd `Restart=always` covers a hard
  exit.
- **Detached parent times out** waiting for `/health`/daemon-connect: report which component failed
  and where its log is; leave nothing half-spawned (kill what did start).

## Testing

- **Real-binary smoke (`*.bun.test.ts`, compiles a real `podium`):** detached start → `status` shows
  both up → `stop` → `status` shows down; and start-twice → assert exactly one process per role
  (reclaim works). This is the class of bug only a real binary catches (cf. the worker-embed fix).
- **Run-registry unit tests:** write/read/roundtrip; live vs stale detection (mock `process.kill`);
  reclaim sends SIGTERM then SIGKILL; role-keyed match ignores port.
- **Template-render unit tests:** render each systemd unit and assert `ExecStart`, `Type=notify`,
  `WatchdogSec`, `Restart` (mirrors `apps/desktop/src-tauri/tauri-conf.test.ts`).
- **`resolvePlan` / setup-branch unit tests:** systemd-yes vs detached vs already-configured
  ensure-up; extends the existing `scripts/cli-setup.test.ts`.

## Rollout / compatibility

- Desktop: no behavior change beyond gaining reclaim (an in-process `podium` all-in-one now writes
  and reclaims an `all-in-one.pid`), so a force-killed orphan is reaped on relaunch.
- `install.sh --join`: unchanged flow; its daemon unit aligns to the shared template.
- Existing dev-host source units (`scripts/systemd/*`) remain for the from-source dev deployment;
  the new rendered templates target the packaged `~/.local/bin/podium` path.
