# Contributing

## Prerequisites

- **Bun ≥ 1.3** — package manager, task runner, bundler, **and the runtime**. The backend runs on
  Bun from source (the `@podium/source` condition resolves workspace packages to `src`), and the
  PTY backend is selected at runtime — `Bun.Terminal` under Bun, so the `node-pty` native addon is
  never loaded. (Node 22 is only needed for the legacy `tsx`/single-binary paths; `.nvmrc` pins it
  for those.)
- **macOS:** Xcode Command Line Tools (`xcode-select --install`). A C compiler (`cc`/clang) compiles
  the vendored `abduco` session helper into `~/.podium/bin/` on first daemon start; without it,
  sessions don't survive a daemon restart. `tmux` is used as a fallback, or set
  `PODIUM_ABDUCO=/path/to/abduco` to point at a prebuilt binary.

## Setup

```bash
bun install
```

## Run locally

```bash
bun run host          # web UI (Vite :55556) + backend (relay + daemon :18787), Bun from source
```

Open **http://localhost:55556**. The Vite dev server proxies `/trpc`, `/health`, `/files`,
`/client`, and `/daemon` to the backend on :18787. No `bun run build` is required first. To run the
halves separately use `bun run host:web` and `bun run host:backend`. (The split `scripts/server.ts`
+ `scripts/daemon.ts` processes are the production topology — see `scripts/systemd/`.) The
`:55555` tailscale URL in `docs/agents/driving-podium.md` is the maintainer's remote instance, not
your local dev.

Override defaults with env vars when needed: `PODIUM_PORT` (backend, default 18787),
`PODIUM_WEB_PORT` (web, default 55556), `PODIUM_ALLOWED_HOSTS` (comma-separated Vite allowed hosts).

## Everyday commands

| Command | What it does |
|---------|--------------|
| `bun run host` | Run the full app locally — web (:55556) + backend (:18787). Open http://localhost:55556. |
| `bun run typecheck` | `tsc --noEmit` across every workspace. |
| `bun run build` | Builds the publishable libraries (`packages/*`) with tsup. Not required to run the app. |
| `bun run dev` | Watch-build the publishable libraries (this does **not** start the app — use `bun run host`). |
| `bun run test` | Runs Vitest. |
| `bun run lint` | Biome check. |
| `bun run format` | Biome format (writes). |
| `bun run --filter <name> <script>` | Run one workspace's script, e.g. `bun run --filter @podium/protocol build`. |

## Adding a package

1. Create `packages/<name>/` (or `apps/<name>/`) with a `package.json` named `@podium/<name>`.
2. Add `src/index.ts`, a `tsconfig.json` extending the right base from `tooling/tsconfig`
   (`node` / `dom` / `react` / `base`), a `typecheck` script, and a `README.md`.
3. Publishable libraries also add `tsup.config.ts`, a `build` script, `exports` → `dist`,
   `"files": ["dist"]`, and `"publishConfig": { "access": "public" }`. Internal packages
   set `"private": true` and resolve `exports` → `src`.
4. Run `bun install`, then `bun run --filter @podium/<name> typecheck`.

## Toolchain notes

- **Adding a dependency to a specific workspace:** run `bun add` from INSIDE that
  package's directory (`cd packages/<name> && bun add -d <dep>`). In Bun 1.3, `bun add
  --filter` resolves names against the npm registry and fails for workspace-internal
  packages. Internal workspace dependencies are written directly into `package.json` as
  `"@podium/<name>": "workspace:*"`.
- **`ignoreDeprecations: "6.0"` in publishable libs' tsconfig:** tsup 8.5's declaration
  step passes a `baseUrl` to the TypeScript 6 compiler, which TS 6 rejects as deprecated
  (TS5101). The shim suppresses it. Remove it once tsup no longer injects `baseUrl`.

## Cross-package imports

Published workspace libraries expose a local `"@podium/source": "./src/index.ts"`
export condition, and the shared TypeScript/Vitest config resolves that condition during
development. This lets typecheck and tests use source without requiring a prior build,
while normal package consumers still resolve the published `dist` output.

## Releasing the libraries

Public libraries (`@podium/protocol`, `@podium/agent-bridge`, `@podium/terminal-client`)
are versioned with Changesets:

```bash
bun run changeset          # describe the change
bun run version-packages   # apply version bumps + changelogs
bun run release            # build + publish
```
