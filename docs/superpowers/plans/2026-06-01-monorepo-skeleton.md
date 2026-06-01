# Podium Monorepo Skeleton Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stand up the Podium TypeScript monorepo skeleton — workspaces, tooling, the package/app directory layout, and the documentation that says what goes where — with no feature code or stubbed functions inside any package.

**Architecture:** Bun workspaces under `apps/*`, `packages/*`, `tooling/*`. Three publishable libraries (`@podium/protocol`, `@podium/agent-bridge`, `@podium/terminal-client`) plus an internal `@podium/core`, consumed by three apps (`server`, `daemon`, `web`). Approach A from the design spec: a Node-side process wrapper and a browser-side presentation client never share a package — they meet only through the shared protocol.

**Tech Stack:** Bun (package manager + task runner + bundler) · Node 22 (runtime for PTY-touching apps, via `tsx`) · TypeScript (ESM-only) · Biome (lint + format) · Vitest (tests) · tsup (library builds) · Changesets (releases). Hono + tRPC and node-pty/xterm.js are the *intended* runtime libraries but are **not installed in this skeleton** — only documented.

**Source spec:** `docs/superpowers/specs/2026-06-01-monorepo-design.md`

---

## Conventions used in every package

- Every workspace gets a `src/index.ts` that is **only** a package doc-comment plus `export {}` — this is the build/typecheck entry, not a feature stub.
- Every workspace defines a `typecheck` script (`tsc --noEmit`) so `bun run --filter '*' typecheck` covers all of them.
- Published libraries (`★`) additionally define `build`/`dev` via tsup and resolve their public entry to `dist/`.
- Internal packages/apps set `"private": true` and resolve their entry to `src/` (consumed as TypeScript source).
- Dependencies are added with `bun add` so versions are resolved by Bun, never hand-invented.

**Notes / conscious deviations from the spec, recorded here so they aren't silent:**
- **TS project references are deferred** (spec §3 listed them). Empty packages gain nothing from incremental reference builds, and `composite` emit conflicts with tsup. We use per-package `tsc --noEmit`; cross-package types resolve through Bun's workspace symlinks. Revisit when typecheck time grows (added to the future list in ARCHITECTURE.md).
- **A `@podium/source` export condition for source-level cross-package imports is deferred** because no package imports another yet (all `src/` are empty). CONTRIBUTING.md documents adding it when the first real cross-package import lands.

---

## Task 1: Repository root — workspaces, tooling, gitignore

**Files:**
- Create: `/home/user/src/other/podium/.gitignore`
- Create: `/home/user/src/other/podium/.nvmrc`
- Create: `/home/user/src/other/podium/bunfig.toml`
- Create: `/home/user/src/other/podium/package.json`
- Create: `/home/user/src/other/podium/biome.json`
- Create: `/home/user/src/other/podium/vitest.config.ts`
- Create: `/home/user/src/other/podium/tsconfig.json`

- [ ] **Step 1: Create `.gitignore`**

```gitignore
node_modules/
dist/
coverage/
*.tsbuildinfo
*.log
.DS_Store
.env
.env.*
!.env.example
.turbo/
```

- [ ] **Step 2: Create `.nvmrc`**

```
22
```

- [ ] **Step 3: Create `bunfig.toml`**

```toml
# Bun configuration — https://bun.sh/docs/runtime/bunfig
# Workspace packages are symlinked into node_modules automatically.
[install]
exact = false
```

- [ ] **Step 4: Create root `package.json`**

```json
{
  "name": "podium",
  "private": true,
  "type": "module",
  "packageManager": "bun@1.3.13",
  "engines": {
    "node": ">=22",
    "bun": ">=1.3"
  },
  "workspaces": [
    "apps/*",
    "packages/*",
    "tooling/*"
  ],
  "scripts": {
    "build": "bun run --filter './packages/*' build",
    "dev": "bun run --filter './packages/*' dev",
    "typecheck": "bun run --filter '*' typecheck",
    "test": "vitest run --passWithNoTests",
    "lint": "biome check .",
    "format": "biome format --write .",
    "changeset": "changeset",
    "version-packages": "changeset version",
    "release": "bun run build && changeset publish"
  }
}
```

- [ ] **Step 5: Install root dev tooling**

Run:
```bash
cd /home/user/src/other/podium
bun add -d typescript @types/node tsx vitest @biomejs/biome @changesets/cli tsup
```
Expected: command succeeds; `package.json` gains a `devDependencies` block; `bun.lock` is created.

- [ ] **Step 6: Create `biome.json`, then align its schema to the installed version**

