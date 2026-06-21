# Packaging Phase 2 — Shared Setup & Deployment Modes (Implementation Plan)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A shared setup/mode layer both the CLI and (later) the Tauri shell drive: a `~/.podium/config.json` schema, a setup web UI + API that writes it, a config-driven backend in the web client, and a mode-driven `podium` CLI that starts the right processes for the chosen deployment mode.

**Architecture:** Add a runtime-neutral config module to `@podium/core` (the single source of truth). The server gains a `/setup/config` GET/POST API and the web app a `SetupGate` that shows a `SetupView` when no mode is configured. The web client learns its backend from an injected global (Tauri) ahead of the existing `?server=` / `window.location` fallbacks. A compiled `podium` CLI (`scripts/cli.ts` → `bun build --compile`) reads config + flags and starts the processes the mode calls for, replacing Phase 1's fixed shell launcher.

**Tech Stack:** TypeScript (ESM), **Bun** (runtime + `bun build --compile`), Hono, Zod, React 19, Vitest, Biome. Builds on branch `feat/packaging-phase1`.

## Global Constraints

- **Base branch is `feat/packaging-phase1`** (Phase 1, parked) — NOT `main`. This plan needs Phase 1's `/version`, `registerWebStatic`, and `dist-bun` build.
- **Backend runtime is Bun**; release artifacts are `bun build --compile` binaries. Do not reintroduce node-pty/esbuild bundling.
- **Config lives at `$PODIUM_STATE_DIR/config.json` else `~/.podium/config.json`** — honor `PODIUM_STATE_DIR` exactly as the rest of the code does (`packages/agent-bridge/src/abduco-bin.ts` pattern).
- **Deployment modes are exactly:** `all-in-one`, `daemon`, `client`, `server`. An unset `mode` means "not yet configured".
- **No-config default:** `podium` with no mode and no subcommand runs **`all-in-one`** immediately AND serves the setup UI (so the box is usable at once; the UI lets the user confirm or switch). Switching to a non-`all-in-one` mode writes config and prints a restart instruction.
- **Setup routes must not be shadowed by the SPA fallback** — add `/setup` to `BACKEND_PREFIXES` in `apps/server/src/static-web.ts` (the Phase 1 deny list).
- **Backend resolution order in the web client:** injected `window.__PODIUM_SERVER__` (Tauri) → `?server=` query → `window.location` (same-origin browser).
- **Known baseline:** ~24 pre-existing failing tests in `apps/web/*`, opencode discovery, and `pty-behavior.vitest`, plus a repo-wide `biome check .` with pre-existing errors — all unrelated. Verify only your scoped tests + touched-file lint. Do not chase baseline noise.
- **Work in a git worktree off `feat/packaging-phase1`**, not the live `main` checkout. Test with `bun run test -- <file>`; lint `bun run lint`; commit per task.

### Deferred to later phases (do NOT build here)
- Tauri shell / in-window setup driver → **Phase 3** (this phase only injects the seam: `window.__PODIUM_SERVER__` + the config/setup API the shell will call).
- Live reconfigure without restart, `client`-mode process niceties → keep v1 simple (restart on mode change).
- Pairing codes / multi-daemon → **Phase 6** (multi-machine). `daemon` mode here uses a plain `serverUrl` + the existing same-host `daemon.secret`.

---

### Task 1: Config schema + loader (`@podium/core`)

**Files:**
- Create: `packages/core/src/config.ts`
- Create (test): `packages/core/src/config.test.ts`
- Modify: `packages/core/src/index.ts` (re-export)

**Interfaces:**
- Produces: `PodiumMode` (zod enum `'all-in-one'|'daemon'|'client'|'server'`); `PodiumConfig` (zod object `{ mode?, serverUrl?, port? }`) + its inferred type; `configPath(): string`; `loadConfig(path?): PodiumConfig`; `saveConfig(config, path?): void`; `needsSetup(config): boolean`.

- [ ] **Step 1: Write the failing test**

Create `packages/core/src/config.test.ts`:

