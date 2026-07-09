# Multiple Sessions — Phase 6b: Multi-Session e2e + Workspace Green

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prove the multi-session stack end-to-end through the browser Live section, and bring the **entire workspace green** so `feat/multiple-sessions` is ff-mergeable to `main`.

**Architecture:** The Playwright tests start an in-process relay (server + passive daemon spawning the deterministic fixture), pre-create labeled sessions via the registry, then drive the web Live section (auto-opened by `?server=`) through `window.__podium`. Cross-origin tRPC needs CORS on the Hono server. The fixture gains an optional `--label` so sessions render distinct content.

**Tech Stack:** Playwright (chromium-desktop / chromium-pixel / webkit-iphone), Vitest, Hono. Touches `apps/server` (CORS), the fixture, `apps/web/src/App.tsx` (default mode), and `e2e/`.

**Spec:** `docs/superpowers/specs/2026-06-03-multiple-sessions-design.md` §8/§10.

---

## Sequencing note

This is the convergence phase. After 6a, `bun run typecheck`, `bun run test`, and `bun run lint`
should already be green (the stale `e2e/serve.ts` + `e2e/run-claude-demo.ts` are not type-gated:
`e2e` has no `typecheck` script, `*.e2e.ts` aren't vitest files, and Biome lint is style-only — so
their old-API usage doesn't fail those gates; they're rewritten in Phase 7). 6b's real work is the
CORS + fixture + app tweak + e2e rewrite + the **Playwright matrix**. Final gate = the full
workspace commands + the matrix, all green.

---

## File structure

- `apps/server/src/server.ts` — add Hono CORS for `/trpc` (cross-origin browser → relay).
- `packages/agent-bridge/test/fixtures/fixture-tui.mjs` — optional `--label`, appended to the paint line.
- `apps/web/src/App.tsx` — default `activeMode` to `'live'` when `?server=` is present.
- `e2e/browser/harness.ts` — rewrite: passive daemon + fixture launcher + create labeled sessions.
- `e2e/browser/relay.browser.e2e.ts` — rewrite: drive the Live section, multi-session.

---

### Task 1: CORS on the relay

**Files:** Edit `apps/server/src/server.ts`.

- [ ] **Step 1:** Add CORS so the browser (served from a different origin) can call tRPC. In `server.ts`, import and apply before the tRPC route:
  ```ts
  import { cors } from 'hono/cors'
  // ...
  app.use('/trpc/*', cors())
  app.use('/trpc/*', trpcServer({ router: appRouter, createContext: () => ({ registry }) }))
  ```
- [ ] **Step 2:** `bun run --filter @podium/server test` → still 21 pass; `bun run --filter @podium/server typecheck` → exit 0.
- [ ] **Step 3: Commit** — `git add apps/server/src/server.ts && git commit -m "feat(server): CORS on /trpc for cross-origin browser clients"`

---

### Task 2: fixture `--label`

**Files:** Edit `packages/agent-bridge/test/fixtures/fixture-tui.mjs`.

- [ ] **Step 1:** Parse an optional `--label` and append it to the existing paint line (append only — do NOT change the `PODIUM-FIXTURE cols=… rows=… paint=…` prefix, which other tests match):
  ```js
  const labelIdx = process.argv.indexOf('--label')
  const label = labelIdx >= 0 ? (process.argv[labelIdx + 1] ?? '') : ''
  ```
  and in `render()` change the first write to:
  ```js
  process.stdout.write(`PODIUM-FIXTURE cols=${cols} rows=${rows} paint=${paint} label=${label}\r\n`)
  ```
- [ ] **Step 2:** Confirm nothing regressed: `bunx vitest run packages/agent-bridge` (45 pass) and `bun run --filter @podium/daemon test` (3 pass) — both match `PODIUM-FIXTURE`/`cols=` substrings that are still intact.
- [ ] **Step 3: Commit** — `git add packages/agent-bridge/test/fixtures/fixture-tui.mjs && git commit -m "test(fixture): optional --label appended to the paint line"`

---

### Task 3: auto-open the Live mode with ?server=

**Files:** Edit `apps/web/src/App.tsx`.

- [ ] **Step 1:** Default `activeMode` to `'live'` when `?server=` is present so the e2e (and a shared demo URL) land on the functional section. Change the `activeMode` initializer:
  ```ts
  const [activeMode, setActiveMode] = useState<ModeId>(
    new URLSearchParams(window.location.search).has('server') ? 'live' : 'product',
  )
  ```
- [ ] **Step 2:** `bun run --filter @podium/web typecheck` → exit 0; `bun run --filter @podium/web build` → exit 0.
- [ ] **Step 3: Commit** — `git add apps/web/src/App.tsx && git commit -m "feat(web): open the Live section by default when ?server= is set"`