Create `biome.json`:
```json
{
  "$schema": "https://biomejs.dev/schemas/2.0.0/schema.json",
  "vcs": {
    "enabled": true,
    "clientKind": "git",
    "useIgnoreFile": true
  },
  "files": {
    "ignoreUnknown": true
  },
  "formatter": {
    "enabled": true,
    "indentStyle": "space",
    "indentWidth": 2,
    "lineWidth": 100
  },
  "linter": {
    "enabled": true,
    "rules": {
      "recommended": true
    }
  },
  "javascript": {
    "formatter": {
      "quoteStyle": "single",
      "semicolons": "asNeeded"
    }
  }
}
```
Then run (updates the `$schema` URL and any renamed keys to match the installed Biome):
```bash
bunx biome migrate --write
```
Expected: exits 0 (it either migrates or reports nothing to migrate). If it errors, the config still works — Biome does not validate `$schema` at runtime.

- [ ] **Step 7: Create root `vitest.config.ts`**

```ts
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    passWithNoTests: true,
  },
})
```

- [ ] **Step 8: Create root `tsconfig.json` (editor/solution view)**

```json
{
  "extends": "./tooling/tsconfig/base.json",
  "compilerOptions": {
    "noEmit": true
  },
  "include": [],
  "exclude": ["node_modules", "dist"]
}
```
(`tooling/tsconfig/base.json` is created in Task 2; the root config is for editors and is not used by per-package typecheck.)

- [ ] **Step 9: Verify install and tools resolve**

Run:
```bash
bun install
bunx biome --version
bunx tsc --version
bunx vitest --version
```
Expected: `bun install` completes with no errors; each tool prints a version.

- [ ] **Step 10: Verify lint and test gates are green on an empty tree**

Run:
```bash
bun run lint
bun run test
```
Expected: `biome check .` reports no errors; `vitest` prints "No test files found" and exits 0 (passWithNoTests).

- [ ] **Step 11: Commit**

```bash
git add .gitignore .nvmrc bunfig.toml package.json biome.json vitest.config.ts tsconfig.json bun.lock
git commit -m "chore: bootstrap bun workspace root and tooling (biome, vitest, tsup, changesets)"
```

---

## Task 2: Shared TypeScript config package (`tooling/tsconfig`)

**Files:**
- Create: `/home/user/src/other/podium/tooling/tsconfig/package.json`
- Create: `/home/user/src/other/podium/tooling/tsconfig/base.json`
- Create: `/home/user/src/other/podium/tooling/tsconfig/node.json`
- Create: `/home/user/src/other/podium/tooling/tsconfig/dom.json`
- Create: `/home/user/src/other/podium/tooling/tsconfig/react.json`
- Create: `/home/user/src/other/podium/tooling/tsconfig/README.md`

- [ ] **Step 1: Create `tooling/tsconfig/package.json`**

```json
{
  "name": "@podium/tsconfig",
  "version": "0.0.0",
  "private": true,
  "files": ["*.json"]
}
```

- [ ] **Step 2: Create `tooling/tsconfig/base.json`**

```json
{
  "$schema": "https://json.schemastore.org/tsconfig",
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "lib": ["ES2023"],
    "types": [],
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "noImplicitOverride": true,
    "noFallthroughCasesInSwitch": true,
    "verbatimModuleSyntax": true,
    "isolatedModules": true,
    "esModuleInterop": true,
    "resolveJsonModule": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "declaration": true,
    "noEmit": true
  }
}
```

- [ ] **Step 3: Create `tooling/tsconfig/node.json`**

```json
{
  "extends": "./base.json",
  "compilerOptions": {
    "types": ["node"]
  }
}
```

- [ ] **Step 4: Create `tooling/tsconfig/dom.json`**

```json
{
  "extends": "./base.json",
  "compilerOptions": {
    "lib": ["ES2023", "DOM", "DOM.Iterable"]
  }
}
```

- [ ] **Step 5: Create `tooling/tsconfig/react.json`**

```json
{
  "extends": "./dom.json",
  "compilerOptions": {
    "jsx": "react-jsx"
  }
}
```

- [ ] **Step 6: Create `tooling/tsconfig/README.md`**

```markdown
# @podium/tsconfig

Shared TypeScript base configurations for the monorepo.

- `base.json` — strict, ESM, bundler resolution; environment-agnostic.
- `node.json` — `base` + Node types. For `apps/server`, `apps/daemon`, `@podium/agent-bridge`.
- `dom.json` — `base` + DOM libs. For `@podium/terminal-client`.
- `react.json` — `dom` + `react-jsx`. For `apps/web`.

Packages extend these by relative path, e.g. `"extends": "../../tooling/tsconfig/node.json"`.
```

- [ ] **Step 7: Verify the workspace sees the package**

