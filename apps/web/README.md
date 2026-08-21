# @podium/web

Podium's responsive web UI (React + Vite). The installed server serves the built
`dist` same-origin with `/trpc` and the WebSockets. Mobile is a first-class
layout of the same app; Expo native is `apps/mobile`.

## Commands

| Command | What it does |
| --- | --- |
| `bun run --filter @podium/web build` | Production `dist` (what the installed server serves) |
| `bun run --filter @podium/web dev` | Vite alone (used by `bun run host` / iterate) |
| `bun run iterate` (repo root) | **VPS iteration mode** — HMR beside the live server; see [`docs/iteration-mode.md`](../../docs/iteration-mode.md) |
| `bun run host` (repo root) | Local all-in-one: Vite + source `scripts/host.ts` backend |

Do not use the Vite origin as the live VPS UI path. Live traffic hits the
installed server's served `dist` (typically via Tailscale `:55555` → `:18787`).
