import { expect, type APIRequestContext, type Page, type Route, test } from '@playwright/test'
import { RELAY } from './_harness'

// The lane owns an isolated server with synthetic issues only.
test.skip(({ isMobile, browserName }) => !isMobile || browserName !== 'chromium', 'Pixel Chromium proof')
test.use({ serviceWorkers: 'block' })
test.setTimeout(180_000)
const HTTP = RELAY.replace(/^ws/, 'http')
async function rpc<T>(request: APIRequestContext, procedure: string, input: unknown, query = false): Promise<T> {
  const result = query
    ? await request.get(`${HTTP}/trpc/${procedure}?input=${encodeURIComponent(JSON.stringify(input))}`)
    : await request.post(`${HTTP}/trpc/${procedure}`, { data: input })
  if (!result.ok()) throw new Error(`${procedure}: ${result.status()} ${await result.text()}`)
  return (await result.json()).result.data as T
}
async function longPress(page: Page, label: string) {
  const box = await page.getByRole('button', { name: label, exact: true }).boundingBox()
  if (!box) throw new Error('Missing native row')
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  await page.mouse.down()
  await page.waitForTimeout(500)
  await page.mouse.up()
}

test('production pool mobile menu renames optimistically, rewinds refusal, and opens the mission', async ({ page, request }) => {
  const errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  page.on('console', message => {
    if (message.type() !== 'error') return
    if (/^Failed to load resource: the server responded with a status of (?:400|401)\b/.test(message.text())) return
    errors.push(message.text())
  })
  const repos = await rpc<string[]>(request, 'repos.list', {}, true)
  if (!repos[0]) throw new Error('Isolated harness has no repo')
  const title = `Mobile action ${Date.now().toString(36)}`
  await rpc(request, 'issues.create', { repoPath: repos[0], title, startNow: true })
  await page.goto(`/mobile/settings?server=${RELAY}`, { waitUntil: 'domcontentloaded' })
  await expect(page.getByText('Sync cursor')).toBeVisible({ timeout: 60_000 })
  const toggle = page.getByLabel('MobX pilot', { exact: true })
  await expect(toggle).not.toBeChecked()
  await toggle.click()
  await expect(toggle).toBeChecked()
  await page.waitForTimeout(2_000)
  await page.goto(`/mobile/work?server=${RELAY}`, { waitUntil: 'domcontentloaded' })
  const initial = page.getByRole('button', { name: new RegExp(`^(?:[A-Z]+-\\d+|#\\d+) ${title}$`) })
  await expect(initial).toBeVisible({ timeout: 60_000 })
  const label = (await initial.getAttribute('aria-label'))!
  const ref = label.slice(0, -(title.length + 1))
  const renamed = `${title} renamed`
  let held: Route | undefined
  await page.route('**/trpc/issues.update*', route => { held = route })
  await longPress(page, label)
  await page.getByRole('button', { name: 'Rename', exact: true }).click()
  await page.getByRole('textbox', { name: 'Rename task', exact: true }).fill(renamed)
  await page.getByRole('button', { name: 'Rename', exact: true }).click()
  await expect(page.getByRole('button', { name: `${ref} ${renamed}`, exact: true })).toBeVisible()
  await expect.poll(() => held !== undefined).toBe(true)
  expect(held!.request().postData()).toContain(renamed)
  expect(held!.request().postData()).toContain('mutationId')
  await held!.fulfill({ status: 400, contentType: 'application/json', body: JSON.stringify({ error: {
    message: 'Synthetic refusal', code: -32600, data: { code: 'BAD_REQUEST', httpStatus: 400, path: 'issues.update' },
  } }) })
  await expect(page.getByRole('button', { name: label, exact: true })).toBeVisible({ timeout: 15_000 })
  await expect(page.getByRole('button', { name: `${ref} ${renamed}`, exact: true })).toHaveCount(0)
  await page.unroute('**/trpc/issues.update*')
  await page.getByRole('button', { name: label, exact: true }).click()
  await expect(page).toHaveURL(/\/mobile\/mission\//)
  await expect(page.getByLabel('Mission actions', { exact: true })).toBeVisible({ timeout: 30_000 })
  expect(errors).toEqual([])
})