Run:
```bash
cd /home/user/src/other/podium
bun install
bun pm ls 2>/dev/null | grep -i "@podium/tsconfig" || echo "linked (name present in workspace)"
```
Expected: `bun install` succeeds; `@podium/tsconfig` is recognized as a workspace member.

- [ ] **Step 8: Commit**

```bash
git add tooling/tsconfig bun.lock
git commit -m "chore(tooling): add shared tsconfig bases (base/node/dom/react)"
```

---

## Task 3: `@podium/protocol` (published library)

**Files:**
- Create: `/home/user/src/other/podium/packages/protocol/package.json`
- Create: `/home/user/src/other/podium/packages/protocol/tsconfig.json`
- Create: `/home/user/src/other/podium/packages/protocol/tsup.config.ts`
- Create: `/home/user/src/other/podium/packages/protocol/src/index.ts`
- Create: `/home/user/src/other/podium/packages/protocol/README.md`

- [ ] **Step 1: Create `packages/protocol/package.json`**

```json
{
  "name": "@podium/protocol",
  "version": "0.0.0",
  "description": "Wire protocol types for Podium agent/terminal sessions (output frames, input, resize, takeover, transcript).",
  "license": "MIT",
  "type": "module",
  "main": "./dist/index.js",
  "module": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "import": "./dist/index.js"
    }
  },
  "files": ["dist"],
  "publishConfig": {
    "access": "public"
  },
  "scripts": {
    "build": "tsup",
    "dev": "tsup --watch",
    "typecheck": "tsc --noEmit",
    "clean": "rm -rf dist"
  }
}
```

- [ ] **Step 2: Add the build dev-dependencies**

Run:
```bash
cd /home/user/src/other/podium
bun add -d --filter @podium/protocol tsup typescript
```
Expected: `tsup` and `typescript` appear under `packages/protocol/package.json` `devDependencies`.

- [ ] **Step 3: Create `packages/protocol/tsconfig.json`**

```json
{
  "extends": "../../tooling/tsconfig/base.json",
  "compilerOptions": {
    "outDir": "dist",
    "rootDir": "src"
  },
  "include": ["src"]
}
```

- [ ] **Step 4: Create `packages/protocol/tsup.config.ts`**

```ts
import { defineConfig } from 'tsup'

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  dts: true,
  clean: true,
  sourcemap: true,
  treeshake: true,
})
```

- [ ] **Step 5: Create `packages/protocol/src/index.ts`**

```ts
/**
 * @podium/protocol
 *
 * Shared, dependency-light wire types for the agent/terminal session protocol
 * exchanged between the server/daemon side ({@link @podium/agent-bridge}) and the
 * browser side ({@link @podium/terminal-client}): output frames, input events,
 * resize, controller/spectator takeover, session lifecycle, and transcript.
 *
 * Skeleton only — no protocol types are defined yet.
 */
export {}
```

- [ ] **Step 6: Create `packages/protocol/README.md`**

```markdown
# @podium/protocol

The wire protocol shared by Podium's agent process wrapper and its browser terminal
client. Defines the message types that cross the network boundary: output frames, input
events, resize, controller/spectator takeover, session lifecycle, and transcript.

Published to npm. Both `@podium/agent-bridge` (Node) and `@podium/terminal-client`
(browser) depend on it; they never depend on each other.
```

- [ ] **Step 7: Verify typecheck and build**

Run:
```bash
cd /home/user/src/other/podium
bun run --filter @podium/protocol typecheck
bun run --filter @podium/protocol build
ls packages/protocol/dist
```
Expected: typecheck passes; build emits `index.js` and `index.d.ts` into `packages/protocol/dist`.

- [ ] **Step 8: Commit**

```bash
git add packages/protocol bun.lock package.json
git commit -m "feat(protocol): scaffold @podium/protocol library (no types yet)"
```

---

## Task 4: `@podium/core` (internal domain package)

**Files:**
- Create: `/home/user/src/other/podium/packages/core/package.json`
- Create: `/home/user/src/other/podium/packages/core/tsconfig.json`
- Create: `/home/user/src/other/podium/packages/core/src/index.ts`
- Create: `/home/user/src/other/podium/packages/core/README.md`

- [ ] **Step 1: Create `packages/core/package.json`** (internal → resolves to source, no build)

```json
{
  "name": "@podium/core",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "exports": {
    ".": {
      "types": "./src/index.ts",
      "import": "./src/index.ts"
    }
  },
  "scripts": {
    "typecheck": "tsc --noEmit"
  }
}
```

- [ ] **Step 2: Add the typecheck dev-dependency**

Run:
```bash
cd /home/user/src/other/podium
bun add -d --filter @podium/core typescript
```
Expected: `typescript` added under `packages/core/package.json` `devDependencies`.

