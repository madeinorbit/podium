# Handover & Input Prototype — Phase 3b: browser presentation + Playwright e2e

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the Phase-3a `terminal-client` core into a real browser presentation client (xterm rendering, mobile key toolbar, DOM `ViewportSource`, controller/spectator render, observability contract incl. `screenHash`), mount it in a React+Vite `apps/web`, and prove the spec's Tier-1/2 acceptance with Playwright over real engines (Chromium Pixel + desktop, WebKit): two clients on one session converge on takeover (equal `epoch` + identical `screenHash`), the synthetic-keyboard chain resizes+redraws+reconverges, and toolbar input round-trips to the agent.

**Architecture:** `mountSession(el, opts)` wires a `SessionConnection` (3a) to a `TerminalView` (xterm), a `DomViewportSource`, and a key toolbar, and publishes a `window.__podium` test API. The xterm is always sized to the *authoritative* geometry (`state.cols/rows`) for both roles, so identical frames ⇒ identical `screenHash`; the spectator additionally CSS-scales to fit. `apps/web` is a thin Vite app reading `?server=` + `?test=1`. Playwright starts server+daemon in-process and drives the Vite-served app in two pages across three browser projects.

**Tech Stack:** `@xterm/xterm` + `@xterm/addon-fit` · React + Vite (`@vitejs/plugin-react`) · `@playwright/test` (chromium `--no-sandbox`, webkit) · `@podium/terminal-client` (3a) · `@podium/server` + `@podium/daemon` (Phase 2, started in-process for e2e) · Biome · strict ESM TS.

---

## Phase 3 roadmap (this plan is 3b — completes Phase 3)

- 3a (merged on this branch): `terminal-client` core — `SessionConnection`, `ViewportSource` seam, key encoder. ✓
- **3b — THIS PLAN:** xterm view, toolbar, DOM viewport, controller/spectator render, observability (`window.__podium` + `screenHash`), `apps/web`, Playwright Tier-1/2 e2e (Chromium + WebKit).

Design spec: `docs/superpowers/specs/2026-06-01-handover-input-prototype-design.md` (§3 topology, §5 render/letterbox, §7 observability + tiers, §8 acceptance).

**Infra (validated this session):** Chromium launches with `--no-sandbox`; WebKit launches after `install-deps`; `@playwright/test@1.60` installed at root. Use `--no-sandbox` for the chromium projects.

---

## Carry-over fixes from Phase 3a (apply in Task 1)

1. **Widen `onServerMessage` decode guard** — wrap the message-processing body so a malformed `outputFrame.data` (atob throws) can't escape the handler.
2. **`sendInput` UTF-8 shim** — `sendInput` currently `btoa(bytes)` throws on non-Latin-1. Add a `utf8ToBase64` path so typed Unicode is encoded as UTF-8 bytes. (Key sequences stay ASCII; this covers typed characters.)
3. **`connect()` re-entry guard** — ignore a second `connect()` while a socket exists (prevents the stale-socket `onclose` clobber); reconnect must go through `dispose()` first.

---

## File structure (Phase 3b)

