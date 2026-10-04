import { mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { type APIRequestContext, expect, test } from '@playwright/test'
import { RELAY } from './_harness'
import { replicaDurable } from './_phone-profile'

/** The only external boundary added here is Copy. Drive the production phone
 * once on the lane's isolated server and observe the real browser clipboard. */
test.skip(({ isMobile, browserName }) => !isMobile || browserName !== 'chromium', 'Pixel Chromium proof')
test.use({ serviceWorkers: 'block', permissions: ['clipboard-read', 'clipboard-write'] })
test.setTimeout(180_000)
const HTTP = RELAY.replace(/^ws/, 'http')

async function rpc<T>(request: APIRequestContext, procedure: string, input: unknown, query = false): Promise<T> {
  const result = query
    ? await request.get(`${HTTP}/trpc/${procedure}?input=${encodeURIComponent(JSON.stringify(input))}`)
    : await request.post(`${HTTP}/trpc/${procedure}`, { data: input })
  if (!result.ok()) throw new Error(`${procedure}: ${result.status()} ${await result.text()}`)
  return (await result.json()).result.data as T
}

test('phone refusal rolls back, marks the row, copies preserved input, and retry clears the mark', async ({ page, context, request }, testInfo) => {
  const repos = await rpc<string[]>(request, 'repos.list', {}, true)
  const title = `Refusal recovery ${Date.now().toString(36)}`
  const authored = `${title} attempted`
  const issue = await rpc<{ id: string }>(request, 'issues.create', { repoPath: repos[0], title, startNow: true })
  const evidence = resolve('.artifacts/POD-5490')
  mkdirSync(evidence, { recursive: true })
  try {
    await page.goto(`/mobile/settings?server=${RELAY}`, { waitUntil: 'domcontentloaded' })
    await expect(page.getByText('Sync cursor')).toBeVisible({ timeout: 60_000 })
    await replicaDurable(page)
    await page.goto(`/mobile/work?server=${RELAY}`, { waitUntil: 'domcontentloaded' })
    const row = () => page.getByRole('button', { name: new RegExp(`^(?:[A-Z]+-\\d+|#\\d+) ${title}$`) })
    await expect(row()).toBeVisible({ timeout: 60_000 })
    const label = (await row().getAttribute('aria-label'))!
    const ref = label.slice(0, -(title.length + 1))
    await page.route('**/trpc/issues.update*', route => route.fulfill({
      status: 409, contentType: 'application/json',
      body: JSON.stringify({ error: { message: 'Synthetic refusal', code: -32600, data: { code: 'CONFLICT', httpStatus: 409, path: 'issues.update' } } }),
    }))
    const cdp = await context.newCDPSession(page)
    // Let the freshly mounted row settle before dispatching touch coordinates.
    await row().click({ trial: true })
    const box = await row().boundingBox()
    if (!box) throw new Error('Missing phone work row')
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: box.x + box.width / 2, y: box.y + box.height / 2 }] })
    await page.waitForTimeout(500)
    await expect(page.getByRole('button', { name: 'Rename', exact: true })).toBeVisible()
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchCancel', touchPoints: [] })
    await page.getByRole('button', { name: 'Rename', exact: true }).tap()
    await page.getByRole('textbox', { name: 'Rename task', exact: true }).fill(authored)
    await page.getByRole('button', { name: 'Rename', exact: true }).tap()
    await expect(row().getByTestId('not-saved')).toBeVisible({ timeout: 15_000 })
    await page.unroute('**/trpc/issues.update*')
    const rowShot = resolve(evidence, 'phone-not-saved.png')
    await page.screenshot({ path: rowShot })
    await testInfo.attach('Phone row after rollback', { path: rowShot, contentType: 'image/png' })

    // Same durable profile, now booted into recovery. It reads only the parked
    // input; Copy must not substitute the restored title or the target id.
    await page.goto(`/mobile/settings?server=${RELAY}`, { waitUntil: 'domcontentloaded' })
    const copy = page.getByRole('button', { name: 'Copy', exact: true })
    await expect(copy).toBeVisible({ timeout: 30_000 })
    await expect(page.getByText(authored, { exact: true })).toBeVisible()
    await copy.tap()
    await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(authored)
    const recoveryShot = resolve(evidence, 'phone-recovery-copy.png')
    await page.screenshot({ path: recoveryShot })
    await testInfo.attach('Phone preserved text and Copy', { path: recoveryShot, contentType: 'image/png' })
    await page.getByTestId('outbox-retry').tap()
    await expect(copy).toHaveCount(0)
    await page.goto(`/mobile/work?server=${RELAY}`, { waitUntil: 'domcontentloaded' })
    const retried = page.getByRole('button', { name: `${ref} ${authored}`, exact: true })
    await expect(retried).toBeVisible({ timeout: 30_000 })
    await expect(retried.getByTestId('not-saved')).toHaveCount(0)
    console.info('[phone refusal recovery]', JSON.stringify({ rolledBack: true, notSaved: true, clipboard: authored, retryCleared: true }))
  } finally {
    await rpc(request, 'issues.delete', { id: issue.id })
  }
})