- [ ] **Step 3: Create `packages/core/tsconfig.json`**

```json
{
  "extends": "../../tooling/tsconfig/base.json",
  "include": ["src"]
}
```

- [ ] **Step 4: Create `packages/core/src/index.ts`**

```ts
/**
 * @podium/core
 *
 * Internal domain model and zod schemas shared across Podium apps: Project, Repo,
 * Worktree, Session, Stream, Task, AgentKind, Machine, and related types. Consumed as
 * TypeScript source by the apps; not published.
 *
 * Skeleton only — no entities are defined yet.
 */
export {}
```

- [ ] **Step 5: Create `packages/core/README.md`**

```markdown
# @podium/core

Internal domain model for Podium: the entity types and zod schemas (Project, Repo,
Worktree, Session, Stream, Task, AgentKind, Machine, …) shared by `apps/server`,
`apps/daemon`, and `apps/web`.

Not published. Consumed as TypeScript source via Bun workspace symlinks.
```

- [ ] **Step 6: Verify typecheck**

Run:
```bash
cd /home/user/src/other/podium
bun run --filter @podium/core typecheck
```
Expected: passes with no output errors.

- [ ] **Step 7: Commit**

```bash
git add packages/core bun.lock
git commit -m "feat(core): scaffold internal @podium/core domain package (no entities yet)"
```

---

## Task 5: `@podium/agent-bridge` (published library, Node)

**Files:**
- Create: `/home/user/src/other/podium/packages/agent-bridge/package.json`
- Create: `/home/user/src/other/podium/packages/agent-bridge/tsconfig.json`
- Create: `/home/user/src/other/podium/packages/agent-bridge/tsup.config.ts`
- Create: `/home/user/src/other/podium/packages/agent-bridge/src/index.ts`
- Create: `/home/user/src/other/podium/packages/agent-bridge/README.md`

- [ ] **Step 1: Create `packages/agent-bridge/package.json`** (depends on `@podium/protocol`)

```json
{
  "name": "@podium/agent-bridge",
  "version": "0.0.0",
  "description": "Wrap and drive coding-agent CLIs (Claude Code, Codex) over a PTY: spawn/attach, resize, stream output, inject input, multi-client control, transcript, discovery.",
  "license": "MIT",
  "type": "module",
  "main": "./dist/index.js",
  "module": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "import": "./dist/index.js"
    }
  },
  "files": ["dist"],
  "publishConfig": {
    "access": "public"
  },
  "dependencies": {
    "@podium/protocol": "workspace:*"
  },
  "scripts": {
    "build": "tsup",
    "dev": "tsup --watch",
    "typecheck": "tsc --noEmit",
    "clean": "rm -rf dist"
  }
}
```

- [ ] **Step 2: Add the build dev-dependencies**

Run:
```bash
cd /home/user/src/other/podium
bun add -d --filter @podium/agent-bridge tsup typescript
bun install
```
Expected: dev-deps added; `bun install` links `@podium/protocol` into `packages/agent-bridge/node_modules`.

- [ ] **Step 3: Create `packages/agent-bridge/tsconfig.json`** (Node env)

```json
{
  "extends": "../../tooling/tsconfig/node.json",
  "compilerOptions": {
    "outDir": "dist",
    "rootDir": "src"
  },
  "include": ["src"]
}
```

- [ ] **Step 4: Create `packages/agent-bridge/tsup.config.ts`**

```ts
import { defineConfig } from 'tsup'

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  dts: true,
  clean: true,
  sourcemap: true,
  treeshake: true,
})
```

- [ ] **Step 5: Create `packages/agent-bridge/src/index.ts`**

```ts
/**
 * @podium/agent-bridge
 *
 * Node library that wraps coding-agent CLIs (Claude Code, Codex) as PTY-backed
 * sessions: spawn/attach (tmux-style, no `-p`), SIGWINCH/resize, output streaming,
 * input injection, redraw protocol, controller/spectator multi-client control,
 * transcript extraction, and CLI discovery. Speaks {@link @podium/protocol}.
 *
 * Skeleton only — no implementation yet.
 */
export {}
```

- [ ] **Step 6: Create `packages/agent-bridge/README.md`**

```markdown
# @podium/agent-bridge

The coding-agent process wrapper. Runs on Node and drives native agent CLIs
(Claude Code, Codex) as PTY-backed sessions — spawning/attaching tmux-style with no
`-p` abstraction, handling resize/`SIGWINCH`, streaming output, injecting input,
managing controller/spectator multi-client control, extracting transcripts, and
discovering installed CLIs.

Published to npm. Depends only on `@podium/protocol`. Pairs with
`@podium/terminal-client` on the browser side, but never imports it.

Intended runtime dependency (added when implementation begins): `node-pty`.
```

