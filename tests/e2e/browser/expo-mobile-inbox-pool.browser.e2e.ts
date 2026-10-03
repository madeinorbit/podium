import { mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { expect, type Page, test } from '@playwright/test'
import { RELAY } from './_harness'

/** Reachable readers in the actual Metro export. InboxScreen is retained source
 * without an Expo route; its mounted acceptance lives in inbox-proof.ts. The
 * task detail also supplies a real RichMarkdown/RefChip host here. */
test.skip(
  ({ isMobile, browserName }) => !isMobile || browserName !== 'chromium',
  'Pixel Chromium phone reader proof',
)
test.setTimeout(180_000)
test.use({ serviceWorkers: 'block' })
const artifacts = resolve(import.meta.dirname, '../../../.artifacts/mobile-inbox/production')
const http = RELAY.replace(/^ws/, 'http')

async function mutate<T>(page: Page, procedure: string, data: object): Promise<T> {
  const response = await page.request.post(`${http}/trpc/${procedure}`, { data })
  expect(response.ok(), await response.text()).toBe(true)
  return ((await response.json()) as { result: { data: T } }).result.data
}

async function query<T>(page: Page, procedure: string, input?: object): Promise<T> {
  const response = await page.request.get(`${http}/trpc/${procedure}`, {
    params: input ? { input: JSON.stringify(input) } : undefined,
  })
  expect(response.ok(), await response.text()).toBe(true)
  return ((await response.json()) as { result: { data: T } }).result.data
}

test('seeded proposals, live health and addressed references survive the pool-only production start', async ({
  page,
}) => {
  if (process.env.PODIUM_E2E_REAL_AGENTS === '1')
    throw new Error('Phone reader acceptance uses only the isolated synthetic harness')
  mkdirSync(artifacts, { recursive: true })
  const repos = await query<string[]>(page, 'repos.list')
  const repoPath = repos.find((repo) => repo.includes('zz-podium-e2e-repo-')) ?? repos[0]
  expect(repoPath).toBeDefined()
  // The harness registers repo paths directly in its raw store. Use the real
  // registry mutation to publish the logical repo row before seeding refs.
  await mutate(page, 'repos.setPrefix', { path: repoPath, prefix: 'PHON' })
  const create = (title: string, description: string) =>
    mutate<{ id: string }>(page, 'issues.create', {
      repoPath,
      title,
      description,
      startNow: false,
    })
  const target = await create('Phone reference target', 'The addressed reference destination.')
  await mutate(page, 'issues.update', { id: target.id, patch: { stage: 'backlog' } })
  const { displayRef: ref } = await query<{ displayRef: string }>(page, 'issues.get', {
    id: target.id,
  })
  expect(ref).toMatch(/^[A-Z][A-Z0-9]*-\d+$/)
  const first = await create(
    'Pool proposal first',
    `Related to ${ref}. [Open reference](podium://issues/${ref}).`,
  )
  const second = await create('Pool proposal second', 'The next proposal stays in the deck.')
  await mutate(page, 'issues.update', { id: first.id, patch: { stage: 'proposed', priority: 0 } })
  await mutate(page, 'issues.update', { id: second.id, patch: { stage: 'proposed', priority: 1 } })
  const errors: string[] = [],
    poolChunks: string[] = []
  const report = (error: string) => {
    errors.push(error)
    console.log('[phone-reader]', error)
  }
  page.on('pageerror', (error) => report(`pageerror: ${error.stack ?? error.message}`))
  page.on('console', (message) => {
    if (message.type() === 'error' && !message.text().startsWith('Failed to load resource'))
      report(`console: ${message.text()}`)
  })
  page.on('request', (request) => {
    if (/\/runtime-pool-[^/]*\.js$/.test(new URL(request.url()).pathname))
      poolChunks.push(request.url())
  })

  await page.goto(`/mobile/screen-proposed?server=${RELAY}`, { waitUntil: 'domcontentloaded' })
  await expect(page.getByText('Pool proposal first', { exact: true })).toBeVisible({
    timeout: 60_000,
  })
  await expect.poll(() => poolChunks.length, { timeout: 30_000 }).toBe(1)
  await mutate(page, 'issues.update', {
    id: first.id,
    patch: { description: 'Updated pooled proposal summary.' },
  })
  await expect(page.getByText('Updated pooled proposal summary.', { exact: true })).toBeVisible()
  await page.screenshot({ path: resolve(artifacts, 'proposals.png') })
  await page.getByRole('button', { name: 'Skip', exact: true }).click()
  await expect(page.getByText(/^2 of 2 · /)).toBeVisible()
  await expect(page.getByText('Pool proposal second', { exact: true })).toBeVisible()

  // The pool-backed issue detail supplies the live reference text.
  await mutate(page, 'issues.update', {
    id: first.id,
    patch: { description: `Related to ${ref}. [Open reference](podium://issues/${ref}).` },
  })
  await page.goto(`/mobile/issue/${first.id}?server=${RELAY}`, { waitUntil: 'domcontentloaded' })
  await expect(
    page.getByLabel(`Backlog task ${ref}: Phone reference target`, { exact: true }),
  ).toBeVisible({ timeout: 60_000 })
  await mutate(page, 'issues.update', { id: target.id, patch: { stage: 'review' } })
  await expect(
    page.getByLabel(`Review task ${ref}: Phone reference target`, { exact: true }),
  ).toBeVisible()
  await page.getByRole('link', { name: 'Open reference', exact: true }).click()
  await expect(page).toHaveURL(new RegExp(`/mobile/issue/${target.id}(?:\\?|$)`))
  await expect(page.getByText('Phone reference target', { exact: true }).first()).toBeVisible()

  await page.goto(`/mobile/pulse?server=${RELAY}`, { waitUntil: 'domcontentloaded' })
  await expect(page.getByText('E2E Identity', { exact: true })).toBeVisible({ timeout: 60_000 })
  await expect(page.getByText('Memory', { exact: true }).first()).toBeVisible()
  await expect(page.getByText('No visible machines', { exact: true })).toHaveCount(0)
  await page.screenshot({ path: resolve(artifacts, 'pulse.png') })
  await page.goto(`/mobile/settings?server=${RELAY}`, { waitUntil: 'domcontentloaded' })
  await expect(page.getByText('Applies at the next app start. This launch: on.')).toBeVisible({
    timeout: 60_000,
  })
  await toggle(page).click()
  await expect(toggle(page)).not.toBeChecked()
  await page.waitForTimeout(2_000)
  expect(errors).toEqual([])
})