```ts
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { configPath, loadConfig, needsSetup, saveConfig } from './config'

describe('podium config', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'podium-cfg-'))
    process.env.PODIUM_STATE_DIR = dir
  })
  afterEach(() => {
    process.env.PODIUM_STATE_DIR = undefined
    rmSync(dir, { recursive: true, force: true })
  })

  it('configPath honors PODIUM_STATE_DIR', () => {
    expect(configPath()).toBe(join(dir, 'config.json'))
  })
  it('loadConfig returns {} when no file exists', () => {
    expect(loadConfig()).toEqual({})
  })
  it('save then load round-trips', () => {
    saveConfig({ mode: 'daemon', serverUrl: 'ws://host:18787' })
    expect(loadConfig()).toEqual({ mode: 'daemon', serverUrl: 'ws://host:18787' })
  })
  it('needsSetup is true with no mode, false once a mode is set', () => {
    expect(needsSetup({})).toBe(true)
    expect(needsSetup({ mode: 'all-in-one' })).toBe(false)
  })
  it('loadConfig tolerates a corrupt file by returning {}', () => {
    saveConfig({ mode: 'server' })
    const { writeFileSync } = require('node:fs')
    writeFileSync(configPath(), '{not json')
    expect(loadConfig()).toEqual({})
  })
  it('saveConfig rejects an invalid mode', () => {
    expect(() => saveConfig({ mode: 'bogus' } as never)).toThrow()
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun run test -- packages/core/src/config.test.ts`
Expected: FAIL — `Cannot find module './config'`.

- [ ] **Step 3: Implement `config.ts`**

Create `packages/core/src/config.ts`:

```ts
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { z } from 'zod'

/** Deployment mode chosen at setup. Unset = not yet configured. */
export const PodiumMode = z.enum(['all-in-one', 'daemon', 'client', 'server'])
export type PodiumMode = z.infer<typeof PodiumMode>

/** Persisted install config — the single source of truth shared by the CLI and the
 *  (later) Tauri shell. `serverUrl` is a ws://|wss:// relay URL for daemon/client modes. */
export const PodiumConfig = z.object({
  mode: PodiumMode.optional(),
  serverUrl: z.string().optional(),
  port: z.number().int().positive().optional(),
})
export type PodiumConfig = z.infer<typeof PodiumConfig>

/** $PODIUM_STATE_DIR/config.json, else ~/.podium/config.json. */
export function configPath(): string {
  const base = process.env.PODIUM_STATE_DIR ?? join(process.env.HOME || homedir(), '.podium')
  return join(base, 'config.json')
}

/** Read + validate the config; a missing or corrupt file yields {} (treated as "needs setup"). */
export function loadConfig(path = configPath()): PodiumConfig {
  if (!existsSync(path)) return {}
  try {
    return PodiumConfig.parse(JSON.parse(readFileSync(path, 'utf8')))
  } catch {
    return {}
  }
}

/** Validate + write the config (pretty JSON). Throws on an invalid config. */
export function saveConfig(config: PodiumConfig, path = configPath()): void {
  const parsed = PodiumConfig.parse(config)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${JSON.stringify(parsed, null, 2)}\n`)
}

/** True until a deployment mode has been chosen. */
export function needsSetup(config: PodiumConfig): boolean {
  return !config.mode
}
```

- [ ] **Step 4: Re-export from the package index**

In `packages/core/src/index.ts`, add:

```ts
export * from './config'
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `bun run test -- packages/core/src/config.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 6: Typecheck, lint, commit**

```bash
bun run --filter @podium/core typecheck
bun run lint
git add packages/core/src/config.ts packages/core/src/config.test.ts packages/core/src/index.ts
git commit -m "feat(core): podium config schema + load/save/needsSetup"
```

---

### Task 2: Setup API route (`apps/server`)

**Files:**
- Create: `apps/server/src/setup-route.ts`
- Create (test): `apps/server/src/setup-route.test.ts`
- Modify: `apps/server/src/server.ts` (register the route after `registerVersionRoute`)
- Modify: `apps/server/src/static-web.ts` (add `/setup` to `BACKEND_PREFIXES`)

**Interfaces:**
- Consumes: `PodiumConfig`, `loadConfig`, `saveConfig`, `needsSetup` (Task 1).
- Produces: `registerSetupRoute(app: Hono): void` — `GET /setup/config` → `{ config, needsSetup }`; `POST /setup/config` (JSON body = a `PodiumConfig`) → `{ ok: true, config }` on success, `400 { error }` on bad JSON / invalid config.

- [ ] **Step 1: Write the failing test**

Create `apps/server/src/setup-route.test.ts`:

```ts
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Hono } from 'hono'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { registerSetupRoute } from './setup-route'