- [ ] **Step 7: Verify typecheck and build**

Run:
```bash
cd /home/user/src/other/podium
bun run --filter @podium/agent-bridge typecheck
bun run --filter @podium/agent-bridge build
ls packages/agent-bridge/dist
```
Expected: typecheck passes; `dist/index.js` and `dist/index.d.ts` exist.

- [ ] **Step 8: Commit**

```bash
git add packages/agent-bridge bun.lock package.json
git commit -m "feat(agent-bridge): scaffold @podium/agent-bridge library (no impl yet)"
```

---

## Task 6: `@podium/terminal-client` (published library, browser)

**Files:**
- Create: `/home/user/src/other/podium/packages/terminal-client/package.json`
- Create: `/home/user/src/other/podium/packages/terminal-client/tsconfig.json`
- Create: `/home/user/src/other/podium/packages/terminal-client/tsup.config.ts`
- Create: `/home/user/src/other/podium/packages/terminal-client/src/index.ts`
- Create: `/home/user/src/other/podium/packages/terminal-client/README.md`

- [ ] **Step 1: Create `packages/terminal-client/package.json`** (depends on `@podium/protocol`)

```json
{
  "name": "@podium/terminal-client",
  "version": "0.0.0",
  "description": "Browser presentation client for Podium agent terminal sessions: xterm.js rendering, mobile key toolbar, touch/scroll policy, reconnect, multi-client, transcript view.",
  "license": "MIT",
  "type": "module",
  "main": "./dist/index.js",
  "module": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "import": "./dist/index.js"
    }
  },
  "files": ["dist"],
  "publishConfig": {
    "access": "public"
  },
  "dependencies": {
    "@podium/protocol": "workspace:*"
  },
  "scripts": {
    "build": "tsup",
    "dev": "tsup --watch",
    "typecheck": "tsc --noEmit",
    "clean": "rm -rf dist"
  }
}
```

- [ ] **Step 2: Add the build dev-dependencies**

Run:
```bash
cd /home/user/src/other/podium
bun add -d --filter @podium/terminal-client tsup typescript
bun install
```
Expected: dev-deps added; `@podium/protocol` linked into `packages/terminal-client/node_modules`.

- [ ] **Step 3: Create `packages/terminal-client/tsconfig.json`** (DOM env)

```json
{
  "extends": "../../tooling/tsconfig/dom.json",
  "compilerOptions": {
    "outDir": "dist",
    "rootDir": "src"
  },
  "include": ["src"]
}
```

- [ ] **Step 4: Create `packages/terminal-client/tsup.config.ts`**

```ts
import { defineConfig } from 'tsup'

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  dts: true,
  clean: true,
  sourcemap: true,
  treeshake: true,
})
```

- [ ] **Step 5: Create `packages/terminal-client/src/index.ts`**

```ts
/**
 * @podium/terminal-client
 *
 * Framework-agnostic browser client that presents Podium agent terminal sessions on
 * web and mobile: xterm.js rendering, mobile key toolbar, touch/scroll policy,
 * reconnect/backpressure handling, controller/spectator multi-client rendering, and a
 * separate transcript view. Speaks {@link @podium/protocol}.
 *
 * Skeleton only — no implementation yet.
 */
export {}
```

- [ ] **Step 6: Create `packages/terminal-client/README.md`**

```markdown
# @podium/terminal-client

The browser presentation client for Podium agent terminal sessions, on web and mobile —
including the same session attached to two clients at once. Framework-agnostic core:
xterm.js rendering, a mobile auxiliary-key toolbar, an explicit touch/scroll policy
(TUI scroll vs terminal scrollback), reconnect/backpressure handling, controller and
spectator rendering, and a separate transcript surface. See
`docs/mobile-web-agent-cli-challenges.md` for the constraints this package answers.

Published to npm. Depends only on `@podium/protocol`. Pairs with `@podium/agent-bridge`
on the server side, but never imports it.

Intended runtime dependencies (added when implementation begins): `@xterm/xterm` and
relevant xterm addons. A React adapter may later be split into
`@podium/terminal-client-react`.
```

- [ ] **Step 7: Verify typecheck and build**

Run:
```bash
cd /home/user/src/other/podium
bun run --filter @podium/terminal-client typecheck
bun run --filter @podium/terminal-client build
ls packages/terminal-client/dist
```
Expected: typecheck passes; `dist/index.js` and `dist/index.d.ts` exist.

- [ ] **Step 8: Commit**

```bash
git add packages/terminal-client bun.lock package.json
git commit -m "feat(terminal-client): scaffold @podium/terminal-client library (no impl yet)"
```

---

## Task 7: `apps/server` (Hono + tRPC backend — placeholder workspace)

