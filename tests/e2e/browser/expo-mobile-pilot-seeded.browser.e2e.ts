import { mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { expect, type Page, test } from '@playwright/test'
import { RELAY } from './_harness'

/**
 * THE PILOT-ON START WITH ISSUES ON THE DEVICE, IN THE PRODUCTION PHONE EXPORT
 * (POD-5370). The other pool suites start on an empty board, where the pool
 * builds no issue object, and listen only for page errors. Here the isolated
 * harness holds an issue, so the pool builds its object at attach, and any
 * console error counts: the phone's crash capture reports through the console,
 * not as a page error.
 *
 * What it guards: Metro's Babel compiles a TypeScript constructor parameter
 * property as an assignment, not a definition, so a model class may never
 * carry a prototype accessor of an instance member's name. And Metro's web
 * chunk loader must not hand a not-yet-loaded chunk's module to the crash
 * handler as a fatal before loading the chunk.
 */
test.skip(
  ({ isMobile, browserName }) => !isMobile || browserName !== 'chromium',
  'Pixel Chromium proof',
)
test.setTimeout(180_000)
// One `goto` is one app load: no service-worker update handoff reloads the page.
test.use({ serviceWorkers: 'block' })

const ARTIFACTS = resolve(import.meta.dirname, '../../../.artifacts/POD-5370')
const TITLE = 'Seeded phone start proof'

async function settings(page: Page): Promise<void> {
  await page.goto(`/mobile/settings?server=${RELAY}`, { waitUntil: 'domcontentloaded' })
  await expect(page.getByText('Sync cursor')).toBeVisible({ timeout: 60_000 })
}

/** Seeds one backlog issue into the harness's own server, never a live one. */
async function seedIssue(page: Page): Promise<void> {
  const http = RELAY.replace(/^ws/, 'http')
  const reposResponse = await page.request.get(`${http}/trpc/repos.list`)
  expect(reposResponse.ok(), await reposResponse.text()).toBe(true)
  const repos = (await reposResponse.json()) as { result: { data: string[] } }
  const repoPath =
    repos.result.data.find((repo) => repo.includes('zz-podium-e2e-repo-')) ?? repos.result.data[0]
  expect(repoPath).toBeDefined()
  const created = await page.request.post(`${http}/trpc/issues.create`, {
    data: { repoPath, title: TITLE, startNow: false },
  })
  expect(created.ok(), await created.text()).toBe(true)
  const issue = (await created.json()) as { result: { data: { id: string } } }
  const staged = await page.request.post(`${http}/trpc/issues.update`, {
    data: { id: issue.result.data.id, patch: { stage: 'backlog' } },
  })
  expect(staged.ok(), await staged.text()).toBe(true)
}

test('with an issue on the device, every start builds the pool and shows the work list', async ({
  page,
}) => {
  mkdirSync(ARTIFACTS, { recursive: true })
  await seedIssue(page)
  const errors: string[] = []
  const chunks: string[] = []
  const report = (error: string) => {
    errors.push(error)
    console.log('[pilot-seeded]', error)
  }
  page.on('pageerror', (error) => report(`pageerror: ${error.stack ?? error.message}`))
  page.on('console', (message) => {
    // A resource the harness refuses is the network's report, not the app's.
    if (message.type() === 'error' && !message.text().startsWith('Failed to load resource'))
      report(`console: ${message.text()}`)
  })
  page.on('request', (request) => {
    if (/\/runtime-pool-[^/]*\.js$/.test(new URL(request.url()).pathname))
      chunks.push(request.url())
  })

  await page.goto(`/mobile/work?server=${RELAY}`, { waitUntil: 'domcontentloaded' })
  await expect(page.getByRole('tab', { name: 'Work', exact: true })).toBeVisible({
    timeout: 60_000,
  })
  // The work list itself rendered: its summary line and its search.
  await expect(page.getByText(/NEED YOU · \d+ PINNED · \d+ TASKS?/)).toBeVisible()
  await expect(page.getByRole('button', { name: 'Search work', exact: true })).toBeVisible()
  // The pool was really built for this start (not a silent legacy start).
  await expect.poll(() => chunks.length, { timeout: 30_000 }).toBe(1)
  await page.getByRole('tab', { name: 'Tasks', exact: true }).click()
  await expect(page.getByText(TITLE).first()).toBeVisible({ timeout: 60_000 })
  // Settle: an issue object built after the first paint fails late.
  await page.waitForTimeout(2_000)
  await page.screenshot({ path: resolve(ARTIFACTS, 'pool-seeded-tasks.png') })

  await settings(page)
  await expect(page.getByLabel('MobX pilot', { exact: true })).toHaveCount(0)
  expect(errors).toEqual([])
})