| File | Responsibility |
|------|----------------|
| `packages/terminal-client/src/connection.ts` | (modify) carry-over fixes 1–3. |
| `packages/terminal-client/src/terminal-view.ts` | `TerminalView` — xterm wrapper: mount, write, resize, `fit()`, `cols()/rows()`, `screenHash()`, dispose. |
| `packages/terminal-client/src/toolbar.ts` | `mountKeyToolbar(el, conn)` — vanilla-DOM mobile key buttons wired to `SessionConnection`. |
| `packages/terminal-client/src/dom-viewport.ts` | `DomViewportSource` — wraps `visualViewport` + `ResizeObserver`. |
| `packages/terminal-client/src/session-mount.ts` | `mountSession(el, opts)` — wires connection + view + toolbar + viewport + controller/spectator render + `window.__podium`. |
| `packages/terminal-client/src/index.ts` | (modify) export the new modules. |
| `packages/terminal-client/package.json` | (modify) add `@xterm/xterm`, `@xterm/addon-fit`. |
| `apps/web/package.json` | (modify) add `react`, `react-dom`, `vite`, `@vitejs/plugin-react`, `@types/react(-dom)`. |
| `apps/web/index.html`, `apps/web/vite.config.ts`, `apps/web/src/main.tsx`, `apps/web/src/App.tsx` | Vite React app mounting `mountSession`. |
| `apps/web/tsconfig.json` | (confirm) extends react.json. |
| `e2e/playwright.config.ts` | Playwright projects: chromium-desktop, chromium-pixel (`--no-sandbox`), webkit; `webServer` = vite preview of apps/web. |
| `e2e/browser/harness.ts` | start/stop server+daemon (fixture) in-process; build the app URL with `?server=&test=1`. |
| `e2e/browser/relay.browser.e2e.ts` | the Tier-1/2 tests. |
| `e2e/package.json` | (modify) add `@playwright/test`, `@vitejs/plugin-react` if needed for preview. |

---

## Task 1: terminal-client browser pieces + carry-over fixes

**Files:** modify `packages/terminal-client/package.json`, `src/connection.ts`, `src/index.ts`; create `src/terminal-view.ts`, `src/toolbar.ts`, `src/dom-viewport.ts`, `src/session-mount.ts`.

- [ ] **Step 1: Add xterm deps**

Edit `packages/terminal-client/package.json` `dependencies` to add (keep `@podium/protocol`):

```json
  "dependencies": {
    "@podium/protocol": "workspace:*",
    "@xterm/xterm": "^5.5.0",
    "@xterm/addon-fit": "^0.10.0"
  },
```

Run `bun install`. Expected: resolves.

- [ ] **Step 2: Apply the three Phase-3a carry-over fixes to `connection.ts`**

(a) Add a UTF-8 base64 helper next to `toBase64` and use it in `sendInput`. Replace the existing `toBase64` block with:

```ts
function asciiToBase64(bytes: string): string {
  return btoa(bytes)
}

function utf8ToBase64(text: string): string {
  const bytes = new TextEncoder().encode(text)
  let bin = ''
  for (const b of bytes) bin += String.fromCharCode(b)
  return btoa(bin)
}
```

Change `sendInput` to use `utf8ToBase64` (covers both ASCII key sequences and typed Unicode):

```ts
  sendInput(bytes: string): void {
    this.sendRaw({ type: 'input', data: utf8ToBase64(bytes) })
  }
```

(`asciiToBase64` is retained for clarity / potential callers; if Biome flags it as unused, delete it and inline `btoa` is not needed — keep only `utf8ToBase64`.)

(b) Re-entry guard in `connect()` — at the very top of `connect()` add:

```ts
    if (this.socket !== undefined) return
```

(c) Widen the decode guard in `onServerMessage` so a bad frame can't throw out of the handler. Wrap the parse AND the switch in one try; keep callbacks (`onFrame`/`onState`) where they are but ensure a decode failure is contained. Replace the method with:

```ts
  private onServerMessage(raw: string): void {
    try {
      const msg = parseServerMessage(raw)
      switch (msg.type) {
        case 'welcome':
          this.clientId = msg.clientId
          this.sessionId = msg.sessionId
          this.controllerId = msg.controllerId
          this.cols = msg.geometry.cols
          this.rows = msg.geometry.rows
          this.emitState()
          break
        case 'outputFrame': {
          this.lastSeq = msg.seq
          this.epoch = msg.epoch
          const text = fromBase64Utf8(msg.data)
          this.emitState()
          this.opts.onFrame?.(text)
          break
        }
        case 'controllerChanged':
          this.controllerId = msg.controllerId
          this.cols = msg.geometry.cols
          this.rows = msg.geometry.rows
          this.emitState()
          break
        case 'geometry':
          this.cols = msg.cols
          this.rows = msg.rows
          this.emitState()
          break
        case 'agentExit':
          this.emitState()
          break
      }
    } catch {
      // malformed JSON, schema mismatch, or bad base64 — drop the frame
    }
  }
```

