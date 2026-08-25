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
  sessions don't survive a daemon restart. `tmux` is used as a fallback, or set
  `PODIUM_ABDUCO=/path/to/abduco` to point at a prebuilt binary.
- (Optional) **Rust + Tauri CLI** — only needed to build the desktop app (`apps/desktop`); the
  desktop build runs a preflight that checks for it.

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
bun run --cwd apps/desktop build                # release build (.app/.dmg on macOS, deb/AppImage on Linux)
```

## Everyday commands

| Command | What it does |
|---------|--------------|
| `bun run host` | Run the full app locally — web (:55556) + backend (:18787). Open http://localhost:55556. |
| `bun run typecheck` | `tsc --noEmit` across every workspace. |
| `bun run build` | Builds the publishable libraries (`packages/*`) with tsup. Not required to run the app. |
| `bun run dev` | Watch-build the publishable libraries (this does **not** start the app — use `bun run host`). |
| `bun run test` | The full test suite: vitest across every workspace (web under happy-dom) + the bun-only suites. Needs a real Node ≥ 22 on PATH (never symlink `node`→`bun`) — see [Testing](#testing) below. |
| `bun run lint` | Biome check. |
| `bun run format` | Biome format (writes). |
| `bun run --filter <name> <script>` | Run one workspace's script, e.g. `bun run --filter @podium/protocol build`. |

## Testing

The whole suite runs with one command from the repo root:

```bash
bun run test    # vitest (all workspaces, web under happy-dom) + the bun-only suites
```

Prerequisites: **Bun ≥ 1.3.14** and a real **Node ≥ 22** on PATH. Vitest runs under Node —
do NOT symlink `node` → `bun`; Bun's Node shim breaks vitest's CJS interop (symptoms:
`z.string is not a function`, `DOMPurify.sanitize is undefined`, `document is not defined`
across hundreds of files).

Some tests self-skip when their machine setup is absent (they never fail for it):

- `apps/cli/src/podium-update.test.ts` swap tests — need the operator's signing key
  (`apps/cli/src/.podium-update-dev.key`, the private half of `PODIUM_UPDATE_PUBKEY`).
- `packages/pty/test/harness-smoke/claude-smoke.test.ts` — needs `claude` on PATH
  with `$HOME` already trusted (run `claude` once in `$HOME` and accept the prompt), or
  set `PODIUM_SKIP_CLAUDE_SMOKE=1`.
- `packages/harness/src/opencode/*` detection tests expect the `opencode` CLI at
  `~/.opencode/bin/opencode`.

Browser E2E (Playwright, headless Chromium; builds protocol + web, then boots the real
relay/daemon harness):

```bash
bunx playwright install chromium         # once per machine
cd tests/e2e && NODE_OPTIONS="--conditions=@podium/source" bunx playwright test --project=chromium-desktop
```

The `NODE_OPTIONS` condition is required so Playwright's loader resolves workspace
packages from source instead of (possibly unbuilt) `dist/`.

## Adding a package

1. Create `packages/<name>/` (or `apps/<name>/`) with a `package.json` named `@podium/<name>`.
2. Add `src/index.ts`, a `tsconfig.json` extending the right base from `tooling/tsconfig`
   (`node` / `dom` / `react` / `base`), a `typecheck` script, and a `README.md`.
3. Publishable libraries also add `tsup.config.ts`, a `build` script, `exports` → `dist`,
   `"files": ["dist"]`, and `"publishConfig": { "access": "public" }`. Internal packages
   set `"private": true` and resolve `exports` → `src`.

   Note: the `@podium/*` library packages are currently consumed **in-repo only** — none of
   them are published to npm, even the ones structured as "publishable".
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

### Rolling the Bun linker back to hoisted

An isolated install creates `node_modules` trees inside individual workspaces. Removing only the
root install leaves those trees available to resolution after a rollback. From the checkout being
rolled back, first restore `bunfig.toml` to `linker = "hoisted"`, stop processes using that
checkout's dependencies, and preview the cleanup:

```bash
bun scripts/clean-workspace-installs.ts --dry-run
```

Then run the Stage 1 rollback command:

```bash
bun run deps:rollback-hoisted
```

The command removes every `node_modules` entry in this checkout, including workspace-local ones,
then runs `bun install --frozen-lockfile --linker=hoisted`. The cleanup anchors itself to the
checkout containing the script rather than the shell's current directory. It does not descend
through symlinks; a symlink named `node_modules` is unlinked without touching its target. It never
runs a Bun cache-cleaning command, so the shared cache outside the repository remains available to
the reinstall. A cleanup or install error stops the chain; do not start the checkout against a
partial install—fix the error and rerun the rollback command.

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