**Files:**
- Create: `/home/user/src/other/podium/apps/server/package.json`
- Create: `/home/user/src/other/podium/apps/server/tsconfig.json`
- Create: `/home/user/src/other/podium/apps/server/src/index.ts`
- Create: `/home/user/src/other/podium/apps/server/README.md`

- [ ] **Step 1: Create `apps/server/package.json`**

```json
{
  "name": "@podium/server",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "dependencies": {
    "@podium/core": "workspace:*",
    "@podium/protocol": "workspace:*"
  },
  "scripts": {
    "typecheck": "tsc --noEmit"
  }
}
```

- [ ] **Step 2: Add the typecheck dev-dependency and link workspace deps**

Run:
```bash
cd /home/user/src/other/podium
bun add -d --filter @podium/server typescript
bun install
```
Expected: `typescript` added; `@podium/core` and `@podium/protocol` linked into `apps/server/node_modules`.

- [ ] **Step 3: Create `apps/server/tsconfig.json`** (Node env)

```json
{
  "extends": "../../tooling/tsconfig/node.json",
  "include": ["src"]
}
```

- [ ] **Step 4: Create `apps/server/src/index.ts`**

```ts
/**
 * @podium/server
 *
 * API / web backend. Hono + tRPC over a Node runtime. Owns auth, persistence, the
 * conversation index, and fan-out to machine daemons; exports the tRPC `AppRouter`
 * type consumed type-only by `apps/web`.
 *
 * Skeleton only — no server, routers, or runtime dependencies (Hono, tRPC) yet.
 */
export {}
```

- [ ] **Step 5: Create `apps/server/README.md`**

```markdown
# @podium/server

Podium's API / web backend. **Hono + tRPC on a Node runtime.** Responsibilities: auth,
persistence, the cross-machine conversation index, and fanning requests out to machine
daemons. Exports the tRPC `AppRouter` *type*, which `apps/web` imports type-only.

Runs under Node (not Bun) so it shares a runtime with the PTY-touching daemon. Intended
runtime dependencies (added when implementation begins): `hono`, `@trpc/server`, `zod`,
plus a persistence layer (TBD as a product decision).
```

- [ ] **Step 6: Verify typecheck**

Run:
```bash
cd /home/user/src/other/podium
bun run --filter @podium/server typecheck
```
Expected: passes.

- [ ] **Step 7: Commit**

```bash
git add apps/server bun.lock
git commit -m "feat(server): scaffold @podium/server app (Hono+tRPC intent, no impl)"
```

---

## Task 8: `apps/daemon` (per-machine agent host — placeholder workspace)

**Files:**
- Create: `/home/user/src/other/podium/apps/daemon/package.json`
- Create: `/home/user/src/other/podium/apps/daemon/tsconfig.json`
- Create: `/home/user/src/other/podium/apps/daemon/src/index.ts`
- Create: `/home/user/src/other/podium/apps/daemon/README.md`

- [ ] **Step 1: Create `apps/daemon/package.json`**

```json
{
  "name": "@podium/daemon",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "dependencies": {
    "@podium/agent-bridge": "workspace:*",
    "@podium/protocol": "workspace:*",
    "@podium/core": "workspace:*"
  },
  "scripts": {
    "typecheck": "tsc --noEmit"
  }
}
```

- [ ] **Step 2: Add the typecheck dev-dependency and link workspace deps**

Run:
```bash
cd /home/user/src/other/podium
bun add -d --filter @podium/daemon typescript
bun install
```
Expected: `typescript` added; `@podium/agent-bridge`, `@podium/protocol`, `@podium/core` linked into `apps/daemon/node_modules`.

- [ ] **Step 3: Create `apps/daemon/tsconfig.json`** (Node env)

```json
{
  "extends": "../../tooling/tsconfig/node.json",
  "include": ["src"]
}
```

- [ ] **Step 4: Create `apps/daemon/src/index.ts`**

```ts
/**
 * @podium/daemon
 *
 * Installable per dev machine (macOS laptop, Linux VPS). Spawns and attaches agent
 * CLIs via {@link @podium/agent-bridge}, runs harness/project/worktree discovery, and
 * maintains a connection to the server. Runs under Node for node-pty compatibility.
 *
 * Skeleton only — no implementation yet.
 */
export {}
```

- [ ] **Step 5: Create `apps/daemon/README.md`**

```markdown
# @podium/daemon

The Podium daemon, installed on each dev machine. Spawns and attaches agent CLIs via
`@podium/agent-bridge`, runs harness/project/worktree discovery, exposes live PTY
streams, and maintains a connection to `@podium/server`. Runs under Node for `node-pty`
compatibility.

Skeleton only. The agent-wrapping logic lives in `@podium/agent-bridge`; this app
orchestrates it for one machine.
```

