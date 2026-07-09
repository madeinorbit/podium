# Packaging Phase 1 — Finish the Headless Backend (Implementation Plan)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **REVISED 2026-06-21** after discovering the Bun migration already landed on `main` (`7ca3926`): `bun build --compile` single-file binaries, embedded abduco, `Bun.Terminal` PTY, and a runtime-neutral SQLite shim already exist. This plan no longer bundles with esbuild or ships Node/node-pty — those tasks are obsolete. It finishes what remains for the headless single-download.

**Goal:** Make the already-compiled `podium-server` + `podium-daemon` Bun binaries shippable as a headless "one download": the server serves the web UI to external clients (browser/phone/other desktop), a wire protocol-version handshake guards cross-version peers, and a packaging step assembles a runnable `dist-bun/headless/` bundle (binaries + web + launcher).

**Architecture:** Add a manual static-file handler to the existing Hono server (`apps/server/src/server.ts`) to serve `PODIUM_WEB_DIR` for external clients only — the Tauri desktop window uses its own bundled UI (Phase 3). Add a `WIRE_VERSION` constant to `@podium/protocol`, advertise it on `GET /version`, and enforce it on the `/daemon`/`/client` WebSocket upgrades. Extend `scripts/build-bun.ts` to stage a headless bundle.

**Tech Stack:** TypeScript (ESM), **Bun** (runtime + `bun build --compile` + package manager/task runner), Hono + `@hono/node-server`, `ws`, Vitest, Biome.

## Global Constraints

- **Backend runtime is Bun**; release artifacts are `bun build --compile` binaries (`scripts/build-bun.ts`). The `node-pty` adapter and Node path remain only for dev/tests via the `PtyProcess` abstraction (`packages/agent-bridge/src/pty/`). Do **not** reintroduce a hard `node-pty` dependency or an esbuild/Node bundle.
- **PTY** comes from `defaultPtyBackend()` (Bun.Terminal under Bun, node-pty under Node). **SQLite** comes from the shim (`packages/core/src/sqlite/`). **abduco** is embedded in the daemon binary and materialized at runtime (`scripts/embedded-abduco.ts`); do not assume a system abduco.
- **`/health` must keep returning the plaintext body `ok`.** Machine-readable info goes on `/version`.
- **The SPA fallback must never shadow backend routes.** Deny-prefix list (keep in sync with `apps/web/vite.config.ts` `navigateFallbackDenylist`, and note the server also has `/mcp`): `/trpc`, `/health`, `/version`, `/files`, `/client`, `/daemon`, `/hooks`, `/mcp`.
- **Name the wire version `WIRE_VERSION`** — do NOT reuse `PROTOCOL_VERSION`, which already exists in `apps/server/src/mcp-route.ts` for the unrelated MCP spec date.
- **Compiled-binary safety:** in a `bun build --compile` binary `import.meta.url` is not a real `file://` URL — guard any `fileURLToPath(new URL(..., import.meta.url))` so it cannot throw at startup.
- **Web UI is served by the server only for external clients.** The desktop window's bundled UI is Phase 3 and out of scope here.
- **Phase 1 builds for the build machine's own OS/arch only.** Cross-target matrix builds are Phase 4.
- **Work in a git worktree**, not the live `main` checkout. Lint with `bun run lint`, test with `bun run test`, commit after each task. Use `PODIUM_PORT=18799` in smoke tests to avoid the live `:18787`.

### Deferred to later phases (do NOT build here)
- Web "update needed" banner + client `pv` param → **Phase 2** (version-aware client).
- Tauri desktop window + bundled UI, sidecar supervision → **Phase 3**.
- Cross-target (`--target`) CI matrix + per-target abduco, signing → **Phase 4**.
- `podium update` self-update → **Phase 5**.

---

### Task 1: Server serves the web UI (external-client path)

**Files:**
- Create: `apps/server/src/static-web.ts`
- Create (test): `apps/server/src/static-web.test.ts`
- Modify: `apps/server/src/server.ts` (call after the tRPC middleware; guarded default dir)