---

### Task 4: rewrite the e2e harness (multi-session)

**Files:** Rewrite `e2e/browser/harness.ts`.

- [ ] **Step 1:** Replace with:

```ts
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { type DaemonHandle, startDaemon } from '../../apps/daemon/src/daemon'
import { type ServerHandle, startServer } from '../../apps/server/src/server'

const FIXTURE = fileURLToPath(
  new URL('../../packages/agent-bridge/test/fixtures/fixture-tui.mjs', import.meta.url),
)

export interface Relay {
  serverPort: number
  registry: ServerHandle['registry']
  createSession(label: string): Promise<string>
  stop(): Promise<void>
}

export async function startRelay(): Promise<Relay> {
  const server: ServerHandle = await startServer()
  const daemon: DaemonHandle = await startDaemon({
    serverUrl: `ws://localhost:${server.port}`,
    // Spawn the deterministic fixture; label it by its cwd so each session renders distinct content.
    launch: (_kind, opts) => ({
      cmd: process.execPath,
      args: [FIXTURE, '--label', opts.cwd],
      cwd: opts.cwd,
    }),
  })
  return {
    serverPort: server.port,
    registry: server.registry,
    async createSession(label) {
      const dir = await mkdtemp(join(tmpdir(), `pod-${label}-`))
      return server.registry.createSession({ agentKind: 'claude-code', cwd: dir, title: label })
        .sessionId
    },
    async stop() {
      await daemon.close()
      await server.close()
    },
  }
}
```

(`cwd` is a real temp dir so `node-pty` can spawn; its basename carries the label, which the fixture prints, so the test can tell `pod-alpha…` from `pod-beta…`.)

- [ ] **Step 2: Commit** — `git add e2e/browser/harness.ts && git commit -m "test(e2e): multi-session relay harness (passive daemon + labeled sessions)"`

---

### Task 5: rewrite the browser tests (drive the Live section)

**Files:** Rewrite `e2e/browser/relay.browser.e2e.ts`.

- [ ] **Step 1:** Replace with:

```ts
import { expect, type Page, test } from '@playwright/test'
import { type Relay, startRelay } from './harness'

let relay: Relay

test.beforeEach(async () => {
  relay = await startRelay()
  await relay.createSession('alpha')
  await relay.createSession('beta')
})
test.afterEach(async () => {
  await relay.stop()
})

function appUrl(): string {
  return `/?server=ws://localhost:${relay.serverPort}`
}

interface PodState {
  role: string
  cols: number
  rows: number
  epoch: number
  sessionId: string
}
type PodWindow = {
  __podium?: {
    sessions(): Array<{ sessionId: string; title: string }>
    attach(id: string): void
    create(kind: string, cwd: string): Promise<{ sessionId: string }>
    state(): PodState | undefined
    screenText(): string
    takeControl(): void
  }
}

const sessions = (page: Page) =>
  page.evaluate(() => (globalThis as unknown as PodWindow).__podium?.sessions() ?? [])
const stateOf = (page: Page) =>
  page.evaluate(() => (globalThis as unknown as PodWindow).__podium?.state())
const screenText = (page: Page) =>
  page.evaluate(() => (globalThis as unknown as PodWindow).__podium?.screenText() ?? '')
const attach = (page: Page, id: string) =>
  page.evaluate((i) => (globalThis as unknown as PodWindow).__podium?.attach(i), id)

async function waitPodium(page: Page): Promise<void> {
  await page.waitForFunction(() => Boolean((globalThis as unknown as PodWindow).__podium), {
    timeout: 15_000,
  })
}
async function idByTitle(page: Page, title: string): Promise<string> {
  const list = await sessions(page)
  const found = list.find((s) => s.title === title)
  if (!found) throw new Error(`no session titled ${title}`)
  return found.sessionId
}

test('lists live sessions and renders the attached one', async ({ page }) => {
  await page.goto(appUrl())
  await waitPodium(page)
  await expect.poll(async () => (await sessions(page)).length, { timeout: 15_000 }).toBe(2)
  await attach(page, await idByTitle(page, 'alpha'))
  await expect.poll(() => screenText(page), { timeout: 15_000 }).toContain('PODIUM-FIXTURE')
  await expect.poll(() => screenText(page)).toContain('pod-alpha')
})

test('switching sessions swaps the rendered content', async ({ page }) => {
  await page.goto(appUrl())
  await waitPodium(page)
  await expect.poll(async () => (await sessions(page)).length, { timeout: 15_000 }).toBe(2)
  await attach(page, await idByTitle(page, 'alpha'))
  await expect.poll(() => screenText(page), { timeout: 15_000 }).toContain('pod-alpha')
  const betaId = await idByTitle(page, 'beta')
  await attach(page, betaId)
  await expect.poll(() => screenText(page), { timeout: 15_000 }).toContain('pod-beta')
  expect(await screenText(page)).not.toContain('pod-alpha')
  expect((await stateOf(page))?.sessionId).toBe(betaId)
})

