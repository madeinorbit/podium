# Packaging Phase 1 — Backend Shippable (Implementation Plan)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the `server`/`daemon`/`web` stack into a self-contained, headless-runnable backend bundle: the server serves the web UI, the backend bundles to plain `.mjs`, and an assembled folder runs the whole thing with a shipped Node + prebuilt `node-pty` + prebuilt `abduco` — plus a protocol-version handshake so future cross-version peers fail loudly instead of silently.

**Architecture:** Add a manual static-file handler to the existing Hono server so it serves `apps/web/dist` for the browser path (the Tauri desktop will use bundled assets instead — out of scope here). Bundle `scripts/{server,daemon,host}.ts` with esbuild (keeping `node-pty` external), then assemble a runnable folder that stages a Node binary, the prebuilt `node-pty`, a compiled `abduco`, and the web build, fronted by a POSIX `podium` launcher. A `PROTOCOL_VERSION` constant in `@podium/protocol` is advertised over `/version` and enforced on the `/daemon` WebSocket upgrade.

**Tech Stack:** TypeScript (ESM), Hono + `@hono/node-server`, `ws`, esbuild (new direct devDep), Node ≥22, Vitest, Biome, Bun (package manager / task runner).

## Global Constraints

- **Backend runtime is Node ≥22, never Bun** — `node-pty` is a native Node addon (`packages/agent-bridge/src/{session,abduco,tmux}.ts`).
- **`node-pty` stays external in every bundle**; it is shipped as a prebuilt copy in an adjacent `node_modules`.
- **`abduco` is shipped, not assumed** — resolution honors `PODIUM_ABDUCO` → PATH → `$PODIUM_STATE_DIR/bin/abduco` → vendored compile (`packages/agent-bridge/src/abduco-bin.ts`). The bundle sets `PODIUM_ABDUCO`.
- **Cross-package imports resolve via the `@podium/source` condition** (TS source). Every bundler/test invocation must pass `conditions: ['@podium/source']`.
- **`/health` must keep returning the plaintext body `ok`** — boot watchdogs and the Vite proxy depend on it. New machine-readable info goes on a separate `/version` route.
- **The SPA fallback must never shadow backend routes.** Keep the deny-prefix list in sync with `apps/web/vite.config.ts` `navigateFallbackDenylist`: `/trpc`, `/health`, `/version`, `/files`, `/client`, `/daemon`, `/hooks`.
- **Phase 1 targets the build machine's own OS/arch only.** Cross-arch matrix builds are Phase 4 (Distribution).
- **Do this work in a git worktree**, not the live `main` checkout (the live backend runs from `main`'s working tree).
- Lint with `bun run lint` (Biome), test with `bun run test` (Vitest), commit after each task.
- Use an ephemeral port (`PODIUM_PORT=18799`) in smoke tests so they never collide with the live `:18787`.

### Deferred to later phases (do NOT build here)
- Web "update needed" banner + client `pv` param → **Phase 2** (lands with the Machines/version-aware client work).
- `podium pair` subcommand → **Phase 2** (multi-machine). `podium update` → **Phase 5** (auto-update).
- Embedding/pinning a downloaded Node per target arch, signing → **Phase 4**. (Phase 1 stages the *build machine's* `node`.)

---

### Task 1: Server serves the built web UI

**Files:**
- Create: `apps/server/src/static-web.ts`
- Create (test): `apps/server/src/static-web.test.ts`
- Modify: `apps/server/src/server.ts` (add import + call after the tRPC/asset routes)

**Interfaces:**
- Produces: `registerWebStatic(app: Hono, webDir: string): boolean` — registers a catch-all that serves files under `webDir` and falls back to `index.html`; returns `false` and registers nothing when `webDir/index.html` is absent. Must be called **after** all API routes so they win.

- [ ] **Step 1: Write the failing test**

Create `apps/server/src/static-web.test.ts`:

```ts
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Hono } from 'hono'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { registerWebStatic } from './static-web'

describe('registerWebStatic', () => {
  let dir: string
  const app = new Hono()
  // API route registered BEFORE static, mirroring server.ts ordering.
  app.get('/trpc/x', (c) => c.text('api'))

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'podium-web-'))
    writeFileSync(join(dir, 'index.html'), '<!doctype html><title>Podium</title>')
    mkdirSync(join(dir, 'assets'))
    writeFileSync(join(dir, 'assets', 'app.js'), 'console.log(1)')
    registerWebStatic(app, dir)
  })
  afterAll(() => rmSync(dir, { recursive: true, force: true }))

  it('serves index.html at /', async () => {
    const res = await app.request('/')
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('text/html')
    expect(await res.text()).toContain('Podium')
  })
  it('serves a hashed asset with the right content-type', async () => {
    const res = await app.request('/assets/app.js')
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('javascript')
  })
  it('falls back to index.html for an unknown SPA route', async () => {
    const res = await app.request('/settings/machines')
    expect(res.status).toBe(200)
    expect(await res.text()).toContain('Podium')
  })
  it('does not shadow API routes', async () => {
    const res = await app.request('/trpc/x')
    expect(await res.text()).toBe('api')
  })
  it('returns false and registers nothing when no build is present', () => {
    const empty = mkdtempSync(join(tmpdir(), 'podium-empty-'))
    expect(registerWebStatic(new Hono(), empty)).toBe(false)
    rmSync(empty, { recursive: true, force: true })
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun run test -- apps/server/src/static-web.test.ts`
Expected: FAIL — `Cannot find module './static-web'`.

- [ ] **Step 3: Implement `static-web.ts`**

Create `apps/server/src/static-web.ts`:

```ts
import { existsSync, readFileSync, statSync } from 'node:fs'
import { extname, join, normalize } from 'node:path'
import type { Hono } from 'hono'

/**
 * Backend route prefixes that must never be shadowed by the SPA index.html.
 * Keep in sync with apps/web/vite.config.ts navigateFallbackDenylist.
 */
const BACKEND_PREFIXES = ['/trpc', '/health', '/version', '/files', '/client', '/daemon', '/hooks']

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.map': 'application/json; charset=utf-8',
}

function contentType(p: string): string {
  return CONTENT_TYPES[extname(p).toLowerCase()] ?? 'application/octet-stream'
}

/**
 * Serve the built web bundle (apps/web/dist) for the browser "just point at the
 * server" path. Returns false (and registers nothing) when no build is present, so
 * a source/dev run is unaffected. Must be called AFTER the API routes are registered.
 */
export function registerWebStatic(app: Hono, webDir: string): boolean {
  if (!existsSync(join(webDir, 'index.html'))) return false

  app.get('/*', (c) => {
    const pathname = new URL(c.req.url).pathname
    // Never let API/WS routes fall through to the SPA shell.
    if (BACKEND_PREFIXES.some((pre) => pathname === pre || pathname.startsWith(`${pre}/`))) {
      return c.notFound()
    }
    // Try the requested asset (path-traversal-safe), else the SPA shell.
    const rel = normalize(decodeURIComponent(pathname)).replace(/^(\.\.[/\\])+/, '')
    const filePath = join(webDir, rel)
    if (filePath.startsWith(webDir) && existsSync(filePath) && statSync(filePath).isFile()) {
      return new Response(readFileSync(filePath), {
        status: 200,
        headers: { 'Content-Type': contentType(filePath) },
      })
    }
    return new Response(readFileSync(join(webDir, 'index.html')), {
      status: 200,
      headers: { 'Content-Type': 'text/html; charset=utf-8' },
    })
  })
  return true
}
```

- [ ] **Step 4: Wire it into the server**

In `apps/server/src/server.ts`, add the imports near the top:

```ts
import { fileURLToPath } from 'node:url'
import { registerWebStatic } from './static-web'
```

Then, immediately after the tRPC middleware block (after the `app.use('/trpc/*', trpcServer({...}))` call) and before the `return new Promise<ServerHandle>(...)`, add:

```ts
  // Serve the built web UI for the browser path. PODIUM_WEB_DIR is set by the
  // packaged bundle; the default points at apps/web/dist for a source run. No build
  // present (e.g. plain dev with Vite) → registerWebStatic is a no-op.
  const webDir =
    process.env.PODIUM_WEB_DIR ?? fileURLToPath(new URL('../../web/dist', import.meta.url))
  registerWebStatic(app, webDir)
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `bun run test -- apps/server/src/static-web.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 6: Typecheck, lint, commit**

```bash
bun run --filter @podium/server typecheck
bun run lint
git add apps/server/src/static-web.ts apps/server/src/static-web.test.ts apps/server/src/server.ts
git commit -m "feat(server): serve the built web UI (browser path) with SPA fallback"
```

---

### Task 2: Protocol-version primitives

**Files:**
- Create: `packages/protocol/src/version.ts`
- Create (test): `packages/protocol/src/version.test.ts`
- Modify: `packages/protocol/src/index.ts` (re-export)

**Interfaces:**
- Produces: `PROTOCOL_VERSION: number` (current wire version, `1`); `isProtocolCompatible(a: number, b: number): boolean` (true iff both are integers and equal). Consumed by Tasks 3 and (later) the client.

- [ ] **Step 1: Write the failing test**

Create `packages/protocol/src/version.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { PROTOCOL_VERSION, isProtocolCompatible } from './version'

describe('protocol version', () => {
  it('PROTOCOL_VERSION is a positive integer', () => {
    expect(Number.isInteger(PROTOCOL_VERSION)).toBe(true)
    expect(PROTOCOL_VERSION).toBeGreaterThan(0)
  })
  it('same version is compatible', () => {
    expect(isProtocolCompatible(PROTOCOL_VERSION, PROTOCOL_VERSION)).toBe(true)
  })
  it('different versions are incompatible', () => {
    expect(isProtocolCompatible(1, 2)).toBe(false)
  })
  it('non-integers are incompatible', () => {
    expect(isProtocolCompatible(Number.NaN, 1)).toBe(false)
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun run test -- packages/protocol/src/version.test.ts`
Expected: FAIL — `Cannot find module './version'`.

- [ ] **Step 3: Implement `version.ts`**

Create `packages/protocol/src/version.ts`:

```ts
/**
 * Wire protocol version. Bump on ANY breaking change to the client↔server or
 * server↔daemon message shapes in this package. Server, daemon, and clients that
 * may run on different machines / different releases compare this to decide
 * compatibility (see isProtocolCompatible) and tell the user to update on mismatch.
 */
export const PROTOCOL_VERSION = 1

/**
 * Two peers are compatible iff they share the same protocol version. A single
 * integer today; this function is the seam for a major/minor scheme later.
 */
export function isProtocolCompatible(a: number, b: number): boolean {
  return Number.isInteger(a) && Number.isInteger(b) && a === b
}
```

- [ ] **Step 4: Re-export from the package index**

In `packages/protocol/src/index.ts`, add after the existing `export * from './messages'`:

```ts
export * from './version'
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `bun run test -- packages/protocol/src/version.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 6: Typecheck, lint, commit**

```bash
bun run --filter @podium/protocol typecheck
bun run lint
git add packages/protocol/src/version.ts packages/protocol/src/version.test.ts packages/protocol/src/index.ts
git commit -m "feat(protocol): add PROTOCOL_VERSION + isProtocolCompatible"
```

---

### Task 3: Protocol-version handshake wiring (server + daemon)

**Files:**
- Modify: `apps/server/src/server.ts` (add `/version` route)
- Modify: `apps/server/src/wsServer.ts` (reject incompatible `pv` on upgrade)
- Modify: `apps/daemon/src/daemon.ts` (send `pv`, log on 426)
- Create (test): `apps/server/src/version-route.test.ts`

**Interfaces:**
- Consumes: `PROTOCOL_VERSION`, `isProtocolCompatible` (Task 2).
- Produces: HTTP `GET /version` → `{ protocolVersion: number, appVersion: string }`; the `/daemon` and `/client` WebSocket upgrades reject with HTTP `426` when a present-but-incompatible `?pv=` is supplied (absent `pv` is allowed, so older peers still connect).

- [ ] **Step 1: Write the failing test for `/version`**

Create `apps/server/src/version-route.test.ts`:

```ts
import { PROTOCOL_VERSION } from '@podium/protocol'
import { Hono } from 'hono'
import { describe, expect, it } from 'vitest'
import { registerVersionRoute } from './server'

describe('GET /version', () => {
  it('reports the protocol + app version as JSON', async () => {
    const app = new Hono()
    registerVersionRoute(app)
    const res = await app.request('/version')
    expect(res.status).toBe(200)
    const body = (await res.json()) as { protocolVersion: number; appVersion: string }
    expect(body.protocolVersion).toBe(PROTOCOL_VERSION)
    expect(typeof body.appVersion).toBe('string')
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun run test -- apps/server/src/version-route.test.ts`
Expected: FAIL — `registerVersionRoute` is not exported from `./server`.

- [ ] **Step 3: Add `/version` to the server**

In `apps/server/src/server.ts`, add to the imports:

```ts
import type { Hono } from 'hono'
import { PROTOCOL_VERSION } from '@podium/protocol'
```

(Adjust the existing `import { Hono } from 'hono'` to also import the type, or add the `type` import separately.)

Add this exported helper above `startServer`:

```ts
/** Machine-readable version probe — distinct from /health (which stays plaintext "ok"). */
export function registerVersionRoute(app: Hono): void {
  app.get('/version', (c) =>
    c.json({
      protocolVersion: PROTOCOL_VERSION,
      appVersion: process.env.PODIUM_APP_VERSION ?? 'dev',
    }),
  )
}
```

Then call it inside `startServer`, right after `app.get('/health', ...)`:

```ts
  registerVersionRoute(app)
```

- [ ] **Step 4: Run the `/version` test to verify it passes**

Run: `bun run test -- apps/server/src/version-route.test.ts`
Expected: PASS.

- [ ] **Step 5: Enforce `pv` on the WebSocket upgrade**

In `apps/server/src/wsServer.ts`, add to the imports:

```ts
import { PROTOCOL_VERSION, isProtocolCompatible } from '@podium/protocol'
```

Replace the body of the `server.on('upgrade', ...)` handler so the URL is parsed once and an incompatible `pv` is rejected before the per-path handling:

```ts
  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    const pathname = url.pathname
    // Reject a peer on an incompatible wire protocol with a clear 426 so it can tell
    // the user to update, rather than failing later on a malformed frame. A peer that
    // sends no `pv` (older client) is allowed through unchanged.
    if (pathname === '/daemon' || pathname === '/client') {
      if (url.searchParams.has('pv') && !isProtocolCompatible(Number(url.searchParams.get('pv')), PROTOCOL_VERSION)) {
        socket.write('HTTP/1.1 426 Upgrade Required\r\n\r\n')
        socket.destroy()
        return
      }
    }
    if (pathname === '/daemon') {
      daemonWss.handleUpgrade(req, socket, head, (ws) => daemonWss.emit('connection', ws, req))
    } else if (pathname === '/client') {
      clientWss.handleUpgrade(req, socket, head, (ws) => clientWss.emit('connection', ws, req))
    } else {
      socket.destroy()
    }
  })
```

- [ ] **Step 6: Daemon sends `pv` and logs on rejection**

In `apps/daemon/src/daemon.ts`, add `PROTOCOL_VERSION` to the existing `@podium/protocol` import (or add a new import line):

```ts
import { PROTOCOL_VERSION } from '@podium/protocol'
```

In the `connect()` function (around line 1485), change the WebSocket URL to include the protocol version, and add an `unexpected-response` handler. Replace:

```ts
      const w = new WebSocket(`${opts.serverUrl}/daemon`)
      currentWs = w
      w.on('open', onOpen)
      w.on('message', handleControlMessage)
```

with:

```ts
      const w = new WebSocket(`${opts.serverUrl}/daemon?pv=${PROTOCOL_VERSION}`)
      currentWs = w
      w.on('open', onOpen)
      w.on('message', handleControlMessage)
      // Server rejected the upgrade (e.g. 426 = wire-protocol mismatch). Surface it
      // loudly; 'close' still drives the backoff reconnect below.
      w.on('unexpected-response', (_req, res) => {
        if (res.statusCode === 426) {
          console.error(
            `[podium:daemon] server rejected this daemon: protocol mismatch (daemon pv=${PROTOCOL_VERSION}). Update the daemon to match the server.`,
          )
        }
      })
```

- [ ] **Step 7: Verify the whole suite still passes**

Run: `bun run test`
Expected: PASS (existing server/daemon/relay tests unaffected; the upgrade change is behavior-preserving when `pv` is absent or compatible).

- [ ] **Step 8: Typecheck, lint, commit**

```bash
bun run --filter @podium/server typecheck
bun run --filter @podium/daemon typecheck
bun run lint
git add apps/server/src/server.ts apps/server/src/version-route.test.ts apps/server/src/wsServer.ts apps/daemon/src/daemon.ts
git commit -m "feat(protocol): version handshake — /version route + pv upgrade guard + daemon pv"
```

---

### Task 4: Bundle the backend with esbuild

**Files:**
- Create: `scripts/build-backend.ts`
- Modify: `package.json` (add `esbuild` devDep + `package:backend` script)
- Modify: `.gitignore` (ignore `dist-backend/`, `dist-bundle/`)

**Interfaces:**
- Produces: `dist-backend/{server,daemon,host}.mjs` — standalone Node ESM bundles with `node-pty` left external. Consumed by Task 5 (assemble).

- [ ] **Step 1: Add esbuild and the build script entry**

```bash
bun add -d esbuild
```

In `package.json` `scripts`, add:

```json
    "package:backend": "node_modules/.bin/tsx scripts/build-backend.ts",
```

In `.gitignore`, add:

```
dist-backend/
dist-bundle/
```

- [ ] **Step 2: Write the bundler script**

Create `scripts/build-backend.ts`:

```ts
/**
 * Bundle the three backend entrypoints into standalone Node ESM files. node-pty is a
 * native addon and stays external — the assemble step (scripts/assemble-bundle.ts)
 * ships a prebuilt copy in an adjacent node_modules so Node resolves it at runtime.
 * The @podium/source condition pulls cross-package TypeScript source.
 */
import { mkdirSync, rmSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const outdir = fileURLToPath(new URL('../dist-backend', import.meta.url))
rmSync(outdir, { recursive: true, force: true })
mkdirSync(outdir, { recursive: true })

await build({
  entryPoints: {
    server: fileURLToPath(new URL('./server.ts', import.meta.url)),
    daemon: fileURLToPath(new URL('./daemon.ts', import.meta.url)),
    host: fileURLToPath(new URL('./host.ts', import.meta.url)),
  },
  outdir,
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  outExtension: { '.js': '.mjs' },
  conditions: ['@podium/source'],
  external: ['node-pty'],
  // Some CJS deps reference require/__dirname/__filename; provide ESM shims.
  banner: {
    js: [
      "import { createRequire as ___createRequire } from 'node:module';",
      "import { fileURLToPath as ___fileURLToPath } from 'node:url';",
      "import { dirname as ___dirname } from 'node:path';",
      'const require = ___createRequire(import.meta.url);',
      'const __filename = ___fileURLToPath(import.meta.url);',
      'const __dirname = ___dirname(__filename);',
    ].join('\n'),
  },
  logLevel: 'info',
})

console.log(`bundled server/daemon/host → ${outdir}`)
```

- [ ] **Step 3: Run the bundler**

Run: `bun run package:backend`
Expected: esbuild prints the three outputs; `dist-backend/server.mjs`, `daemon.mjs`, `host.mjs` exist. Confirm:

```bash
ls -1 dist-backend
```
Expected: `daemon.mjs  host.mjs  server.mjs` (plus any `.mjs.map`).

- [ ] **Step 4: Smoke-test the bundled host (it boots, serves /health + /version)**

This runs the *bundled* host from the repo root, so `node-pty` resolves from the repo's own `node_modules`:

```bash
PODIUM_PORT=18799 node dist-backend/host.mjs &
SMOKE_PID=$!
sleep 3
curl -fsS http://localhost:18799/health; echo
curl -fsS http://localhost:18799/version; echo
kill "$SMOKE_PID"
```
Expected: `/health` prints `ok`; `/version` prints `{"protocolVersion":1,"appVersion":"dev"}`.

> If the bundle throws on a missing runtime require (rare CJS-in-ESM edge), add the offending bare module to the `external` array and re-bundle; it will resolve from `node_modules` at runtime.

- [ ] **Step 5: Commit**

```bash
git add package.json bun.lock .gitignore scripts/build-backend.ts
git commit -m "build: bundle server/daemon/host to standalone Node ESM (node-pty external)"
```

---

### Task 5: Assemble a runnable, self-contained bundle

**Files:**
- Create: `scripts/assemble-bundle.ts`
- Modify: `package.json` (add `package:bundle` script)

**Interfaces:**
- Consumes: `dist-backend/*.mjs` (Task 4); `buildVendoredAbduco` from `@podium/agent-bridge`.
- Produces: `dist-bundle/` containing `bin/node`, `bin/abduco`, `node_modules/node-pty/**`, `web/**`, `{server,daemon,host}.mjs`, and an executable `podium` launcher. Running `dist-bundle/podium all` starts the all-in-one backend with nothing else installed.

- [ ] **Step 1: Add the assemble script entry**

In `package.json` `scripts`, add:

```json
    "package:bundle": "bun run --filter @podium/web build && bun run package:backend && node_modules/.bin/tsx scripts/assemble-bundle.ts",
```

- [ ] **Step 2: Write the assemble script**

Create `scripts/assemble-bundle.ts`:

```ts
/**
 * Assemble a self-contained, runnable backend bundle for THIS machine's OS/arch:
 *   dist-bundle/
 *     bin/node            (this machine's node binary)
 *     bin/abduco          (compiled from the vendored source)
 *     node_modules/node-pty/**   (prebuilt native addon, resolved at runtime)
 *     web/**              (apps/web/dist)
 *     server.mjs daemon.mjs host.mjs
 *     podium              (POSIX launcher / CLI)
 *
 * Cross-arch builds (a different target than the build machine) are Phase 4.
 */
import { execFileSync } from 'node:child_process'
import { chmodSync, cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildVendoredAbduco } from '@podium/agent-bridge'

const require = createRequire(import.meta.url)
const root = fileURLToPath(new URL('..', import.meta.url))
const out = join(root, 'dist-bundle')

rmSync(out, { recursive: true, force: true })
mkdirSync(join(out, 'bin'), { recursive: true })
mkdirSync(join(out, 'node_modules'), { recursive: true })

// 1. Bundled backend JS.
for (const f of ['server.mjs', 'daemon.mjs', 'host.mjs']) {
  cpSync(join(root, 'dist-backend', f), join(out, f))
}

// 2. This machine's node binary (Phase 4 swaps in a pinned per-arch Node).
cpSync(process.execPath, join(out, 'bin', 'node'))

// 3. node-pty with its prebuilt .node, resolved from wherever it's installed.
const ptyPkg = require.resolve('node-pty/package.json')
cpSync(dirname(ptyPkg), join(out, 'node_modules', 'node-pty'), { recursive: true })

// 4. abduco — compile the vendored source into the bundle.
const abduco = buildVendoredAbduco(join(out, 'bin', 'abduco'))
if (!abduco) throw new Error('failed to build vendored abduco (no C compiler?)')

// 5. Web build.
const webDist = join(root, 'apps', 'web', 'dist')
if (!existsSync(join(webDist, 'index.html'))) {
  throw new Error(`apps/web/dist not built — run \`bun run --filter @podium/web build\` first`)
}
cpSync(webDist, join(out, 'web'), { recursive: true })

