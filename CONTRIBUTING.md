# Contributing

## License

Podium is licensed under the [Apache License 2.0](./LICENSE). By submitting a contribution (a pull
request, patch, or any other content), you agree that your contribution is licensed to the project
and its users under the Apache License 2.0 — the same license as the project (GitHub's default
"inbound = outbound"). You keep the copyright to your contribution. There is no CLA to sign and no
bot: just open a pull request.

## Prerequisites

- **Bun ≥ 1.3.14** — package manager, task runner, bundler, **and the runtime**. Source-only
  tools use the `@podium/source` condition to resolve workspace packages to `src`; the normal live
  development backend runs from an installed Bun-compiled bundle. Agent PTYs use
  `Bun.Terminal`.
- **macOS:** Xcode Command Line Tools (`xcode-select --install`). A C compiler (`cc`/clang) compiles
  the vendored `abduco` session helper into `~/.podium/bin/` on first daemon start; without it,
  sessions don't survive a daemon restart. Set `PODIUM_ABDUCO=/path/to/abduco` to point at a
  prebuilt binary instead.
- **Windows desktop:** Microsoft C++ Build Tools with the "Desktop development with C++"
  workload, Microsoft Edge WebView2, and the Rust MSVC host toolchain. Windows sessions use
  ConPTY, so they do not need the POSIX `abduco` compiler prerequisite.
- (Optional) **Rust + Tauri CLI** — only needed to build the desktop app (`apps/desktop`); the
  desktop build runs a preflight that checks for it.

## Setup

```bash
bun run setup:worktree
```

This runs `bun install --frozen-lockfile` and follows the linker setting tracked in `bunfig.toml`:
strict isolated linking backed by Bun's global store. Each checkout keeps its own
`node_modules` link graph while immutable package payloads are reused across worktrees. Never
share, copy, symlink, or bind-mount a complete `node_modules` tree between checkouts.

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

`bun run host` is an isolated source sandbox, not the persistent development deployment. The live
development host runs `~/.local/bin/podium` from its installed bundle and sets
`PODIUM_DEV_SOURCE_ROOT` to this checkout so the installed server can mint its successor. That
keeps packaging, swap, handover, and rollback in the everyday loop. Production installs omit the
variable and cannot become publishers.

### Changing the UI on a machine that is already running Podium

`bun run host` starts a *second* instance with its own empty state, which is the right thing on
a laptop and the wrong one on a server whose data and agent sessions are the point. There,
`bun run iterate` serves the web UI from source with hot reload in front of the **installed**
server, on its own ports, writing no `dist` and offering no update — see
[docs/iteration-mode.md](./docs/iteration-mode.md). It covers the web UI only; server-side
changes go out as a normal dev release.

### Desktop app (Tauri)

A native window that spawns the bun-compiled backend and serves the same web UI locally. Needs the
Rust + Tauri toolchain (the build runs a preflight that checks for it):

```bash
bun run --cwd apps/desktop dev                  # dev: stage the compiled backend + web, open the window
bun run --cwd apps/desktop build                # release build (.app/.dmg, deb/AppImage, or Windows installer)
```

## Everyday commands

| Command | What it does |
|---------|--------------|
| `bun run host` | Run the full app locally — web (:55556) + backend (:18787). Open http://localhost:55556. |
| `bun run typecheck` | `tsc --noEmit` across every workspace. |
| `bun run build` | Builds the publishable libraries (`packages/*`) with tsup. Not required to run the app. |
| `bun run dev` | Watch-build the publishable libraries (this does **not** start the app — use `bun run host`). |
| `bun run test` | The normal cached gate: lock-free typecheck plus a small one-worker boot/configuration probe — see the verification guidance below. |
| `bun run lint` | Biome check. |
| `bun run format` | Biome format (writes). |
| `bun run --filter <name> <script>` | Run one workspace's script, e.g. `bun run --filter @podium/protocol build`. |

## Verification

The normal end-of-task check is the cached gate:

```bash
bun run test
```

