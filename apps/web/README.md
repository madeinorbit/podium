# @podium/web

Podium's responsive web UI — mobile is a first-class citizen. **React + Vite.** Hosts the
command center (dev / product / spec modes), renders live agent terminals via
`@podium/terminal-client`, and calls the backend through a tRPC client that imports the
`AppRouter` *type* from `@podium/server`.

Skeleton only — the Vite application itself is intentionally not scaffolded yet. Intended
runtime dependencies (added when implementation begins): `react`, `react-dom`, `vite`,
`@vitejs/plugin-react`, `@trpc/client`.

Future native/desktop clients (`apps/mobile` via Expo, `apps/desktop` via Tauri) will
reuse `@podium/terminal-client`'s framework-agnostic core — see `ARCHITECTURE.md`.
