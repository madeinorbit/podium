# Contributing

## Prerequisites

- **Bun ≥ 1.3** — package manager, task runner, bundler, *and* runtime. This is the only
  hard requirement; the shipped `podium-server` / `podium-daemon` / `podium` binaries are
  `bun build --compile` artifacts that run on Bun.
- (Optional) **Rust + Tauri CLI** — only needed to build the desktop app (`apps/desktop`).

Node is **not** a prerequisite. The PTY backend (`@podium/agent-bridge`) auto-selects
`Bun.Terminal` under Bun and only falls back to `node-pty` when a dev entrypoint is run
under Node (`tsx`). Persistence likewise resolves `bun:sqlite` vs `node:sqlite` per runtime.

## Setup

```bash
bun install
```

## Running locally

The backend is a coordinating **server** plus a per-machine **daemon**. The simplest local
run is all-in-one (server + daemon in one process):

```bash
bun run --filter @podium/web build              # build the web UI the server serves
bun --conditions=@podium/source scripts/cli.ts  # server + daemon on http://localhost:18787
```

The `--conditions=@podium/source` flag resolves the `@podium/*` workspace packages to their
TypeScript source, so you don't need a prior library build to run from source.

For the **web** UI with hot-reload, run the Vite dev server (`:55556`) against the backend —
it proxies the API + WebSockets to `:18787`:

```bash
bun --conditions=@podium/source scripts/cli.ts  # terminal 1 — backend
bun run host:web                                # terminal 2 — Vite dev server
```

For the **desktop** app, use the Tauri workspace (needs the Rust + Tauri toolchain):

```bash
bun run --cwd apps/desktop dev                  # dev window
bun run --cwd apps/desktop build                # release build
```

> `bun run host` is a one-command shortcut that starts the Vite dev server *and* the
> combined server + daemon backend (`scripts/host.ts`) together, both on Bun with
> `--watch` for auto-restart on edit. `bun run host:web` / `host:backend` run each half
> on its own.

## Everyday commands

| Command | What it does |
|---------|--------------|
| `bun run typecheck` | `tsc --noEmit` across every workspace. |
| `bun run build` | Builds the publishable libraries (`packages/*`) with tsup. |
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