It runs lock-free typecheck and a small, one-worker boot/configuration probe. The typecheck
admits the install topology and workspace-resolution census before Turbo can reuse or create a
result.

For a narrow change, choose one focused lane that matches the risk, such as
`bun run test:related -- <test-file>`, `bun run test:changed`, `bun run test:web`,
`bun run test:mobile`, or the applicable server shard. Keep focused lanes targeted; do not run
the exhaustive `bun run test:full`, `bun run test:unit`, or `bun run oracle` as routine contributor
verification. Use those only for scheduled CI, merge/release validation, or an explicit request.

Do not bypass cache admission with `--force`, `TURBO_FORCE`, or write-only `--cache` flags. If a
real cache-key gap is found, document it and use the existing reasoned `--uncached-because` escape
only as an explicit exception while the gap is fixed.

## Adding a package

1. Create `packages/<name>/` (or `apps/<name>/`) with a `package.json` named `@podium/<name>`.
2. Add `src/index.ts`, a `tsconfig.json` extending the right base from `tooling/tsconfig`
   (`node` / `dom` / `react` / `base`), a `typecheck` script, and a `README.md`.
3. Publishable libraries also add `tsup.config.ts`, a `build` script, `exports` → `dist`,
   `"files": ["dist"]`, and `"publishConfig": { "access": "public" }`. Internal packages
   set `"private": true` and resolve `exports` → `src`.

   Note: the `@podium/*` library packages are currently consumed **in-repo only** — none of
   them are published to npm, even the ones structured as "publishable".
4. Run `bun run setup:worktree`, then `bun run --filter @podium/<name> typecheck`.

## Toolchain notes

- **Adding a dependency to a specific workspace:** run `bun add` from INSIDE that
  package's directory (`cd packages/<name> && bun add -d <dep>`). In Bun 1.3, `bun add
  --filter` resolves names against the npm registry and fails for workspace-internal
  packages. Internal workspace dependencies are written directly into `package.json` as
  `"@podium/<name>": "workspace:*"`.
- **`ignoreDeprecations: "6.0"` in publishable libs' tsconfig:** tsup 8.5's declaration
  step passes a `baseUrl` to the TypeScript 6 compiler, which TS 6 rejects as deprecated
  (TS5101). The shim suppresses it. Remove it once tsup no longer injects `baseUrl`.

### Checkout-local dependency workflow

Every git checkout or worktree owns its dependency tree. Never share, copy, symlink, or bind-mount a
complete `node_modules` tree between checkouts. The supported path uses strict isolated linking:
the link graph belongs to the checkout while Bun's global store shares immutable package payloads.
The tracked `hoist = false` keeps undeclared dependencies unavailable instead of masking them
through a fallback hoist.

For a fresh checkout, run:

```bash
bun run setup:worktree
```

If this checkout's dependency tree is damaged or out of sync with the lockfile, stop processes
using it and run:

```bash
bun run deps:repair
```

`deps:repair` first runs the checkout-scoped cleanup, which removes every `node_modules` entry
under this checkout without following directory symlinks, then runs `bun install --frozen-lockfile`
according to the tracked `bunfig.toml` setting. A cleanup or install error stops the chain; fix the
error and rerun the repair before starting the checkout.

Neither command deletes Bun or Turbo caches. The cleanup is anchored to the checkout containing
the script, and the reinstall may reuse or populate the shared Bun cache but does not remove it.
Never add `bun pm cache rm`, delete `~/.bun/install/cache` (or the configured global Bun cache), or
delete the shared Turbo cache to a repair procedure.

## Cross-package imports

Published workspace libraries expose a local `"@podium/source": "./src/index.ts"`
export condition, and the shared TypeScript/Vitest config resolves that condition during
development. This lets typecheck and tests use source without requiring a prior build,
while normal package consumers still resolve the published `dist` output.

## Releasing the libraries

Public libraries (`@podium/protocol`, `@podium/harness`, `@podium/pty`, `@podium/terminal-client`)
are versioned with Changesets:

```bash
bun run changeset          # describe the change
bun run version-packages   # apply version bumps + changelogs
bun run release            # build + publish
```
