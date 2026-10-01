/** Foreground synthetic browser proof; no operator data or live backend. */
import { chromium, type Page } from '@playwright/test'
import { mkdir, writeFile } from 'node:fs/promises'
import type {} from '../test/sidebar-actions.browser'

const out = '.artifacts/sidebar-actions'
await mkdir(out, { recursive: true })
const origin = 'http://127.0.0.1:41656'
const server = Bun.spawn(
  [
    'timeout',
    '600s',
    process.execPath,
    'run',
    '--cwd',
    'apps/web',
    'dev',
    '--',
    '--config',
    'vite.sidebar-pool-perf.config.ts',
    '--host',
    '127.0.0.1',
    '--port',
    '41656',
  ],
  { stdout: 'ignore', stderr: 'inherit' },
)
console.log(`Synthetic interaction server PID ${server.pid}`)
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined
const observations: Record<string, unknown>[] = []
try {
  const deadline = Date.now() + 60000
  while (true) {
    try {
      if (
        (
          await fetch(`${origin}/test/sidebar-actions.browser.html`, {
            signal: AbortSignal.timeout(2000),
          })
        ).ok
      )
        break
    } catch {}
    if (Date.now() >= deadline) throw new Error('Synthetic interaction server did not start')
    await Bun.sleep(200)
  }
  browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] })
  const page = await browser.newPage({
    viewport: { width: 1000, height: 900 },
    reducedMotion: 'reduce',
  })
  const pageErrors: string[] = []
  page.on('pageerror', (error) => pageErrors.push(error.message))
  await page.goto(`${origin}/test/sidebar-actions.browser.html?mobxSidebar=1`, { timeout: 60000 })
  await page.waitForFunction(() => window.__sidebarActions?.ready())
  await page.getByText('Only responsive target').waitFor()
  async function check(label: string) {
    await page.evaluate(
      () =>
        new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        ),
    )
    const comparison = await page.evaluate(() => window.__sidebarActions.compare())
    if (comparison.differences !== 0 || comparison.pending !== 0)
      throw new Error(`${label}: ${JSON.stringify(comparison)}`)
    const state = await page.evaluate(() => window.__sidebarActions.state())
    if (pageErrors.length) throw new Error(pageErrors.join('\n'))
    if (state.failures.length) throw new Error(state.failures.join('\n'))
    observations.push({ label, comparison, state })
  }
  async function rejectLatest() {
    await page.waitForFunction(() => window.__sidebarActions.state().requests.length > window.__sidebarActions.state().outcomes.length)
    const before = await page.evaluate(() => window.__sidebarActions.state().outcomes.length)
    await page.evaluate(() => {
      const state = window.__sidebarActions.state()
      window.__sidebarActions.refuse(state.requests.length - 1)
    })
    await page.waitForFunction(
      (count) => window.__sidebarActions.state().outcomes.length > count,
      before,
    )
  }
  const scope = page.locator('[data-drag-scope="group:synthetic-repo"]')
  const keys = async () =>
    scope
      .locator(':scope > [data-drag-key]')
      .evaluateAll((rows) => rows.map((r) => r.getAttribute('data-drag-key')))
  const initial = await keys()
  await check('initial')
  async function drag(page: Page, id: string, target: { x: number; y: number }) {
    const grip = page.locator(`[data-drag-key="${id}"] [data-testid="row-grip"]`)
    const box = await grip.boundingBox()
    if (!box) throw new Error('Missing drag grip')
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
    await page.mouse.down()
    await page.mouse.move(target.x, target.y, { steps: 12 })
    await page.mouse.up()
  }
  const second = await page.locator(`[data-drag-key="${initial[1]}"]`).boundingBox()
  if (!second) throw new Error('Missing reorder target')
  await drag(page, initial[0]!, { x: second.x + 20, y: second.y + second.height - 2 })
  await page.waitForFunction(
    (id) =>
      window.__sidebarActions
        .state()
        .requests.some((r) => r.procedure === 'issues.update' && r.input['id'] === id),
    initial[0],
  )
  if ((await keys())[1] !== initial[0]) throw new Error('Drop did not optimistically reorder')
  await check('reorder pending')
  await rejectLatest()
  if (JSON.stringify(await keys()) !== JSON.stringify(initial))
    throw new Error('Refused reorder did not rewind')
  await check('reorder refused')
  const pinned = await page.locator('[data-drag-scope="pinned"]').boundingBox()
  if (!pinned) throw new Error('Missing pinned target')
  await drag(page, 'synthetic-11', { x: pinned.x + 20, y: pinned.y + pinned.height / 2 })
  await page.waitForFunction(() => window.__sidebarActions.state().pinned.includes('synthetic-11'))
  await check('drag pin pending')
  await rejectLatest()
  await page.waitForFunction(() => !window.__sidebarActions.state().pinned.includes('synthetic-11'))
  await check('drag pin refused')
  await page.getByText('Only responsive target').dblclick()
  const rename = page.locator('input[value="Only responsive target"]')
  await rename.fill('Optimistic browser rename')
  await rename.press('Enter')
  await page.getByText('Optimistic browser rename').waitFor()
  await check('rename pending')
  await rejectLatest()
  await page.getByText('Only responsive target').waitFor()
  await check('rename refused')
  await page.evaluate(() => window.__sidebarActions.close('synthetic-10'))
  await page.getByTestId('closed-fold-toggle').click()
  await page.getByTestId('closed-issue-archive').click()
  await page.waitForFunction(() => !window.__sidebarActions.state().closed.includes('synthetic-10'))
  await check('archive pending')
  await page
    .getByText('Synthetic task 10', { exact: true })
    .waitFor({ state: 'hidden', timeout: 3000 })
  await rejectLatest()
  await page.getByText('Synthetic task 10', { exact: true }).waitFor()
  await check('archive refused and readmitted')
  await page.screenshot({ path: `${out}/synthetic-interactions.png` })
  await writeFile(`${out}/observations.json`, JSON.stringify(observations, null, 2))
  console.log(
    `Sidebar interactions green: ${observations.length} S5 comparisons; pointer reorder/pin, rename/archive optimism and refusal.`,
  )
} finally {
  await browser?.close()
  server.kill()
  await server.exited
}
