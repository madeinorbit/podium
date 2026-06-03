# Contributing

## Prerequisites

- Bun ≥ 1.3 (package manager, task runner, bundler)
- Node 22 (runtime for `apps/server` and `apps/daemon`; see `.nvmrc`)

## Setup

```bash
bun install
```

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
