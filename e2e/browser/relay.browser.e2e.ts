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
  // Focus the xterm helper textarea so keyboard events route to the terminal.
  // Using locator.focus() is cross-browser and bypasses pointer-event interception
  // from the sidebar (which blocks a pointer click on desktop viewport).
  await page.locator('#term .xterm-helper-textarea').focus()
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
