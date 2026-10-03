import { mkdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { expect, type Page, test } from '@playwright/test'
import { RELAY } from './_harness'

test.skip(
  ({ isMobile, browserName }) => !isMobile || browserName !== 'chromium',
  'Pixel 7 production phone proof',
)
test.use({ serviceWorkers: 'block' })
test.setTimeout(240_000)
const directory = resolve('.artifacts/POD-5439/production-phone')
const http = RELAY.replace(/^ws/, 'http')
async function rpc<T>(page: Page, procedure: string, data?: object): Promise<T> {
  const response =
    data === undefined
      ? await page.request.get(`${http}/trpc/${procedure}`)
      : await page.request.post(`${http}/trpc/${procedure}`, { data })
  expect(response.ok(), await response.text()).toBe(true)
  return ((await response.json()) as { result: { data: T } }).result.data
}
async function legacyCounts(page: Page) {
  return page.evaluate(() => {
    const counter = Reflect.get(window, '__podiumStoreStats')
    if (!counter) throw new Error('The existing reader counter did not attach')
    if (!Reflect.get(window, '__podiumReaderProofCounterArmed') || !counter.snapshot().enabled)
      throw new Error('The reader counter was not enabled before runtime construction')
    const result = { selectors: 0, rowBuilds: 0, derivations: {} as Record<string, number> }
    for (const row of counter.snapshot().runtimes) {
      result.selectors += row.selectorRuns
      result.rowBuilds += row.rowBuilds
      for (const [name, count] of Object.entries(row.slices))
        result.derivations[name] = (result.derivations[name] ?? 0) + Number(count)
    }
    return result
  })
}
test('the production phone opens both launch forms and task details with zero legacy derivations', async ({
  page,
}) => {
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  await page.addInitScript(() => {
    const defineProperty = Object.defineProperty
    Object.defineProperty = ((target, property, descriptor) => {
      const result = defineProperty(target, property, descriptor)
      if (target === globalThis && property === '__podiumStoreStats') {
        descriptor.value.enable()
        Reflect.set(globalThis, '__podiumReaderProofCounterArmed', true)
        Object.defineProperty = defineProperty
      }
      return result
    }) as typeof Object.defineProperty
  })
  const repositories = await rpc<string[]>(page, 'repos.list')
  const repoPath =
    repositories.find((path) => path.includes('zz-podium-e2e-repo-')) ?? repositories[0]
  expect(repoPath).toBeDefined()
  const issue = await rpc<{ id: string }>(page, 'issues.create', {
    repoPath,
    title: 'Phone reader retirement task',
    description: 'Accepted phone task details.',
    startNow: false,
  })
  mkdirSync(directory, { recursive: true })
  const cells: { screen: string; counts: Awaited<ReturnType<typeof legacyCounts>> }[] = []
  const save = async (screen: string) => {
    const counts = await legacyCounts(page)
    expect(counts.selectors, screen).toBe(0)
    expect(counts.rowBuilds, screen).toBe(0)
    expect(
      Object.values(counts.derivations).reduce((sum, count) => sum + count, 0),
      screen,
    ).toBe(0)
    cells.push({ screen, counts })
    await page.screenshot({ path: resolve(directory, `${screen}.png`), fullPage: true })
  }
  await page.goto(`/mobile/new-issue?server=${RELAY}`, { waitUntil: 'domcontentloaded' })
  await expect(page.getByText('New task', { exact: true })).toBeVisible({ timeout: 60_000 })
  await expect(page.getByRole('radio', { name: /^Repository / }).first()).toBeVisible({
    timeout: 60_000,
  })
  for (const field of ['Agent', 'Model', 'Effort', 'Machine'])
    await expect(page.getByRole('button', { name: new RegExp(`^${field}, `) })).toBeVisible()
  await expect(page.getByLabel('Task title', { exact: true })).toBeVisible()
  await save('new-task')
  await page.goto(`/mobile/issue/${issue.id}?server=${RELAY}`, { waitUntil: 'domcontentloaded' })
  await expect(page.getByText('Phone reader retirement task', { exact: true })).toBeVisible({
    timeout: 60_000,
  })
  await expect(page.getByText('Accepted phone task details.', { exact: true })).toBeVisible()
  await save('task-details')
  await page.getByRole('button', { name: 'More actions', exact: true }).click()
  await page.getByRole('button', { name: 'Start an agent', exact: true }).click()
  await expect(
    page.getByText('Choose how and where this task starts.', { exact: true }),
  ).toBeVisible()
  for (const field of ['Agent', 'Model', 'Effort', 'Machine'])
    await expect(page.getByRole('button', { name: new RegExp(`^${field}, `) })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Start agent', exact: true })).toBeVisible()
  await save('configured-launch')
  expect(errors).toEqual([])
  writeFileSync(
    resolve(directory, 'reader-counts.json'),
    `${JSON.stringify({ source: process.env.PODIUM_PROOF_SHA, cells, pageErrors: errors }, null, 2)}\n`,
  )
})