- [ ] **Step 6: Verify typecheck**

Run:
```bash
cd /home/user/src/other/podium
bun run --filter @podium/daemon typecheck
```
Expected: passes.

- [ ] **Step 7: Commit**

```bash
git add apps/daemon bun.lock
git commit -m "feat(daemon): scaffold @podium/daemon app (no impl)"
```

---

## Task 9: `apps/web` (responsive React + Vite UI — placeholder workspace)

**Files:**
- Create: `/home/user/src/other/podium/apps/web/package.json`
- Create: `/home/user/src/other/podium/apps/web/tsconfig.json`
- Create: `/home/user/src/other/podium/apps/web/src/index.ts`
- Create: `/home/user/src/other/podium/apps/web/README.md`

- [ ] **Step 1: Create `apps/web/package.json`**

```json
{
  "name": "@podium/web",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "dependencies": {
    "@podium/terminal-client": "workspace:*",
    "@podium/core": "workspace:*"
  },
  "scripts": {
    "typecheck": "tsc --noEmit"
  }
}
```

- [ ] **Step 2: Add the typecheck dev-dependency and link workspace deps**

Run:
```bash
cd /home/user/src/other/podium
bun add -d --filter @podium/web typescript
bun install
```
Expected: `typescript` added; `@podium/terminal-client` and `@podium/core` linked into `apps/web/node_modules`.

- [ ] **Step 3: Create `apps/web/tsconfig.json`** (React env)

```json
{
  "extends": "../../tooling/tsconfig/react.json",
  "include": ["src"]
}
```

- [ ] **Step 4: Create `apps/web/src/index.ts`**

```ts
/**
 * @podium/web
 *
 * Responsive web UI (mobile-first). React + Vite. Hosts the command center
 * (dev/product/spec modes), renders live agent terminals via
 * {@link @podium/terminal-client}, and talks to the server through a tRPC client
 * (importing the `AppRouter` type from `apps/server`).
 *
 * Skeleton only — no Vite app, components, or runtime dependencies (React, Vite) yet.
 */
export {}
```

- [ ] **Step 5: Create `apps/web/README.md`**

```markdown
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
```

- [ ] **Step 6: Verify typecheck**

Run:
```bash
cd /home/user/src/other/podium
bun run --filter @podium/web typecheck
```
Expected: passes.

- [ ] **Step 7: Commit**

```bash
git add apps/web bun.lock
git commit -m "feat(web): scaffold @podium/web app (React+Vite intent, no impl)"
```

---

## Task 10: Changesets release configuration

**Files:**
- Create (via init): `/home/user/src/other/podium/.changeset/config.json`
- Create (via init): `/home/user/src/other/podium/.changeset/README.md`

- [ ] **Step 1: Initialize Changesets**

Run:
```bash
cd /home/user/src/other/podium
bunx changeset init
```
Expected: creates `.changeset/config.json` and `.changeset/README.md`.

- [ ] **Step 2: Replace `.changeset/config.json` with the Podium configuration**

```json
{
  "$schema": "https://unpkg.com/@changesets/config@3.0.0/schema.json",
  "changelog": "@changesets/cli/changelog",
  "commit": false,
  "fixed": [],
  "linked": [],
  "access": "public",
  "baseBranch": "main",
  "updateInternalDependencies": "patch",
  "ignore": []
}
```
(Private packages — `@podium/core`, `@podium/server`, `@podium/daemon`, `@podium/web`,
`@podium/tsconfig` — are skipped automatically because they set `"private": true`. Only
the three `★` libraries are publishable.)

- [ ] **Step 3: Verify Changesets reads the config**

Run:
```bash
cd /home/user/src/other/podium
bunx changeset status --since=HEAD || true
```
Expected: runs without a config error (it may report "No changesets present" — that is fine).

- [ ] **Step 4: Commit**

```bash
git add .changeset
git commit -m "chore(release): configure changesets for the public libraries"
```

---

## Task 11: Top-level documentation (README, ARCHITECTURE, CONTRIBUTING)

**Files:**
- Create: `/home/user/src/other/podium/README.md`
- Create: `/home/user/src/other/podium/ARCHITECTURE.md`
- Create: `/home/user/src/other/podium/CONTRIBUTING.md`

- [ ] **Step 1: Create `README.md`**

```markdown
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
```

- [ ] **Step 2: Create `ARCHITECTURE.md`** (the "what goes where" source of truth)