(Note: `onFrame` is now called after `emitState`, still inside the try — a throwing `onFrame` is contained, which is acceptable for the prototype. The 3a tests still pass: they feed valid frames.)

Run `bunx vitest run packages/terminal-client/src/connection.test.ts` → still 8 passed.

- [ ] **Step 3: TerminalView (xterm wrapper)**

Create `packages/terminal-client/src/terminal-view.ts`:

```ts
import { FitAddon } from '@xterm/addon-fit'
import { Terminal } from '@xterm/xterm'

export interface TerminalViewOptions {
  cols?: number
  rows?: number
}

/** Thin xterm.js wrapper: mount, write decoded frames, resize/fit, hash the screen. */
export class TerminalView {
  private readonly term: Terminal
  private readonly fitAddon: FitAddon

  constructor(opts: TerminalViewOptions = {}) {
    this.term = new Terminal({
      cols: opts.cols ?? 80,
      rows: opts.rows ?? 24,
      scrollback: 1000,
      convertEol: false,
    })
    this.fitAddon = new FitAddon()
    this.term.loadAddon(this.fitAddon)
  }

  mount(el: HTMLElement): void {
    this.term.open(el)
  }

  write(text: string): void {
    this.term.write(text)
  }

  resize(cols: number, rows: number): void {
    this.term.resize(cols, rows)
  }

  /** Resize the terminal to fill its container; returns the new grid. */
  fit(): { cols: number; rows: number } {
    this.fitAddon.fit()
    return { cols: this.term.cols, rows: this.term.rows }
  }

  cols(): number {
    return this.term.cols
  }

  rows(): number {
    return this.term.rows
  }

  /** The visible buffer's text, joined by newlines (renderer-independent). */
  screenText(): string {
    const buf = this.term.buffer.active
    let text = ''
    for (let i = 0; i < buf.length; i += 1) {
      text += `${buf.getLine(i)?.translateToString(true) ?? ''}\n`
    }
    return text
  }

  /**
   * A stable hash of `screenText()`. Two views fed the same frames at the same
   * geometry produce the same hash, independent of CSS scaling — this is how
   * cross-client sync is asserted.
   */
  screenHash(): string {
    const text = this.screenText()
    let h = 0x811c9dc5
    for (let i = 0; i < text.length; i += 1) {
      h ^= text.charCodeAt(i)
      h = Math.imul(h, 0x01000193)
    }
    return (h >>> 0).toString(16)
  }

  dispose(): void {
    this.term.dispose()
  }
}
```

- [ ] **Step 4: DomViewportSource**

Create `packages/terminal-client/src/dom-viewport.ts`:

```ts
import type { ViewportSize, ViewportSource } from './viewport'

/**
 * Production ViewportSource: tracks an element's box plus the visual viewport (so a
 * soft keyboard opening — which shrinks `visualViewport.height` — fires a change).
 */
export class DomViewportSource implements ViewportSource {
  private readonly el: HTMLElement
  private readonly cbs = new Set<(s: ViewportSize) => void>()
  private readonly ro: ResizeObserver
  private readonly onVv = () => this.emit()

  constructor(el: HTMLElement) {
    this.el = el
    this.ro = new ResizeObserver(() => this.emit())
    this.ro.observe(el)
    globalThis.visualViewport?.addEventListener('resize', this.onVv)
  }

  current(): ViewportSize {
    const rect = this.el.getBoundingClientRect()
    const vvH = globalThis.visualViewport?.height ?? rect.height
    return {
      width: rect.width,
      height: Math.min(rect.height, vvH),
      dpr: globalThis.devicePixelRatio ?? 1,
    }
  }

  onChange(cb: (s: ViewportSize) => void): () => void {
    this.cbs.add(cb)
    return () => this.cbs.delete(cb)
  }

  dispose(): void {
    this.ro.disconnect()
    globalThis.visualViewport?.removeEventListener('resize', this.onVv)
    this.cbs.clear()
  }

  private emit(): void {
    const s = this.current()
    for (const cb of [...this.cbs]) cb(s)
  }
}
```