// 6. POSIX launcher / CLI. node resolves node-pty from ./node_modules next to *.mjs.
const launcher = `#!/bin/sh
# Podium all-in-one launcher. Subcommands: all (default) | server | daemon
DIR="$(cd "$(dirname "$0")" && pwd)"
export PODIUM_ABDUCO="\${PODIUM_ABDUCO:-$DIR/bin/abduco}"
export PODIUM_WEB_DIR="\${PODIUM_WEB_DIR:-$DIR/web}"
NODE="$DIR/bin/node"
cmd="\${1:-all}"
[ $# -gt 0 ] && shift
case "$cmd" in
  all)    exec "$NODE" "$DIR/host.mjs" "$@" ;;
  server) exec "$NODE" "$DIR/server.mjs" "$@" ;;
  daemon) exec "$NODE" "$DIR/daemon.mjs" "$@" ;;
  *) echo "usage: podium {all|server|daemon}" >&2; exit 2 ;;
esac
`
writeFileSync(join(out, 'podium'), launcher)
chmodSync(join(out, 'podium'), 0o755)

console.log(`assembled runnable bundle → ${out}`)
```

> Note: `@podium/agent-bridge` must export `buildVendoredAbduco`. Confirm `packages/agent-bridge/src/index.ts` re-exports it; if not, add `export { buildVendoredAbduco } from './abduco-bin'` there in this task (it is already a public function in `abduco-bin.ts`).

- [ ] **Step 3: Verify the agent-bridge export exists (add if missing)**

Run: `grep -n "buildVendoredAbduco" packages/agent-bridge/src/index.ts`
Expected: a re-export line. If absent, add to `packages/agent-bridge/src/index.ts`:

```ts
export { buildVendoredAbduco, resolveAbducoBin, defaultAbducoCachePath } from './abduco-bin'
```

- [ ] **Step 4: Build the full bundle**

Run: `bun run package:bundle`
Expected: web build runs, backend bundles, assemble prints `assembled runnable bundle → .../dist-bundle`. Confirm layout:

```bash
ls -1 dist-bundle dist-bundle/bin dist-bundle/node_modules
```
Expected: `podium`, `host.mjs`, `server.mjs`, `daemon.mjs`, `web/`; `bin/node`, `bin/abduco`; `node_modules/node-pty`.

- [ ] **Step 5: Smoke-test the assembled bundle end-to-end**

```bash
PODIUM_PORT=18799 dist-bundle/podium all &
SMOKE_PID=$!
sleep 3
curl -fsS http://localhost:18799/health; echo                       # -> ok
curl -fsS -o /dev/null -w '%{http_code}\n' http://localhost:18799/   # -> 200 (served web shell)
dist-bundle/bin/abduco -v 2>&1 | head -1                            # -> abduco version banner
kill "$SMOKE_PID"
```
Expected: `ok`; `200`; an abduco version line. This proves the bundle serves the UI and its shipped natives run, with only `dist-bundle/` on disk.

- [ ] **Step 6: Commit**

```bash
git add package.json scripts/assemble-bundle.ts packages/agent-bridge/src/index.ts
git commit -m "build: assemble self-contained runnable backend bundle (node + node-pty + abduco + web)"
```

---

## Self-Review

**Spec coverage (Phase 1 items from `2026-06-21-packaging-distribution-design.md` §A + §E-partial):**
- "Bundle the entrypoints (server/daemon/host), node-pty external, @podium/source" → Task 4. ✓
- "Ship prebuilt natives: node-pty + abduco; set PODIUM_ABDUCO" → Task 5 (node-pty copied, abduco compiled, launcher exports `PODIUM_ABDUCO`). ✓
- "Ship a Node runtime" → Task 5 stages `process.execPath`; per-arch pinned Node deferred to Phase 4 (documented). ✓ (scoped)
- "Server serves apps/web/dist with SPA fallback + denylist parity" → Task 1. ✓
- "podium CLI (server/daemon/all)" → Task 5 launcher; `pair`/`update` explicitly deferred. ✓ (scoped)
- "Protocol-version handshake lands in Phase 1" → Tasks 2 + 3 (constant, /version, pv upgrade guard, daemon pv). Client banner deferred to Phase 2 (documented; no cross-version peer exists within a single Phase-1 release, so deferral is correct sequencing). ✓
- Verification ("bundled `podium all` starts with no checkout; serves UI; natives resolve; agent streams; handshake rejects on mismatch") → Task 5 Step 5 smoke + the upgrade-guard behavior in Task 3. (A live agent-spawn smoke is covered by existing daemon e2e once running headless; not re-implemented here.)

**Placeholder scan:** No "TBD"/"add error handling"/"similar to". The two conditional steps (Task 4 Step 4 fallback note, Task 5 Step 3 export check) give exact code to add. ✓

**Type/name consistency:** `registerWebStatic(app, webDir): boolean`, `registerVersionRoute(app): void`, `PROTOCOL_VERSION`, `isProtocolCompatible(a,b)`, `buildVendoredAbduco(out)` are used identically wherever referenced across tasks. The deny-prefix list (`/trpc /health /version /files /client /daemon /hooks`) matches between `static-web.ts` and the vite config note. ✓

## What Phase 1 delivers

A `dist-bundle/` folder that runs the entire Podium backend — relay + daemon + served web UI — on a machine with nothing installed but the bundle, plus a wire-protocol-version handshake. This is the relocatable artifact every later phase builds on: Phase 2 pairs a second daemon to it, Phase 3 (Tauri) spawns it as a sidecar, Phase 4 produces per-arch installers from it, Phase 5 teaches it to self-update.