```markdown
# Architecture

Podium is a Bun-workspace monorepo. Design rationale lives in
`docs/superpowers/specs/2026-06-01-monorepo-design.md`; this file is the day-to-day map.

## Runtime topology

- **`apps/server`** — API / web backend (Hono + tRPC). Can run apart from dev machines.
- **`apps/daemon`** — installed on each dev machine; wraps agent CLIs and streams PTYs.
- **`apps/web`** — responsive web UI (mobile-first), talks to the server.
- Later: cloud sandboxes for agents.

## Packages

`@podium/agent-bridge` (Node) and `@podium/terminal-client` (browser) are the two
standalone libraries. They never depend on each other — they meet only through
`@podium/protocol`. This keeps a native PTY addon and browser DOM code out of the same
package and lets each release independently.

## Dependency direction

```
apps/web ────────────► @podium/terminal-client ──┐
apps/web ··type-only··► apps/server               │
apps/server ─────────► @podium/core               ├─► @podium/protocol
apps/daemon ─────────► @podium/agent-bridge ──────┘
apps/{server,daemon} ► @podium/core
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

Bun (package manager / task runner / bundler) · Node 22 (runtime for `server`/`daemon`
because of `node-pty`) · TypeScript ESM-only · Biome (lint+format) · Vitest · tsup
(library builds) · Changesets (releases). Cross-workspace tasks run via
`bun run --filter`.
```

- [ ] **Step 3: Create `CONTRIBUTING.md`**

```markdown
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

## Cross-package imports

All `src/` are empty in the skeleton, so no package imports another yet. When the first
real cross-package import lands between a *published* library and its consumer, add a
`"@podium/source": "./src/index.ts"` export condition (and `customConditions` in the
tsconfig base) so typecheck resolves to source without requiring a prior build. Until
then, build libraries before any consumer that imports their `dist` output.

## Releasing the libraries

Public libraries (`@podium/protocol`, `@podium/agent-bridge`, `@podium/terminal-client`)
are versioned with Changesets:

```bash
bun run changeset          # describe the change
bun run version-packages   # apply version bumps + changelogs
bun run release            # build + publish
```
```

- [ ] **Step 4: Verify docs lint clean**

Run:
```bash
cd /home/user/src/other/podium
bun run lint
```
Expected: Biome reports no errors (Markdown is ignored for formatting; no JS/TS changed).

- [ ] **Step 5: Commit**

```bash
git add README.md ARCHITECTURE.md CONTRIBUTING.md
git commit -m "docs: add README, ARCHITECTURE (what-goes-where), and CONTRIBUTING"
```

---

## Task 12: Full-repo verification gate

No new files. Runs every success criterion from spec §10 and confirms the skeleton is green.

- [ ] **Step 1: Clean install resolves the workspace**

Run:
```bash
cd /home/user/src/other/podium
bun install
```
Expected: completes with no errors; `bun.lock` unchanged (or only formatting).

- [ ] **Step 2: Typecheck every workspace**

Run:
```bash
bun run typecheck
```
Expected: every workspace's `tsc --noEmit` passes.

- [ ] **Step 3: Build the publishable libraries**

Run:
```bash
bun run build
ls packages/protocol/dist packages/agent-bridge/dist packages/terminal-client/dist
```
Expected: each `dist/` contains `index.js` and `index.d.ts`.

- [ ] **Step 4: Lint and test**

Run:
```bash
bun run lint
bun run test
```
Expected: Biome reports no errors; Vitest exits 0 (no test files / passWithNoTests).

- [ ] **Step 5: Changesets config is valid**

Run:
```bash
bunx changeset status --since=HEAD || true
```
Expected: no config error.

- [ ] **Step 6: Confirm the tree is clean and final**

Run:
```bash
git status --short
git log --oneline
```
Expected: working tree clean; commit history shows the bootstrap → packages → apps → release → docs sequence.

---

## Self-review (completed by plan author)

- **Spec coverage:** §3 decisions → Tasks 1–2, 10 (tooling) and per-package tasks; §4 inventory → Tasks 3–9 (every app/package has a task); §5 dependency direction → workspace deps wired in Tasks 5–9 + documented in Task 11; §6 map → Task 11 ARCHITECTURE.md; §7 future list → Task 11; §8 tooling baseline → Tasks 1, 2, 10; §10 success criteria → Task 12 runs all seven. Spec §3 "project references" is consciously deferred and recorded in the plan notes + ARCHITECTURE growth list, not silently dropped.
- **Placeholder scan:** no "TBD/implement later" in steps; the only "TBD" is inside `apps/server/README.md` content referring to a *product* persistence decision, which is intentional documentation, not a plan placeholder.
- **Type/name consistency:** package names (`@podium/protocol|agent-bridge|terminal-client|core|tsconfig|server|daemon|web`), tsconfig base filenames (`base|node|dom|react`), and the `typecheck`/`build`/`dev` script names are identical across every task.
```