test('fit-on-connect resizes the PTY to the client grid', async ({ page }) => {
  await page.goto(appUrl())
  await waitPodium(page)
  await attach(page, await idByTitle(page, 'alpha'))
  // The fixture echoes its PTY geometry. Assert it converges to the client's fitted grid,
  // and that a resize away from the daemon's 80x24 spawn default actually happened.
  await expect
    .poll(
      async () => {
        const st = await stateOf(page)
        const txt = await screenText(page)
        if (!st) return 'no'
        const converged = txt.includes(`cols=${st.cols}`) && txt.includes(`rows=${st.rows}`)
        const resized = st.cols !== 80 || st.rows !== 24
        return converged && resized ? 'ok' : 'no'
      },
      { timeout: 15_000 },
    )
    .toBe('ok')
})

test('per-session takeover bumps the epoch', async ({ page }) => {
  await page.goto(appUrl())
  await waitPodium(page)
  await attach(page, await idByTitle(page, 'alpha'))
  await expect.poll(() => screenText(page), { timeout: 15_000 }).toContain('PODIUM-FIXTURE')
  await page.evaluate(() => (globalThis as unknown as PodWindow).__podium?.takeControl())
  await expect
    .poll(async () => (await stateOf(page))?.epoch ?? 0, { timeout: 15_000 })
    .toBeGreaterThanOrEqual(1)
})

test('keyboard input reaches the attached agent', async ({ page }) => {
  await page.goto(appUrl())
  await waitPodium(page)
  await attach(page, await idByTitle(page, 'alpha'))
  await expect.poll(() => screenText(page), { timeout: 15_000 }).toContain('PODIUM-FIXTURE')
  await page.locator('#term').click()
  await page.keyboard.type('x')
  await expect.poll(() => screenText(page), { timeout: 15_000 }).toContain('last-input=78')
})

test('create a new session via the tRPC control plane', async ({ page }) => {
  await page.goto(appUrl())
  await waitPodium(page)
  await expect.poll(async () => (await sessions(page)).length, { timeout: 15_000 }).toBe(2)
  await page.evaluate(() =>
    (globalThis as unknown as PodWindow).__podium?.create('claude-code', '/tmp'),
  )
  await expect.poll(async () => (await sessions(page)).length, { timeout: 15_000 }).toBe(3)
})
```

- [ ] **Step 2: Run the matrix** — `bunx playwright test --config e2e/playwright.config.ts`
  Expected: all tests pass across `chromium-desktop`, `chromium-pixel`, `webkit-iphone` (the webServer rebuilds + previews `apps/web`, so the Live section + tRPC client are bundled). If WebKit needs system deps, they were installed earlier in the project. Run twice to confirm stability.
- [ ] **Step 3: Commit** — `git add e2e/browser/relay.browser.e2e.ts && git commit -m "test(e2e): multi-session browser tests driving the Live section"`

---

### Task 6: whole-workspace green

- [ ] **Step 1:** Run the full gates from the repo root:
  - `bun run typecheck` → all packages exit 0 (incl. apps/web).
  - `bun run test` → all node unit tests pass (protocol/agent-bridge/terminal-client/server/daemon/core).
  - `bun run lint` → clean (run `bun run format` first if Biome would reformat).
  - `bunx playwright test --config e2e/playwright.config.ts` → green ×3 engines.
- [ ] **Step 2:** If anything is red, fix it (most likely: a lingering old-API reference, or a Biome format). Re-run until green.
- [ ] **Step 3: Commit** any format/fix — `git commit -am "chore: workspace green for multiple-sessions"` (only if needed).

---

## Self-review checklist

- **End-to-end proof (user's directive):** the Live section, inside the command-center mockup, lists live sessions, renders the attached one, switches between sessions (distinct labels), fits the PTY to the client grid, takes control (epoch bump), receives keyboard input, and creates a session via tRPC — across desktop + two mobile engines.
- **CORS:** added for `/trpc` so the cross-origin browser→relay control plane works (ws is exempt).
- **Fixture `--label`:** appended only; existing `PODIUM-FIXTURE`/`cols=` matchers in agent-bridge + daemon tests still pass.
- **Robust assertions:** session distinction by printed label; fit asserted by PTY↔client convergence + a real resize off 80×24 (engine-independent, no absolute thresholds).
- **Workspace green:** `typecheck` + `test` + `lint` + the Playwright matrix all pass → branch is ff-mergeable. (`e2e/serve.ts` + `run-claude-demo.ts` real-agent launchers are Phase 7.)
