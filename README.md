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
| `apps/server` | API / web backend (Hono + tRPC, Node). |
| `apps/daemon` | Per-machine agent host; wraps CLIs via `@podium/agent-bridge`. |
| `apps/web` | Responsive web UI (React + Vite). |
| `packages/protocol` | ★ Shared agent/terminal wire protocol. |
| `packages/agent-bridge` | ★ Coding-agent CLI process wrapper (Node). |
| `packages/terminal-client` | ★ Browser terminal presentation client. |
| `packages/core` | Internal domain model + zod schemas. |
| `tooling/tsconfig` | Shared TypeScript base configs. |

★ = published to npm under `@podium/*`. See `ARCHITECTURE.md` for what-goes-where and the
growth path, and `CONTRIBUTING.md` for setup.

## Quick start

```bash
bun install
bun run typecheck
bun run build      # builds the publishable libraries
bun run lint
bun run test
```

Requires Bun ≥ 1.3 and Node 22 (see `.nvmrc`).