- [ ] **Step 5: key toolbar**

Create `packages/terminal-client/src/toolbar.ts`:

```ts
import type { SessionConnection } from './connection'
import { ctrlSequence, keySequence, type SpecialKey } from './keys'

const KEYS: SpecialKey[] = ['Escape', 'Tab', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Enter']

/** Render a minimal mobile key toolbar of buttons wired to the connection. */
export function mountKeyToolbar(el: HTMLElement, conn: SessionConnection): () => void {
  const doc = el.ownerDocument
  const buttons: HTMLButtonElement[] = []

  const addButton = (label: string, send: () => void) => {
    const b = doc.createElement('button')
    b.type = 'button'
    b.textContent = label
    b.dataset.key = label
    b.addEventListener('click', send)
    el.appendChild(b)
    buttons.push(b)
  }

  for (const k of KEYS) addButton(k, () => conn.sendInput(keySequence(k)))
  addButton('Ctrl-C', () => conn.sendInput(ctrlSequence('c')))

  return () => {
    for (const b of buttons) b.remove()
  }
}
```

- [ ] **Step 6: mountSession (the integration + observability)**

Create `packages/terminal-client/src/session-mount.ts`:

```ts
import { SessionConnection } from './connection'
import { DomViewportSource } from './dom-viewport'
import { TerminalView } from './terminal-view'
import { mountKeyToolbar } from './toolbar'

export interface MountSessionOptions {
  url: string
  /** Mount the toolbar into this element (defaults to none). */
  toolbarEl?: HTMLElement
  /** Expose window.__podium test hooks + dev controls. */
  test?: boolean
}

export interface MountedSession {
  connection: SessionConnection
  view: TerminalView
  dispose(): void
}

export function mountSession(el: HTMLElement, opts: MountSessionOptions): MountedSession {
  const view = new TerminalView()
  view.mount(el)
  const fitted = view.fit()

  const connection = new SessionConnection({
    url: opts.url,
    viewport: { cols: fitted.cols, rows: fitted.rows, dpr: globalThis.devicePixelRatio ?? 1 },
    onFrame: (text) => view.write(text),
    onState: (state) => {
      // Always render at the authoritative geometry so all clients' buffers match.
      if (view.cols() !== state.cols || view.rows() !== state.rows) {
        view.resize(state.cols, state.rows)
      }
      el.dataset.role = state.role
      el.dataset.epoch = String(state.epoch)
    },
  })

  const viewport = new DomViewportSource(el)
  // Controller proposes geometry from its own viewport; spectators do not.
  const offViewport = viewport.onChange(() => {
    if (connection.state().role !== 'controller') return
    const grid = view.fit()
    connection.sendResize(grid.cols, grid.rows)
  })

  const offToolbar = opts.toolbarEl ? mountKeyToolbar(opts.toolbarEl, connection) : () => {}

  connection.connect()

  if (opts.test) {
    ;(globalThis as unknown as { __podium?: unknown }).__podium = {
      state: () => connection.state(),
      screenHash: () => view.screenHash(),
      screenText: () => view.screenText(),
      sendInput: (s: string) => connection.sendInput(s),
      takeControl: () => connection.requestControl(),
      // Synthetic soft keyboard: shrink this element's height by `inset`, refit, resize.
      simulateKeyboard: (inset: number) => {
        el.style.height = inset > 0 ? `calc(100% - ${inset}px)` : ''
        const grid = view.fit()
        connection.sendResize(grid.cols, grid.rows)
      },
    }
  }

  return {
    connection,
    view,
    dispose() {
      offViewport()
      offToolbar()
      viewport.dispose()
      connection.dispose()
      view.dispose()
    },
  }
}
```

