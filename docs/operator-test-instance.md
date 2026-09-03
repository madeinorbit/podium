# Operator source sandbox handoff

> **RUNNING — named instance `operator`, source mode, verified 2026-08-27 16:02:33 CEST.**
> Runtime pin: `2e7be343a63221e2ae427cf08eb4dcad92e7a9d9`.

This is the isolated operator sandbox for the agent-runtime epic. It runs the split server and
daemon directly from TypeScript source with Bun's `@podium/source` condition, and runs the web UI
from Vite source. No production Podium/web build was made or served, no stale `apps/web/dist` is in
the serving path, and no `test:heavy` work was acquired or queued.

## Open it

- MagicDNS: <http://flatblock.shetland-banjo.ts.net:32090>
- Tailscale IP: <http://100.110.195.114:32090>
- Password: `pod2245-source-20260827`
- Username: none; the password authenticates the sole local operator account.

The public URL is plain HTTP on the tailnet. Vite is the only tailnet-facing listener. It proxies
HTTP API and WebSocket traffic to the loopback-only server so the browser keeps one origin:
`http://flatblock.shetland-banjo.ts.net:32090` and `ws://flatblock.shetland-banjo.ts.net:32090`.

## Runtime pin and processes

Before launch, both `git rev-parse HEAD` and
`git merge-base HEAD 2e7be343a63221e2ae427cf08eb4dcad92e7a9d9` returned the exact runtime pin.
Every unit records the full pin in `PODIUM_SPAWN_SHA` and uses this worktree as its cwd:

`/home/mgw/src/podium/.worktrees/issue-2245-operator-test-instance`

| Role | Unit / PID at handoff | Started (CEST) | Source command |
|---|---|---|---|
| Server | `podium-operator-source-server.service` / `2521812` | 2026-08-27 15:58:13 | `/home/mgw/.bun/bin/bun --conditions=@podium/source scripts/server.ts` |
| Daemon | `podium-operator-source-daemon.service` / `2512536` | 2026-08-27 15:54:56 | `/home/mgw/.bun/bin/bun --conditions=@podium/source scripts/daemon.ts` |
| Frontend | `podium-operator-source-web.service` / `2519912` | 2026-08-27 15:57:30 | Node running Vite for `apps/web` with `--host 100.110.195.114 --port 32090 --strictPort` |

The units are deliberately labeled `POD-2245 operator SOURCE-MODE ... @ 2e7be343a` in systemd.
PIDs are point-in-time pins; use `systemctl --user show <unit> -p MainPID` if a unit is restarted.

## Derived instance identity and endpoints

Only `PODIUM_INSTANCE=operator` selects the instance. `HOME` remains the operator's real
`/home/mgw`; `PODIUM_STATE_DIR`, `PODIUM_AGENT_HOME`, `ABDUCO_SOCKET_DIR`, and `TMUX_TMPDIR` were
not supplied as launcher overrides. The product derived:

| Resource | Derived value |
|---|---|
| State root | `/home/mgw/.local/state/podium/operator` |
| Instance UUID | `5521a8f2-5de5-4f5e-9b63-3e80690ba04c` |
| Agent home | `/home/mgw/.local/state/podium/operator/agent-home` |
| Server | `127.0.0.1:32087` |
| Hook | `127.0.0.1:32088` |
| Agent relay | `127.0.0.1:32089` |
| Vite frontend | `100.110.195.114:32090` |
| abduco socket root | `/run/user/1001/podium-operator` |
| tmux socket root | `/home/mgw/.local/state/podium/operator/runtime/tmux` |
| Codex hook socket | `/home/mgw/.local/state/podium/operator/runtime/codex-hooks.sock` |

`ss -ltnp` showed no `0.0.0.0` or public-interface listener in this port set. A direct request to
`100.110.195.114:32087` was refused, as intended; only Vite on `100.110.195.114:32090` is reachable
from the tailnet. The hook and relay remain daemon-local.

## Verification at handoff

All browser-facing checks below used the MagicDNS URL, with an additional health check against the
Tailscale IP:

- `GET /` returned HTTP 200 through MagicDNS; `GET /health` returned HTTP 200 and `ok` through both
  MagicDNS and `100.110.195.114`.
- `GET /auth/status` reported `needsAuth: true`, `authed: false`, and a ready data plane before
  login. `POST /auth/login` with the temporary password returned HTTP 200 and `user:sole`; the next
  status read reported `authed: true`.
- Vite's transformed `/src/lib/logging/build-version.ts` declared
  `PODIUM_APP_VERSION: "dev+2e7be34"`. The same-origin `/version` route reported
  `appVersion: "dev+2e7be34"` and `instanceId: "operator"`.
- A `/client` upgrade carrying
  `Origin: http://flatblock.shetland-banjo.ts.net:32090` returned HTTP 101, then emitted the welcome,
  machine, approval, and host-metrics frames. This proves the frontend's WebSocket-relevant origin
  reaches the source server through Vite.
- Read-only `machines.list` returned one online `flatblock` machine with `installKind: "source"`,
  `appVersion: "dev+2e7be34"`, and the current agent/tool inventory. Read-only `sessions.list`
  returned an empty array, proving the projection path without creating a session.
- The server journal recorded the daemon attaching as the derived local machine. The current
  server and daemon PIDs both have the exact source cwd and full `PODIUM_SPAWN_SHA` above.

## Expected working

- The Tasks/login shell and authenticated web application load from either tailnet URL.
- Same-origin health, auth, tRPC, `/client` WebSocket, and daemon registration are working.
- The named state, agent home, ports, instance UUID, runtime directories, and transient units are
  independent of the default/live Podium instance.
- The inventory sees installed Claude Code, Codex, Grok, and OpenCode executables, plus `gh`.
- The sandbox is intentionally empty; creating test sessions is left to the operator.

## Known not green / source-mode caveats

- The isolated agent home currently reports `login.state: "out"` for Claude Code, Codex, Grok,
  and OpenCode. The executables are installed, but authenticated driver turns are not expected to
  work until credentials are configured in this named instance. No credential was created,
  rotated, or borrowed during this bring-up.
- `sessions.list` is empty by design. No agent was spawned because verification was limited to the
  requested read-only projection.
- `/podium-build.json` returns 404 in this configuration. That is expected: Vite serves source and
  there is deliberately no completed production web build stamp. Frontend identity is instead
  proven from Vite's transformed source module and the source process pin.
- Production chunking, minification, PWA/service-worker behavior, signed updates, update banners,
  and production performance are not represented by this sandbox. `/version` may describe the
  stable update target even though this process is a pinned source checkout.
- The public URL is plain HTTP rather than TLS, so browser features requiring a secure context may
  not work from another device.
- These are transient user units. They survive this agent session, but are not enabled for boot and
  should not be expected to survive a reboot or loss of the user manager. State persists under the
  derived state root.

## Observe and stop

Status and logs:

```sh
systemctl --user status podium-operator-source-server.service podium-operator-source-daemon.service podium-operator-source-web.service
journalctl --user-unit podium-operator-source-server.service --user-unit podium-operator-source-daemon.service --user-unit podium-operator-source-web.service
```

Exact stop command (keeps the derived state):

```sh
systemctl --user stop podium-operator-source-web.service podium-operator-source-daemon.service podium-operator-source-server.service
```

Do not use the default instance's lifecycle command to stop this sandbox.