describe('setup route', () => {
  let dir: string
  let app: Hono
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'podium-setup-'))
    process.env.PODIUM_STATE_DIR = dir
    app = new Hono()
    registerSetupRoute(app)
  })
  afterEach(() => {
    process.env.PODIUM_STATE_DIR = undefined
    rmSync(dir, { recursive: true, force: true })
  })

  it('GET reports needsSetup true when unconfigured', async () => {
    const res = await app.request('/setup/config')
    expect(res.status).toBe(200)
    const body = (await res.json()) as { needsSetup: boolean; config: unknown }
    expect(body.needsSetup).toBe(true)
    expect(body.config).toEqual({})
  })
  it('POST a valid config persists it and clears needsSetup', async () => {
    const post = await app.request('/setup/config', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ mode: 'daemon', serverUrl: 'ws://host:18787' }),
    })
    expect(post.status).toBe(200)
    const get = await app.request('/setup/config')
    const body = (await get.json()) as { needsSetup: boolean; config: { mode: string } }
    expect(body.needsSetup).toBe(false)
    expect(body.config.mode).toBe('daemon')
  })
  it('POST an invalid mode is rejected with 400', async () => {
    const res = await app.request('/setup/config', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ mode: 'bogus' }),
    })
    expect(res.status).toBe(400)
  })
  it('POST invalid JSON is rejected with 400', async () => {
    const res = await app.request('/setup/config', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{not json',
    })
    expect(res.status).toBe(400)
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun run test -- apps/server/src/setup-route.test.ts`
Expected: FAIL — `Cannot find module './setup-route'`.

- [ ] **Step 3: Implement `setup-route.ts`**

Create `apps/server/src/setup-route.ts`:

```ts
import { type PodiumConfig as PodiumConfigType, loadConfig, needsSetup, saveConfig } from '@podium/core'
import { PodiumConfig } from '@podium/core'
import type { Hono } from 'hono'

/**
 * Shared setup API. The setup web UI (apps/web SetupView) reads the current config and
 * writes the chosen deployment mode here. The CLI / Tauri shell read the same config file.
 */
export function registerSetupRoute(app: Hono): void {
  app.get('/setup/config', (c) => {
    const config = loadConfig()
    return c.json({ config, needsSetup: needsSetup(config) })
  })

  app.post('/setup/config', async (c) => {
    let body: unknown
    try {
      body = await c.req.json()
    } catch {
      return c.json({ error: 'invalid json' }, 400)
    }
    const parsed = PodiumConfig.safeParse(body)
    if (!parsed.success) {
      return c.json({ error: 'invalid config', issues: parsed.error.issues }, 400)
    }
    const config: PodiumConfigType = parsed.data
    saveConfig(config)
    return c.json({ ok: true, config })
  })
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun run test -- apps/server/src/setup-route.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Wire into the server + deny-list**

In `apps/server/src/server.ts`, add the import:

```ts
import { registerSetupRoute } from './setup-route'
```

and call it inside `startServer` right after `registerVersionRoute(app)`:

```ts
  registerSetupRoute(app)
```

In `apps/server/src/static-web.ts`, add `'/setup'` to the `BACKEND_PREFIXES` array (so the SPA fallback never shadows the setup API):

```ts
const BACKEND_PREFIXES = [
  '/trpc',
  '/health',
  '/version',
  '/setup',
  '/files',
  '/client',
  '/daemon',
  '/hooks',
  '/mcp',
]
```

- [ ] **Step 6: Verify server tests still pass, typecheck, lint, commit**

```bash
bun run test -- apps/server
bun run --filter @podium/server typecheck
bun run lint
git add apps/server/src/setup-route.ts apps/server/src/setup-route.test.ts apps/server/src/server.ts apps/server/src/static-web.ts
git commit -m "feat(server): /setup/config GET+POST API + deny-list /setup from SPA fallback"
```

---

### Task 3: Config-driven backend in the web client

**Files:**
- Modify: `apps/web/src/trpc.ts` (`serverConfig` honors an injected global first)
- Create (test): `apps/web/src/trpc.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: `serverConfig(loc)` resolution order = injected `window.__PODIUM_SERVER__` (a ws:// URL) → `?server=` → same-origin from `loc`. (Unchanged return shape `ServerConfig`.)

- [ ] **Step 1: Write the failing test**

Create `apps/web/src/trpc.test.ts`:

```ts
import { afterEach, describe, expect, it } from 'vitest'
import { serverConfig } from './trpc'

const loc = (over: Partial<Location>): Location =>
  ({ protocol: 'http:', host: 'localhost:5173', origin: 'http://localhost:5173', search: '', ...over }) as Location

describe('serverConfig backend resolution', () => {
  afterEach(() => {
    ;(globalThis as { __PODIUM_SERVER__?: string }).__PODIUM_SERVER__ = undefined
  })

  it('prefers the injected global over location', () => {
    ;(globalThis as { __PODIUM_SERVER__?: string }).__PODIUM_SERVER__ = 'ws://remote:18787'
    const cfg = serverConfig(loc({}))
    expect(cfg.wsClientUrl).toBe('ws://remote:18787/client')
    expect(cfg.httpOrigin).toBe('http://remote:18787')
    expect(cfg.override).toBe(true)
  })
  it('falls back to ?server= when no global', () => {
    const cfg = serverConfig(loc({ search: '?server=wss://q:443' }))
    expect(cfg.wsClientUrl).toBe('wss://q:443/client')
    expect(cfg.override).toBe(true)
  })
  it('falls back to same-origin from location', () => {
    const cfg = serverConfig(loc({ protocol: 'https:', host: 'h:1', origin: 'https://h:1' }))
    expect(cfg.wsClientUrl).toBe('wss://h:1/client')
    expect(cfg.httpOrigin).toBe('https://h:1')
    expect(cfg.override).toBe(false)
  })
  it('ignores a malformed injected global and falls through', () => {
    ;(globalThis as { __PODIUM_SERVER__?: string }).__PODIUM_SERVER__ = 'not-a-url'
    const cfg = serverConfig(loc({}))
    expect(cfg.override).toBe(false)
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun run test -- apps/web/src/trpc.test.ts`
Expected: FAIL — the first assertion (injected global) fails because `serverConfig` doesn't read it yet.

- [ ] **Step 3: Implement the injected-global source**

In `apps/web/src/trpc.ts`, replace the body of `serverConfig`:

```ts
export function serverConfig(loc: Location): ServerConfig {
  // 1. Backend injected by the Tauri shell / headless setup (a ws://|wss:// URL).
  const injected = (globalThis as { __PODIUM_SERVER__?: string }).__PODIUM_SERVER__
  const fromInjected = injected ? parseServerOrigin(injected) : null
  if (fromInjected) return { ...fromInjected, override: true }
  // 2. Explicit ?server= override.
  const parsed = parseServer(loc.search)
  if (parsed) return { ...parsed, override: true }
  // 3. Same-origin derived from window.location.
  const wsProto = loc.protocol === 'https:' ? 'wss:' : 'ws:'
  return { wsClientUrl: `${wsProto}//${loc.host}/client`, httpOrigin: loc.origin, override: false }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun run test -- apps/web/src/trpc.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Typecheck, lint, commit**

```bash
bun run --filter @podium/web typecheck
bun run lint
git add apps/web/src/trpc.ts apps/web/src/trpc.test.ts
git commit -m "feat(web): serverConfig honors injected __PODIUM_SERVER__ backend"
```

---

### Task 4: Setup UI gate (`apps/web`)

**Files:**
- Create: `apps/web/src/SetupView.tsx`
- Create: `apps/web/src/SetupGate.tsx`
- Create (test): `apps/web/src/SetupView.test.tsx`
- Modify: `apps/web/src/main.tsx` (wrap `<AppShell/>` in `<SetupGate>`)

**Interfaces:**
- Consumes: `serverConfig` (Task 3) for the backend origin; `GET/POST /setup/config` (Task 2).
- Produces: `SetupView({ httpOrigin, onSaved })` — renders mode choices + a server-URL field (for `daemon`/`client`) + Save (POSTs config, calls `onSaved`); `SetupGate({ children })` — fetches `/setup/config`, renders `SetupView` when `needsSetup`, else `children`.

- [ ] **Step 1: Write the failing test**

Create `apps/web/src/SetupView.test.tsx`:

```tsx
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SetupView } from './SetupView'

afterEach(() => vi.restoreAllMocks())

describe('SetupView', () => {
  it('renders the four deployment modes', () => {
    render(<SetupView httpOrigin="http://localhost:18787" onSaved={() => {}} />)
    expect(screen.getByText(/all-in-one/i)).toBeTruthy()
    expect(screen.getByText(/^daemon/i)).toBeTruthy()
    expect(screen.getByText(/client/i)).toBeTruthy()
    expect(screen.getByText(/server/i)).toBeTruthy()
  })

  it('POSTs the selected mode and calls onSaved', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ ok: true }) })
    vi.stubGlobal('fetch', fetchMock)
    const onSaved = vi.fn()
    render(<SetupView httpOrigin="http://localhost:18787" onSaved={onSaved} />)
    fireEvent.click(screen.getByLabelText(/all-in-one/i))
    fireEvent.click(screen.getByText(/save|continue|start/i))
    await waitFor(() => expect(onSaved).toHaveBeenCalled())
    const [url, opts] = fetchMock.mock.calls[0]
    expect(url).toBe('http://localhost:18787/setup/config')
    expect(JSON.parse(opts.body)).toMatchObject({ mode: 'all-in-one' })
  })
})
```

> Uses `@testing-library/react`. If it is not already a devDependency of `@podium/web`, add it in Step 3 (`bun add -d @testing-library/react` in the worktree) before implementing — the existing web tests use the happy-dom environment configured in `vitest.config.ts`.

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun run test -- apps/web/src/SetupView.test.tsx`
Expected: FAIL — `Cannot find module './SetupView'` (or a missing `@testing-library/react`, which Step 3 resolves).

- [ ] **Step 3: Implement `SetupView.tsx` and `SetupGate.tsx`**

If needed: `bun add -d @testing-library/react` (run in the worktree root).

Create `apps/web/src/SetupView.tsx`:

```tsx
import { type ReactNode, useState } from 'react'
import type { PodiumMode } from '@podium/core'

const MODES: { id: PodiumMode; title: string; blurb: string; needsServer: boolean }[] = [
  { id: 'all-in-one', title: 'All-in-one (this computer)', blurb: 'Run the server + agent daemon here.', needsServer: false },
  { id: 'daemon', title: 'Daemon → external server', blurb: 'Contribute this machine to a server elsewhere.', needsServer: true },
  { id: 'client', title: 'Client → external server', blurb: 'Just connect to a server running elsewhere.', needsServer: true },
  { id: 'server', title: 'Server only', blurb: 'Run the relay here; daemons live elsewhere.', needsServer: false },
]

export function SetupView({ httpOrigin, onSaved }: { httpOrigin: string; onSaved: () => void }): ReactNode {
  const [mode, setMode] = useState<PodiumMode>('all-in-one')
  const [serverUrl, setServerUrl] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const needsServer = MODES.find((m) => m.id === mode)?.needsServer ?? false

  const save = async (): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      const body = needsServer ? { mode, serverUrl } : { mode }
      const res = await fetch(`${httpOrigin}/setup/config`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
      if (!res.ok) throw new Error(`setup failed (${res.status})`)
      onSaved()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="setup-view">
      <h1>Welcome to Podium</h1>
      <p>How should this install run?</p>
      <fieldset>
        {MODES.map((m) => (
          <label key={m.id}>
            <input type="radio" name="mode" value={m.id} checked={mode === m.id} onChange={() => setMode(m.id)} />
            <strong>{m.title}</strong>
            <span>{m.blurb}</span>
          </label>
        ))}
      </fieldset>
      {needsServer && (
        <label>
          Server URL
          <input type="text" placeholder="ws://host:18787" value={serverUrl} onChange={(e) => setServerUrl(e.target.value)} />
        </label>
      )}
      {error && <p role="alert">{error}</p>}
      <button type="button" disabled={busy} onClick={() => void save()}>
        {busy ? 'Saving…' : 'Save & start'}
      </button>
    </div>
  )
}
```

Create `apps/web/src/SetupGate.tsx`:

```tsx
import { type ReactNode, useEffect, useState } from 'react'
import { SetupView } from './SetupView'
import { serverConfig } from './trpc'

type Phase = 'loading' | 'setup' | 'ready'

/** Gates the app on setup: shows SetupView until a deployment mode is configured. */
export function SetupGate({ children }: { children: ReactNode }): ReactNode {
  const [phase, setPhase] = useState<Phase>('loading')
  const httpOrigin = serverConfig(window.location).httpOrigin

  useEffect(() => {
    let alive = true
    fetch(`${httpOrigin}/setup/config`)
      .then((r) => r.json())
      .then((d: { needsSetup: boolean }) => alive && setPhase(d.needsSetup ? 'setup' : 'ready'))
      .catch(() => alive && setPhase('ready')) // a backend without the route → don't block the app
    return () => {
      alive = false
    }
  }, [httpOrigin])

  if (phase === 'loading') return null
  if (phase === 'setup') return <SetupView httpOrigin={httpOrigin} onSaved={() => window.location.reload()} />
  return <>{children}</>
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun run test -- apps/web/src/SetupView.test.tsx`
Expected: PASS (2 tests).

- [ ] **Step 5: Wire the gate into the app root**

In `apps/web/src/main.tsx`, wrap `<AppShell/>`:

```tsx
import { SetupGate } from './SetupGate'
// …
createRoot(root).render(
  <StrictMode>
    <ThemeProvider>
      <SetupGate>
        <AppShell />
      </SetupGate>
    </ThemeProvider>
  </StrictMode>,
)
```

- [ ] **Step 6: Typecheck, lint, commit**

```bash
bun run --filter @podium/web typecheck
bun run lint
git add apps/web/src/SetupView.tsx apps/web/src/SetupGate.tsx apps/web/src/SetupView.test.tsx apps/web/src/main.tsx
[ -f package.json ] && git add package.json bun.lock
git commit -m "feat(web): setup gate + SetupView (choose deployment mode)"
```

---

### Task 5: Mode-driven `podium` CLI

**Files:**
- Create: `scripts/cli.ts` (compiled entry; the `podium` binary)
- Create (test): `scripts/cli.test.ts` (unit-tests the pure arg/mode resolver)
- Modify: `scripts/build-bun.ts` (compile `scripts/cli.ts` → `dist-bun/podium`; stage it as the headless launcher instead of the shell script)

**Interfaces:**
- Consumes: `loadConfig`, `needsSetup`, `PodiumMode` (Task 1); `startServer` (`apps/server/src/server.ts`); `startDaemon` (`apps/daemon/src/daemon.ts`).
- Produces: `resolvePlan(argv: string[], config: PodiumConfig): { mode: PodiumMode; serverUrl?: string; showSetupHint: boolean }` — pure resolver: an explicit subcommand wins; else `config.mode`; else default `all-in-one` with `showSetupHint=true`. Exported for unit testing; `main()` consumes it.

- [ ] **Step 1: Write the failing test for the resolver**

Create `scripts/cli.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { resolvePlan } from './cli'

describe('resolvePlan', () => {
  it('defaults to all-in-one + setup hint when nothing is configured', () => {
    expect(resolvePlan([], {})).toEqual({ mode: 'all-in-one', showSetupHint: true })
  })
  it('uses the configured mode when present', () => {
    expect(resolvePlan([], { mode: 'server' })).toEqual({ mode: 'server', showSetupHint: false })
  })
  it('an explicit subcommand overrides config', () => {
    expect(resolvePlan(['daemon'], { mode: 'all-in-one' })).toMatchObject({ mode: 'daemon' })
  })
  it('--server flag is carried into the plan', () => {
    expect(resolvePlan(['daemon', '--server', 'ws://h:1'], {})).toMatchObject({
      mode: 'daemon',
      serverUrl: 'ws://h:1',
    })
  })
  it('config.serverUrl is used when no flag', () => {
    expect(resolvePlan(['daemon'], { serverUrl: 'ws://cfg:1' })).toMatchObject({ serverUrl: 'ws://cfg:1' })
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun run test -- scripts/cli.test.ts`
Expected: FAIL — `Cannot find module './cli'` (or `resolvePlan` undefined).

- [ ] **Step 3: Implement `scripts/cli.ts`**

Create `scripts/cli.ts`:

```ts
/**
 * `podium` CLI — the mode-driven launcher (compiled via `bun build --compile`). Reads
 * ~/.podium/config.json + argv and starts the processes the deployment mode calls for.
 * With no config and no subcommand it runs `all-in-one` immediately AND serves the setup
 * UI (printed URL), so the box is usable at once; switching modes in the UI writes config
 * and asks for a restart.
 */
import { type PodiumConfig, type PodiumMode, loadConfig, needsSetup } from '@podium/core'
import { startDaemon } from '../apps/daemon/src/daemon'
import { startServer } from '../apps/server/src/server'

export interface LaunchPlan {
  mode: PodiumMode
  serverUrl?: string
  showSetupHint: boolean
}

const SUBCOMMANDS: PodiumMode[] = ['all-in-one', 'daemon', 'client', 'server']

/** Pure resolver: explicit subcommand > config.mode > default all-in-one (+setup hint). */
export function resolvePlan(argv: string[], config: PodiumConfig): LaunchPlan {
  const sub = argv.find((a) => (SUBCOMMANDS as string[]).includes(a)) as PodiumMode | undefined
  // `all` is a friendly alias for all-in-one.
  const aliased = argv.includes('all') ? 'all-in-one' : undefined
  const flagIdx = argv.indexOf('--server')
  const serverFlag = flagIdx >= 0 ? argv[flagIdx + 1] : undefined
  const mode = sub ?? aliased ?? config.mode ?? 'all-in-one'
  const showSetupHint = !sub && !aliased && needsSetup(config)
  const serverUrl = serverFlag ?? config.serverUrl
  return serverUrl ? { mode, serverUrl, showSetupHint } : { mode, showSetupHint }
}

async function main(): Promise<void> {
  const plan = resolvePlan(process.argv.slice(2), loadConfig())
  const port = Number(process.env.PODIUM_PORT ?? 18787)

  if (plan.mode === 'client') {
    const url = plan.serverUrl ?? '(no serverUrl configured)'
    console.log(`podium client mode — open the web UI pointed at ${url}`)
    return
  }

  const runServer = plan.mode === 'all-in-one' || plan.mode === 'server'
  const runDaemon = plan.mode === 'all-in-one' || plan.mode === 'daemon'

  let serverPort = port
  if (runServer) {
    const server = await startServer({ port })
    serverPort = server.port
    console.log(`podium server up on http://localhost:${serverPort}`)
    if (plan.showSetupHint) {
      console.log(`\n  → Open setup:  http://localhost:${serverPort}/\n`)
    }
  }
  if (runDaemon) {
    const serverUrl = plan.mode === 'daemon' ? plan.serverUrl : `ws://localhost:${serverPort}`
    if (!serverUrl) {
      console.error('podium daemon mode needs a serverUrl (config.serverUrl or --server)')
      process.exit(2)
    }
    await startDaemon({ serverUrl })
    console.log(`podium daemon up → ${serverUrl}`)
  }

  // Stay alive until a signal.
  await new Promise(() => {})
}

// Only run main() when executed (not when imported by the unit test).
if (import.meta.main) {
  void main()
}
```

> `import.meta.main` is true only when this file is the entry, so the test can import `resolvePlan` without booting the server. (Bun supports `import.meta.main`.)

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun run test -- scripts/cli.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Compile `podium` and stage it as the headless launcher**

In `scripts/build-bun.ts`, add a third compile and replace the shell-script launcher with the compiled `podium`:

After `compile('scripts/daemon-compiled.ts', 'podium-daemon')`, add:

```ts
compile('scripts/cli.ts', 'podium')
```

In the headless-staging block (added in Phase 1), copy the compiled `podium` instead of writing the shell script. Replace the `writeFileSync(\`${headless}/podium\`, launcher)` + `chmodSync` lines with:

```ts
cpSync(`${out}/podium`, `${headless}/podium`)
chmodSync(`${headless}/podium`, 0o755)
```

and remove the now-unused `launcher` string. Keep the `PODIUM_WEB_DIR` wiring by exporting it from a tiny wrapper — instead, the compiled `podium` reads `PODIUM_WEB_DIR` from its env; set a default in the headless bundle by writing a one-line `podium.env`? No — simpler: the compiled CLI already relies on the server's `PODIUM_WEB_DIR` default. For the headless bundle, keep a thin `podium` shell shim that sets `PODIUM_WEB_DIR` then execs the compiled binary. Concretely, name the compiled binary `podium-cli` and write the launcher shell as:

```ts
cpSync(`${out}/podium`, `${headless}/podium-cli`)
chmodSync(`${headless}/podium-cli`, 0o755)
const launcher = `#!/bin/sh
DIR="$(cd "$(dirname "$0")" && pwd)"
export PODIUM_WEB_DIR="\${PODIUM_WEB_DIR:-$DIR/web}"
exec "$DIR/podium-cli" "$@"
`
writeFileSync(`${headless}/podium`, launcher)
chmodSync(`${headless}/podium`, 0o755)
```

(So `dist-bun/headless/podium` is the shell entry that sets `PODIUM_WEB_DIR` and execs the compiled `podium-cli`. The old `all`/`server`/`daemon` shell dispatch is gone — the compiled CLI handles modes.)

- [ ] **Step 6: Build + smoke-test the mode-driven bundle (isolated from the live host)**

```bash
bun run package:headless
ls -1 dist-bun/headless   # podium, podium-cli, podium-server, podium-daemon, web/
SMOKE_STATE=$(mktemp -d)
PODIUM_STATE_DIR="$SMOKE_STATE" PODIUM_PORT=18799 dist-bun/headless/podium &
sleep 5
curl -fsS http://localhost:18799/health; echo                 # ok
curl -fsS http://localhost:18799/setup/config; echo           # {"config":{},"needsSetup":true}
curl -fsS -o /dev/null -w '%{http_code}\n' http://localhost:18799/   # 200 (setup UI served)
pkill -f 'dist-bun/headless/podium-server' 2>/dev/null
pkill -f 'dist-bun/headless/podium-daemon' 2>/dev/null
pkill -f 'dist-bun/headless/podium-cli' 2>/dev/null
rm -rf "$SMOKE_STATE"
```
Expected: `ok`; `needsSetup":true`; `200`. (No-config `podium` ran all-in-one AND served setup.)

- [ ] **Step 7: Commit**

```bash
git add scripts/cli.ts scripts/cli.test.ts scripts/build-bun.ts
git commit -m "feat(cli): mode-driven podium launcher (config + flags) replacing the shell dispatch"
```

---

## Self-Review

**Spec coverage (Component F):**
- Config `~/.podium/config.json` (`mode`, `serverUrl`, `port`) → Task 1. ✓
- Mode-driven `podium` launcher (config + flags; no-config → all-in-one + setup hint) → Task 5. ✓
- Shared setup web UI + setup API writing config → Tasks 2 + 4. ✓
- Config-driven backend discovery in the web client (injected → `?server=` → location) → Task 3. ✓
- Deployment modes `all-in-one|daemon|client|server` → Task 1 enum + Task 5 dispatch. ✓
- Verifiable headlessly on Linux (no Tauri) → Task 5 Step 6 smoke. ✓
- Deferred correctly: Tauri driver (Phase 3) consumes `__PODIUM_SERVER__` (Task 3) + the setup API (Task 2); pairing/multi-daemon (Phase 6).

**Placeholder scan:** No "TBD"/"add validation"/"similar to". Every code step has real code. Task 5 Step 5's binary-naming nuance (`podium` shell shim → `podium-cli` compiled) is spelled out explicitly.

**Type/name consistency:** `PodiumConfig`/`PodiumMode`/`loadConfig`/`saveConfig`/`needsSetup`/`configPath` (Task 1) used identically in Tasks 2 + 5. `registerSetupRoute` (Task 2) matches its call in `server.ts`. `serverConfig` shape unchanged (Task 3). `SetupView({httpOrigin,onSaved})` + `SetupGate({children})` (Task 4) consistent. `resolvePlan(argv, config)` (Task 5) matches its test. `/setup/config` body shape (`{config, needsSetup}` / `{ok, config}`) matches between Task 2 route and Task 4 fetch.

## What Phase 2 delivers

The shared setup/mode foundation: a config source of truth, a setup UI/API, config-driven web backend, and a mode-driven `podium` CLI — all verified headlessly on Linux. Phase 3 (Tauri) becomes a thin driver: bundle the binaries as sidecars, inject `__PODIUM_SERVER__`, and show the same setup UI in-window with `all-in-one` preselected.