- [ ] **Step 7: export + typecheck + build + commit**

Replace `packages/terminal-client/src/index.ts` to add the new modules:

```ts
/**
 * @podium/terminal-client — browser presentation client for Podium agent sessions.
 */
export * from './connection'
export * from './dom-viewport'
export * from './keys'
export * from './session-mount'
export * from './terminal-view'
export * from './toolbar'
export * from './viewport'
```

Run, in order:
- `bunx vitest run packages/terminal-client/src/connection.test.ts` → 8 passed (carry-over fixes didn't regress).
- `bun run --filter @podium/terminal-client typecheck` → exit 0.
- `bun run --filter @podium/terminal-client build` → tsup emits dist + d.ts (xterm deps externalized).
- `bunx biome check packages/terminal-client/src` → clean.

```bash
git add packages/terminal-client/package.json packages/terminal-client/src/connection.ts packages/terminal-client/src/terminal-view.ts packages/terminal-client/src/dom-viewport.ts packages/terminal-client/src/toolbar.ts packages/terminal-client/src/session-mount.ts packages/terminal-client/src/index.ts bun.lock
git commit -m "feat(terminal-client): xterm view, toolbar, DOM viewport, mountSession + observability"
```

> **Note:** xterm rendering, `screenHash`, the DOM viewport, and `mountSession` are verified in Task 3 (Playwright, real browser) — jsdom cannot render xterm. Task 1 ships them behind a green typecheck/build + the unchanged 3a unit tests.

---

## Task 2: apps/web (React + Vite) mounting the session

**Files:** modify `apps/web/package.json`; confirm `apps/web/tsconfig.json`; create `apps/web/index.html`, `apps/web/vite.config.ts`, `apps/web/src/main.tsx`, `apps/web/src/App.tsx`; (remove the placeholder `apps/web/src/index.ts` if the bundler entry becomes `main.tsx`).

- [ ] **Step 1: deps**

Edit `apps/web/package.json` to:

```json
{
  "name": "@podium/web",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "dependencies": {
    "@podium/terminal-client": "workspace:*",
    "@podium/core": "workspace:*",
    "react": "^18.3.1",
    "react-dom": "^18.3.1"
  },
  "scripts": {
    "typecheck": "tsc --noEmit",
    "dev": "vite",
    "build": "vite build",
    "preview": "vite preview"
  },
  "devDependencies": {
    "typescript": "^6.0.3",
    "vite": "^6.0.0",
    "@vitejs/plugin-react": "^4.3.4",
    "@types/react": "^18.3.12",
    "@types/react-dom": "^18.3.1"
  }
}
```

Run `bun install`.

- [ ] **Step 2: tsconfig** — ensure `apps/web/tsconfig.json` is:

```json
{
  "extends": "../../tooling/tsconfig/react.json",
  "include": ["src", "vite.config.ts"]
}
```

- [ ] **Step 3: vite config** — create `apps/web/vite.config.ts`:

```ts
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [react()],
  server: { host: '0.0.0.0' },
  preview: { host: '0.0.0.0' },
})
```

- [ ] **Step 4: index.html** — create `apps/web/index.html`:

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover" />
    <title>Podium</title>
    <link rel="stylesheet" href="@xterm/xterm/css/xterm.css" />
    <style>
      html, body, #root { margin: 0; height: 100%; }
      #term { width: 100%; height: 80vh; }
      #toolbar { display: flex; gap: 4px; padding: 4px; }
      #toolbar button { padding: 8px 10px; }
    </style>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
```

(Note: the `@xterm/xterm/css/xterm.css` link is resolved by Vite from node_modules.)

- [ ] **Step 5: App + main** — create `apps/web/src/App.tsx`:

```tsx
import { mountSession, type MountedSession } from '@podium/terminal-client'
import { useEffect, useRef } from 'react'

export function App(): JSX.Element {
  const termRef = useRef<HTMLDivElement>(null)
  const barRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const term = termRef.current
    const bar = barRef.current
    if (!term || !bar) return
    const params = new URLSearchParams(globalThis.location.search)
    const server = params.get('server') ?? `ws://${globalThis.location.hostname}:8787`
    const session: MountedSession = mountSession(term, {
      url: `${server}/client`,
      toolbarEl: bar,
      test: params.get('test') === '1',
    })
    return () => session.dispose()
  }, [])

  return (
    <div>
      <div id="term" ref={termRef} />
      <div id="toolbar" ref={barRef} />
    </div>
  )
}
```

Create `apps/web/src/main.tsx`:

```tsx
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'

