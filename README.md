# Podium

Agent orchestration for driving coding agents (Claude Code, Codex) from a best-in-class
web and mobile experience. A server backend, a per-machine daemon that wraps native agent
CLIs over a PTY (tmux-style — no `-p` abstractions), and a responsive web UI where mobile
is a first-class citizen.

Two pieces are built to stand alone as open-source libraries: a coding-agent process
wrapper (`@podium/agent-bridge`) and a browser terminal presentation client
(`@podium/terminal-client`), joined by a shared wire protocol (`@podium/protocol`).

## Layout

| Path | What it is |
|------|------------|
| `apps/server` | API / web backend (Hono + tRPC). |
| `apps/daemon` | Per-machine agent host; wraps CLIs via `@podium/agent-bridge`. |
| `apps/web` | Responsive web UI (React + Vite). |
| `apps/desktop` | Tauri shell that wraps the compiled backend + web UI. |
| `packages/protocol` | ★ Shared agent/terminal wire protocol. |
| `packages/agent-bridge` | ★ Coding-agent CLI process wrapper (server-side PTY). |
| `packages/terminal-client` | ★ Browser terminal presentation client. |
| `packages/core` | Internal domain model + zod schemas. |
| `tooling/tsconfig` | Shared TypeScript base configs. |

★ = published to npm under `@podium/*`. See `ARCHITECTURE.md` for what-goes-where and the
growth path, and `CONTRIBUTING.md` for setup.

## Quick start

```bash
bun install
bun run host       # runs the app: web UI + backend (relay + daemon), on Bun from source
```

Then open **http://localhost:55556** (the Vite dev server; it proxies the API/WebSockets to the
backend on :18787). On first load, pick a folder and scan it for git repositories. No separate
build step is needed — `bun run host` resolves the workspace packages from source.

Contributor checks:

```bash
bun run typecheck
bun run build      # builds the publishable libraries (NOT required to run the app)
bun run lint
bun run test
```

Requires **Bun ≥ 1.3** — package manager, task runner, bundler, *and* runtime. The shipped
binaries (`podium-server`, `podium-daemon`, `podium`) are `bun build --compile` artifacts
that run on Bun alone. Node is **not** required: the agent-bridge auto-selects `Bun.Terminal`
for PTYs under Bun and only falls back to `node-pty` if you run a dev entrypoint under Node
(`tsx`).

On macOS, install the Xcode Command Line Tools (`xcode-select --install`) — a C compiler is used
to build the bundled `abduco` session helper on first run. See `CONTRIBUTING.md` for details.

## Running Podium locally

Podium ships in two forms that share one backend — a coordinating **server** plus a
per-machine **daemon** that wraps the agent CLIs (`claude`, `codex`) over a PTY.

### Web version (browser / mobile)

All-in-one — server + daemon in one process, serving the built web UI:

```bash
bun run --filter @podium/web build              # build the web bundle the server serves
bun --conditions=@podium/source scripts/cli.ts  # server + daemon on http://localhost:18787
```

Open <http://localhost:18787> — on a phone, point the browser at the same host.

To iterate on the web UI with hot-reload, run the Vite dev server alongside the backend
(it proxies the API + WebSockets to the backend on `:18787`):

```bash
bun --conditions=@podium/source scripts/cli.ts  # terminal 1 — backend
bun run host:web                                # terminal 2 — Vite dev server on :55556
```

Then open <http://localhost:55556>.

### Desktop version (Tauri)

A native window that spawns the bun-compiled backend and serves the same web UI locally.
Requires the Rust + Tauri toolchain:

```bash
bun run --cwd apps/desktop dev      # dev: stage the compiled backend + web, open the window
bun run --cwd apps/desktop build    # release build
```