**Interfaces:**
- Produces: `registerWebStatic(app: Hono, webDir: string): boolean` — registers a catch-all serving files under `webDir` with an `index.html` SPA fallback; returns `false` and registers nothing when `webDir`/`index.html` is absent. Must be called **after** all API routes.

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
  app.get('/trpc/x', (c) => c.text('api')) // API route registered BEFORE static

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
 * Keep in sync with apps/web/vite.config.ts navigateFallbackDenylist (+ /mcp, /version).
 */
const BACKEND_PREFIXES = [
  '/trpc',
  '/health',
  '/version',
  '/files',
  '/client',
  '/daemon',
  '/hooks',
  '/mcp',
]

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
 * Serve the built web bundle for EXTERNAL clients (browser / phone / another desktop
 * app connecting to a running machine). The Tauri desktop window uses its own bundled
 * UI, not this route. Returns false (registers nothing) when no build is present, so a
 * source/dev run or an API-only server is unaffected. Call AFTER the API routes.
 */
export function registerWebStatic(app: Hono, webDir: string): boolean {
  if (!existsSync(join(webDir, 'index.html'))) return false

  app.get('/*', (c) => {
    const pathname = new URL(c.req.url).pathname
    if (BACKEND_PREFIXES.some((pre) => pathname === pre || pathname.startsWith(`${pre}/`))) {
      return c.notFound()
    }
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

- [ ] **Step 4: Wire it into the server (compiled-binary-safe)**

In `apps/server/src/server.ts`, add the imports:

```ts
import { fileURLToPath } from 'node:url'
import { registerWebStatic } from './static-web'
```

After the `app.use('/trpc/*', trpcServer({...}))` block and before `return new Promise<ServerHandle>(...)`, add:

```ts
  // Serve the built web UI for external clients (browser/phone/other desktop). The
  // packaged headless bundle sets PODIUM_WEB_DIR; a source run defaults to apps/web/dist.
  // In a `bun build --compile` binary import.meta.url is not a file:// URL, so guard the
  // default — an unset PODIUM_WEB_DIR there simply means "API only", never a crash.
  let webDir = process.env.PODIUM_WEB_DIR
  if (!webDir) {
    try {
      webDir = fileURLToPath(new URL('../../web/dist', import.meta.url))
    } catch {
      webDir = ''
    }
  }
  if (webDir) registerWebStatic(app, webDir)
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `bun run test -- apps/server/src/static-web.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 6: Typecheck, lint, commit**

```bash
bun run --filter @podium/server typecheck
bun run lint
git add apps/server/src/static-web.ts apps/server/src/static-web.test.ts apps/server/src/server.ts
git commit -m "feat(server): serve the built web UI for external clients (SPA fallback, compile-safe)"
```

---

### Task 2: Wire protocol-version primitives

**Files:**
- Create: `packages/protocol/src/version.ts`
- Create (test): `packages/protocol/src/version.test.ts`
- Modify: `packages/protocol/src/index.ts` (re-export)

**Interfaces:**
- Produces: `WIRE_VERSION: number` (current wire version, `1`); `isProtocolCompatible(a: number, b: number): boolean` (true iff both are integers and equal). Consumed by Task 3.

- [ ] **Step 1: Write the failing test**

Create `packages/protocol/src/version.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { WIRE_VERSION, isProtocolCompatible } from './version'

describe('wire protocol version', () => {
  it('WIRE_VERSION is a positive integer', () => {
    expect(Number.isInteger(WIRE_VERSION)).toBe(true)
    expect(WIRE_VERSION).toBeGreaterThan(0)
  })
  it('same version is compatible', () => {
    expect(isProtocolCompatible(WIRE_VERSION, WIRE_VERSION)).toBe(true)
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
 * Podium WIRE protocol version (client↔server and server↔daemon message shapes in this
 * package). Bump on any breaking change. Distinct from the MCP spec-date constant in
 * apps/server/src/mcp-route.ts. Peers on different releases/machines compare this to
 * decide compatibility (see isProtocolCompatible) and tell the user to update on a miss.
 */
export const WIRE_VERSION = 1

/**
 * Two peers are compatible iff they share the same wire version. A single integer
 * today; this function is the seam for a major/minor scheme later.
 */
export function isProtocolCompatible(a: number, b: number): boolean {
  return Number.isInteger(a) && Number.isInteger(b) && a === b
}
```

- [ ] **Step 4: Re-export from the package index**

In `packages/protocol/src/index.ts`, add after `export * from './messages'`:

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
git commit -m "feat(protocol): add WIRE_VERSION + isProtocolCompatible"
```

---

### Task 3: Protocol-version handshake wiring (server + daemon)

**Files:**
- Modify: `apps/server/src/server.ts` (add `/version` route)
- Modify: `apps/server/src/wsServer.ts` (reject incompatible `pv` on upgrade)
- Modify: `apps/daemon/src/daemon.ts` (send `pv`, log on 426)
- Create (test): `apps/server/src/version-route.test.ts`

**Interfaces:**
- Consumes: `WIRE_VERSION`, `isProtocolCompatible` (Task 2).
- Produces: `GET /version` → `{ wireVersion: number, appVersion: string }`; the `/daemon`/`/client` upgrades reject with HTTP `426` when a present-but-incompatible `?pv=` is supplied (absent `pv` is allowed, so older peers still connect); the daemon connects with `?pv=WIRE_VERSION`.

- [ ] **Step 1: Write the failing test for `/version`**

Create `apps/server/src/version-route.test.ts`:

```ts
import { WIRE_VERSION } from '@podium/protocol'
import { Hono } from 'hono'
import { describe, expect, it } from 'vitest'
import { registerVersionRoute } from './server'

describe('GET /version', () => {
  it('reports the wire + app version as JSON', async () => {
    const app = new Hono()
    registerVersionRoute(app)
    const res = await app.request('/version')
    expect(res.status).toBe(200)
    const body = (await res.json()) as { wireVersion: number; appVersion: string }
    expect(body.wireVersion).toBe(WIRE_VERSION)
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
import { WIRE_VERSION } from '@podium/protocol'
```

(The file already imports `{ Hono } from 'hono'`; add the `type Hono` import alongside, or widen the existing import to also import the type.)

Add this exported helper above `startServer`:

```ts
/** Machine-readable version probe — distinct from /health (which stays plaintext "ok"). */
export function registerVersionRoute(app: Hono): void {
  app.get('/version', (c) =>
    c.json({
      wireVersion: WIRE_VERSION,
      appVersion: process.env.PODIUM_APP_VERSION ?? 'dev',
    }),
  )
}
```

Call it inside `startServer`, right after `app.get('/health', ...)`:

```ts
  registerVersionRoute(app)
```

- [ ] **Step 4: Run the `/version` test to verify it passes**

Run: `bun run test -- apps/server/src/version-route.test.ts`
Expected: PASS.

- [ ] **Step 5: Enforce `pv` on the WebSocket upgrade**

In `apps/server/src/wsServer.ts`, add to the imports:

```ts
import { WIRE_VERSION, isProtocolCompatible } from '@podium/protocol'
```

Replace the `server.on('upgrade', ...)` handler body so the URL is parsed once and an incompatible `pv` is rejected before per-path handling:

```ts
  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    const pathname = url.pathname
    // Reject a peer on an incompatible wire protocol with a clear 426 so it can tell the
    // user to update, rather than failing later on a malformed frame. A peer that sends
    // no `pv` (older client) is allowed through unchanged.
    if (pathname === '/daemon' || pathname === '/client') {
      if (
        url.searchParams.has('pv') &&
        !isProtocolCompatible(Number(url.searchParams.get('pv')), WIRE_VERSION)
      ) {
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

In `apps/daemon/src/daemon.ts`, add `WIRE_VERSION` to the existing `@podium/protocol` import block (the import that ends at line 77), e.g. add the named import:

```ts
import { WIRE_VERSION } from '@podium/protocol'
```

(or include `WIRE_VERSION` in the existing braces of that multi-line import.)

In `connect()` (line ~1487), change the WebSocket URL to carry the version and add an `unexpected-response` handler (the daemon uses the `ws` package — line 78 — so this event exists under Bun too). Replace:

```ts
      const w = new WebSocket(`${opts.serverUrl}/daemon`)
      currentWs = w
      w.on('open', onOpen)
      w.on('message', handleControlMessage)
```

with:

```ts
      const w = new WebSocket(`${opts.serverUrl}/daemon?pv=${WIRE_VERSION}`)
      currentWs = w
      w.on('open', onOpen)
      w.on('message', handleControlMessage)
      // Server rejected the upgrade (426 = wire-protocol mismatch). Surface it loudly;
      // 'close' still drives the backoff reconnect below.
      w.on('unexpected-response', (_req, res) => {
        if (res.statusCode === 426) {
          console.error(
            `[podium:daemon] server rejected this daemon: protocol mismatch (daemon pv=${WIRE_VERSION}). Update the daemon to match the server.`,
          )
        }
      })
```

- [ ] **Step 7: Verify the full suite still passes**

Run: `bun run test`
Expected: PASS (existing tests unaffected; the upgrade change is behavior-preserving when `pv` is absent or compatible).

- [ ] **Step 8: Typecheck, lint, commit**

```bash
bun run --filter @podium/server typecheck
bun run --filter @podium/daemon typecheck
bun run lint
git add apps/server/src/server.ts apps/server/src/version-route.test.ts apps/server/src/wsServer.ts apps/daemon/src/daemon.ts
git commit -m "feat(protocol): wire-version handshake — /version + pv upgrade guard + daemon pv"
```

---

### Task 4: Assemble the headless bundle

**Files:**
- Modify: `scripts/build-bun.ts` (stage `dist-bun/headless/` after compiling)
- Modify: `package.json` (add `package:headless` script)

**Interfaces:**
- Consumes: the compiled `dist-bun/podium-server` + `dist-bun/podium-daemon` (existing `build-bun.ts` output); `apps/web/dist` (built web).
- Produces: `dist-bun/headless/` = `podium-server`, `podium-daemon`, `web/` (copy of `apps/web/dist`), and an executable `podium` launcher (`all`/`server`/`daemon`). Running `dist-bun/headless/podium all` starts the whole backend with nothing installed and serves the UI to external clients.

- [ ] **Step 1: Add the `package:headless` script**

In `package.json` `scripts`, add (web must be built first so it can be staged):

```json
    "package:headless": "bun run --filter @podium/web build && bun scripts/build-bun.ts",
```

- [ ] **Step 2: Stage the headless bundle in `build-bun.ts`**

Append to `scripts/build-bun.ts` (after the existing `compile('scripts/daemon-compiled.ts', 'podium-daemon')` and final `console.log`). Add the imports it needs at the top alongside the existing `node:fs` import (`cpSync`, `chmodSync`, `writeFileSync`, `existsSync`):

```ts
// --- headless bundle: binaries + web + launcher ---------------------------------
const headless = `${out}/headless`
const webDist = `${root}apps/web/dist`
if (!existsSync(`${webDist}/index.html`)) {
  throw new Error('build-bun: apps/web/dist not built — run `bun run --filter @podium/web build` first')
}
mkdirSync(headless, { recursive: true })
for (const bin of ['podium-server', 'podium-daemon']) {
  cpSync(`${out}/${bin}`, `${headless}/${bin}`)
  chmodSync(`${headless}/${bin}`, 0o755)
}
cpSync(webDist, `${headless}/web`, { recursive: true })

const launcher = `#!/bin/sh
# Podium headless launcher. Subcommands: all (default) | server | daemon
DIR="$(cd "$(dirname "$0")" && pwd)"
export PODIUM_WEB_DIR="\${PODIUM_WEB_DIR:-$DIR/web}"
cmd="\${1:-all}"
[ $# -gt 0 ] && shift
case "$cmd" in
  all)
    "$DIR/podium-server" & SRV=$!
    "$DIR/podium-daemon" & DMN=$!
    trap 'kill $SRV $DMN 2>/dev/null' INT TERM
    wait ;;
  server) exec "$DIR/podium-server" "$@" ;;
  daemon) exec "$DIR/podium-daemon" "$@" ;;
  *) echo "usage: podium {all|server|daemon}" >&2; exit 2 ;;
esac
`
writeFileSync(`${headless}/podium`, launcher)
chmodSync(`${headless}/podium`, 0o755)
console.log(`[build-bun] headless bundle -> ${headless}`)
```

- [ ] **Step 3: Build the headless bundle**

Run: `bun run package:headless`
Expected: web build runs, abduco prebuilds, server + daemon compile, headless bundle prints. Confirm layout:

```bash
ls -1 dist-bun/headless
```
Expected: `podium`, `podium-server`, `podium-daemon`, `web/`.

- [ ] **Step 4: Smoke-test the headless bundle end-to-end**

This runs the COMPILED binaries (the real release path) with nothing else on PATH:

```bash
PODIUM_PORT=18799 dist-bun/headless/podium all &
SMOKE_PID=$!
sleep 4
curl -fsS http://localhost:18799/health; echo                       # -> ok
curl -fsS http://localhost:18799/version; echo                      # -> {"wireVersion":1,"appVersion":"dev"}
curl -fsS -o /dev/null -w '%{http_code}\n' http://localhost:18799/   # -> 200 (web shell served)
kill "$SMOKE_PID" 2>/dev/null; pkill -f 'dist-bun/headless/podium-' 2>/dev/null || true
```
Expected: `ok`; the version JSON with `"wireVersion":1`; `200`. This proves the compiled headless bundle serves the UI to an external client and the handshake route works, with only `dist-bun/headless/` on disk.

- [ ] **Step 5: Commit**

```bash
git add package.json scripts/build-bun.ts
git commit -m "build(bun): assemble headless bundle (server+daemon binaries + web + launcher)"
```

---

## Self-Review

**Spec coverage (revised spec §A "remaining" + §A.1–A.3, §E-partial):**
- §A.1 "Server serves the web UI for external clients, SPA fallback, never shadow backend routes (incl. /mcp)" → Task 1. ✓
- §A.2 "WIRE_VERSION + /version + pv upgrade guard + daemon pv" → Tasks 2 + 3 (named `WIRE_VERSION`, distinct from MCP's `PROTOCOL_VERSION`). ✓
- §A.3 "headless packaging layout: server + daemon binaries + web/ + podium launcher" → Task 4. ✓
- Compiled-binary `import.meta.url` guard (Global Constraints) → Task 1 Step 4. ✓
- Already-done items (compile, embedded abduco, Bun.Terminal PTY, SQLite shim) → not re-implemented. ✓
- Deferred correctly: client banner/`pv` (Phase 2), Tauri window (Phase 3), cross-target/signing (Phase 4), `podium update` (Phase 5).

**Placeholder scan:** No "TBD"/"add error handling"/"similar to". Every code step shows the real code. ✓

**Type/name consistency:** `registerWebStatic(app, webDir): boolean`, `registerVersionRoute(app): void`, `WIRE_VERSION`, `isProtocolCompatible(a,b)` used identically across tasks. The deny-prefix list matches between `static-web.ts` and the Global Constraints. The `/version` JSON shape (`{ wireVersion, appVersion }`) matches between Task 3's route and its test. ✓

## What Phase 1 delivers

A `dist-bun/headless/` bundle — the two compiled Bun binaries + web assets + a `podium` launcher — that runs the entire backend (relay + daemon + UI served to external clients) on a clean machine, with a wire-version handshake. This is the relocatable artifact set the rest builds on: Phase 2 pairs a second daemon, Phase 3 wraps these binaries as Tauri sidecars in the desktop app, Phase 4 cross-builds them per OS into installers, Phase 5 teaches them to self-update.