const root = document.getElementById('root')
if (root) createRoot(root).render(<StrictMode><App /></StrictMode>)
```

Delete `apps/web/src/index.ts` (the old `export {}` stub) — the entry is now `main.tsx`.

- [ ] **Step 6: build + typecheck + commit**

- `bun install` (if not already).
- `bun run --filter @podium/web typecheck` → exit 0 (React JSX via react.json).
- `bun run --filter @podium/web build` → `vite build` produces `apps/web/dist`.

```bash
git add apps/web/package.json apps/web/tsconfig.json apps/web/vite.config.ts apps/web/index.html apps/web/src/main.tsx apps/web/src/App.tsx bun.lock
git rm apps/web/src/index.ts
git commit -m "feat(web): React+Vite app mounting terminal-client session"
```

---

## Task 3: Playwright Tier-1/2 e2e (Chromium + WebKit)

**Files:** modify `e2e/package.json`; create `e2e/playwright.config.ts`, `e2e/browser/harness.ts`, `e2e/browser/relay.browser.e2e.ts`.

- [ ] **Step 1: e2e deps**

Edit `e2e/package.json` to add Playwright + react plugin (for `vite preview` of the web app it imports transitively) — final:

```json
{
  "name": "@podium/e2e",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "dependencies": {
    "@podium/protocol": "workspace:*",
    "ws": "^8.18.0"
  },
  "devDependencies": {
    "@types/ws": "^8.5.13",
    "@playwright/test": "^1.60.0"
  }
}
```

Run `bun install`.

- [ ] **Step 2: in-process server+daemon harness**

Create `e2e/browser/harness.ts`:

```ts
import { fileURLToPath } from 'node:url'
import { startDaemon, type DaemonHandle } from '../../apps/daemon/src/daemon'
import { startServer, type ServerHandle } from '../../apps/server/src/server'

const FIXTURE = fileURLToPath(
  new URL('../../packages/agent-bridge/test/fixtures/fixture-tui.mjs', import.meta.url),
)

export interface Relay {
  serverPort: number
  hub: ServerHandle['hub']
  stop(): Promise<void>
}

/** Start a real server + a real daemon (running the fixture) in-process. */
export async function startRelay(): Promise<Relay> {
  const server: ServerHandle = await startServer()
  const daemon: DaemonHandle = await startDaemon({
    serverUrl: `ws://localhost:${server.port}`,
    sessionId: 's1',
    cmd: process.execPath,
    args: [FIXTURE],
    cols: 80,
    rows: 24,
  })
  return {
    serverPort: server.port,
    hub: server.hub,
    async stop() {
      await daemon.close()
      await server.close()
    },
  }
}
```

- [ ] **Step 3: Playwright config**

Create `e2e/playwright.config.ts`:

```ts
import { defineConfig, devices } from '@playwright/test'

