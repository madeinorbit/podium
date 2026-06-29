# Architecture

Podium is a Bun-workspace monorepo. Design rationale lives in
`docs/superpowers/specs/2026-06-01-monorepo-design.md`; this file is the day-to-day map.

## Runtime topology

- **`apps/server`** — API / web backend (Hono + tRPC). Can run apart from dev machines.
- **`apps/daemon`** — installed on each dev machine; wraps agent CLIs and streams PTYs.
- **`apps/web`** — responsive web UI (mobile-first), talks to the server.
- Later: cloud sandboxes for agents.

## Packages

`@podium/agent-bridge` (server-side) and `@podium/terminal-client` (browser) are the two
standalone libraries. They never depend on each other — they meet only through
`@podium/protocol`. This keeps the PTY layer and browser DOM code out of the same
package and lets each release independently.

## Dependency direction

```
@podium/web              ->  @podium/terminal-client, @podium/core
@podium/web              ~>  @podium/server   (type-only AppRouter; planned, no runtime dep)
@podium/server           ->  @podium/core, @podium/protocol
@podium/daemon           ->  @podium/agent-bridge, @podium/protocol, @podium/core
@podium/agent-bridge     ->  @podium/protocol
@podium/terminal-client  ->  @podium/protocol
@podium/protocol         ->  (leaf — no internal deps)
@podium/core             ->  (leaf — no internal deps)
```

- Apps depend on packages, never the reverse.
- No app→app runtime dependency; `apps/web` imports only the `AppRouter` *type* from
  `apps/server`.
- `@podium/protocol` and `@podium/core` are leaf packages.

## What goes where

| Working on… | Lives in… |
|-------------|-----------|
| PTY/tmux spawn, attach, resize, kill | `@podium/agent-bridge` |
| Harness / recent-conversation / project / worktree discovery | `@podium/agent-bridge` (used by `apps/daemon`) |
| Agent state detection (provider interface, reducer, per-agent providers) | `@podium/agent-bridge` `src/agent-state/`; HTTP hook ingest + spawn injection in `apps/daemon` |
| Browser↔server message types (input, output frame, resize, takeover, transcript) | `@podium/protocol` |
| xterm.js, mobile key toolbar, touch/scroll policy, reconnect | `@podium/terminal-client` |
| Domain entities + zod schemas | `@podium/core` |
| tRPC routers, auth, persistence, conversation index, daemon fan-out | `apps/server` |
| React screens, command-center grid, modes | `apps/web` |
| Per-machine agent lifecycle + discovery orchestration | `apps/daemon` |
| Shared TS config | `tooling/tsconfig` |
| Design/architecture docs | `docs/` |

## Growth path (not yet scaffolded)

- `apps/mobile` — Expo / React Native (+ RN Web).
- `apps/desktop` — Tauri shell.
- Cloud-sandbox orchestrator service.
- `@podium/ui` — shared design system once web + native both consume it.
- `@podium/terminal-client-react` — React adapter split out of `terminal-client`.
- `@podium/conversation-index` — hybrid search over indexed sessions.
- TS project references + Turborepo caching, and a `@podium/source` export condition for
  source-level cross-package imports, added when build/typecheck time or imports warrant.

## Toolchain

Bun (package manager / task runner / bundler / **runtime** — `server`/`daemon` run on Bun from
source via the `@podium/source` condition; the PTY backend is runtime-selected, so `Bun.Terminal`
is used under Bun and `node-pty` is never loaded) · Node 22 only for the legacy `tsx`/single-binary
paths · TypeScript ESM-only · Biome (lint+format) · Vitest · tsup (library builds) · Changesets
(releases). Cross-workspace tasks run via `bun run --filter`.