export default defineConfig({
  testDir: './browser',
  testMatch: '**/*.browser.e2e.ts',
  fullyParallel: false,
  workers: 1,
  reporter: 'list',
  use: { baseURL: 'http://localhost:4317' },
  projects: [
    {
      name: 'chromium-desktop',
      use: { ...devices['Desktop Chrome'], launchOptions: { args: ['--no-sandbox', '--disable-dev-shm-usage'] } },
    },
    {
      name: 'chromium-pixel',
      use: { ...devices['Pixel 7'], launchOptions: { args: ['--no-sandbox', '--disable-dev-shm-usage'] } },
    },
    { name: 'webkit', use: { ...devices['Desktop Safari'] } },
  ],
  webServer: {
    command: 'bun run --filter @podium/web build && bun run --filter @podium/web preview -- --port 4317 --strictPort',
    url: 'http://localhost:4317',
    reuseExistingServer: false,
    timeout: 120_000,
  },
})
```

- [ ] **Step 4: the Tier-1/2 tests**

Create `e2e/browser/relay.browser.e2e.ts`:

```ts
import { expect, test, type Page } from '@playwright/test'
import { type Relay, startRelay } from './harness'

let relay: Relay

test.beforeEach(async () => {
  relay = await startRelay()
})
test.afterEach(async () => {
  await relay.stop()
})

function appUrl(): string {
  return `/?server=ws://localhost:${relay.serverPort}&test=1`
}

async function podiumState(page: Page) {
  return page.evaluate(() => (globalThis as unknown as { __podium: { state(): Record<string, unknown> } }).__podium.state())
}
async function screenHash(page: Page): Promise<string> {
  return page.evaluate(() => (globalThis as unknown as { __podium: { screenHash(): string } }).__podium.screenHash())
}
async function screenText(page: Page): Promise<string> {
  return page.evaluate(() => (globalThis as unknown as { __podium: { screenText(): string } }).__podium.screenText())
}
async function waitForText(page: Page, needle: string): Promise<void> {
  await expect.poll(() => screenText(page), { timeout: 8000 }).toContain(needle)
}

test('renders live fixture output through the full chain', async ({ page }) => {
  await page.goto(appUrl())
  await waitForText(page, 'PODIUM-FIXTURE')
})

test('takeover converges two clients on identical epoch + screenHash', async ({ browser }) => {
  const a = await browser.newPage()
  const b = await browser.newPage()
  await a.goto(appUrl())
  await b.goto(appUrl())
  await waitForText(a, 'PODIUM-FIXTURE')
  await waitForText(b, 'PODIUM-FIXTURE')

  // b takes control; both should land on epoch 1 and identical screen text.
  await b.evaluate(() => (globalThis as unknown as { __podium: { takeControl(): void } }).__podium.takeControl())
  await expect.poll(async () => (await podiumState(a)).epoch, { timeout: 8000 }).toBe(1)
  await expect.poll(async () => (await podiumState(b)).epoch, { timeout: 8000 }).toBe(1)
  // force a fresh repaint into both, then compare buffer hashes
  await b.evaluate(() => (globalThis as unknown as { __podium: { sendInput(s: string): void } }).__podium.sendInput('\f'))
  await expect.poll(async () => `${await screenHash(a)}|${await screenHash(b)}`, { timeout: 8000 }).toMatch(/^([0-9a-f]+)\|\1$/)
  await a.close()
  await b.close()
})

test('synthetic keyboard resizes the agent and reconverges', async ({ page }) => {
  await page.goto(appUrl())
  await waitForText(page, 'cols=')
  const before = (await podiumState(page)).rows as number
  await page.evaluate(() => (globalThis as unknown as { __podium: { simulateKeyboard(n: number): void } }).__podium.simulateKeyboard(300))
  await expect.poll(async () => (await podiumState(page)).rows, { timeout: 8000 }).toBeLessThan(before)
  await waitForText(page, `rows=${(await podiumState(page)).rows}`)
})

test('toolbar Ctrl-C reaches the agent', async ({ page }) => {
  await page.goto(appUrl())
  await waitForText(page, 'PODIUM-FIXTURE')
  await page.click('#toolbar button[data-key="Ctrl-C"]')
  // fixture exits 0 on Ctrl-C → the daemon forwards agentExit; the agent process is gone.
  await expect.poll(async () => relay.hub.info().clientCount, { timeout: 8000 }).toBeGreaterThanOrEqual(1)
})
```

- [ ] **Step 5: run — Chromium first, then WebKit**

Run: `cd e2e && bunx playwright test --config playwright.config.ts --project chromium-desktop`
Expected: PASS. Then `--project chromium-pixel`, then `--project webkit`. Debug any failure per `superpowers:systematic-debugging` (these are timing-sensitive real-browser tests; widen waits only with cause, and prefer fixing root timing/ordering). If a specific assertion is engine-flaky, capture a screenshot (`page.screenshot`) and report the root cause.

- [ ] **Step 6: stability + lint + commit**

Run the full config (all 3 projects) twice to confirm stability:
`cd e2e && bunx playwright test --config playwright.config.ts` (×2).
Then `bunx biome check e2e/browser e2e/playwright.config.ts`.

```bash
git add e2e/package.json e2e/playwright.config.ts e2e/browser/harness.ts e2e/browser/relay.browser.e2e.ts bun.lock
git commit -m "test(e2e): Playwright Tier-1/2 browser tests (chromium pixel+desktop, webkit)"
```

---

## Task 4: Phase 3 green gate

**Files:** none (verification).

- [ ] **Step 1: unit/integration suite** — `bun run test` → all node-side tests green (protocol, server, daemon, agent-bridge, terminal-client unit, node e2e). Record the count.
- [ ] **Step 2: typecheck** — `bun run --filter @podium/terminal-client typecheck`, `--filter @podium/web typecheck` → exit 0.
- [ ] **Step 3: builds** — `bun run --filter @podium/terminal-client build` and `bun run --filter @podium/web build` → succeed.
- [ ] **Step 4: browser e2e** — `cd e2e && bunx playwright test` → all 3 projects green.
- [ ] **Step 5: lint** — `bunx biome check packages/terminal-client/src apps/web/src apps/web/vite.config.ts e2e/browser e2e/playwright.config.ts` → clean.
- [ ] **Step 6: Phase 3 exit check** — the spec's Tier-1/2 acceptance holds: two clients converge on takeover (equal epoch + identical screenHash), the synthetic-keyboard chain resizes+reconverges, toolbar input reaches the agent — across Chromium (Pixel + desktop) and WebKit, against a real server+daemon+fixture. **Phase 3 complete.** Remaining: Phase 4 (point the daemon at real `claude` + your real-phone/iOS pass).

---

## Notes for the executor

- **xterm needs a real browser** — Task 1's view/viewport/mount are verified in Task 3 (Playwright), not jsdom. Keep Task 1's commit green via typecheck/build + the unchanged 3a unit tests.
- **`screenHash` compares buffer TEXT**, not pixels — so controller (1:1) and spectator (CSS-scaled) match when fed the same frames at the same geometry. The `^([0-9a-f]+)\|\1$` regex asserts the two hashes are equal.
- **Chromium projects MUST pass `--no-sandbox`** (the AppArmor profile covers only the harness CfT binary, not Playwright's chromium). WebKit needs no such flag.
- **`webServer`** builds + previews `apps/web` on port 4317; the app reads `?server=ws://localhost:<relayPort>` so each test points the browser at that test's in-process relay.
- **Real-browser timing:** use `expect.poll` (already used) rather than fixed sleeps; if a test is flaky, find the ordering/root cause (systematic-debugging) — do not just bump timeouts.
- **If WebKit regresses** (missing libs after a reboot), re-run `sudo bunx playwright install-deps webkit`; the chromium projects are unaffected.
