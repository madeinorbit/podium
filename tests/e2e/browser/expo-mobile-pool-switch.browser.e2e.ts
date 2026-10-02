import { expect, type Page, test } from '@playwright/test'
import { RELAY } from './_harness'

/**
 * THE MOBILE MOBX POOL SWITCH IN THE PRODUCTION EXPORT (POD-4976), against the
 * harness's own isolated server. Every `goto` is a full app load, which is the
 * only thing that may apply a changed setting.
 *
 * The export splits the graph (MobX included) into its own lazily imported
 * `runtime-pool-*.js` chunk, so "a pool was built" is observable as that chunk's
 * request, and "nothing was built" as its absence. A release build lists the
 * Settings row only while the setting is on, so the on half writes the setting
 * where the row writes it: this principal's UI-state blob in device storage.
 */
test.skip(
  ({ isMobile, browserName }) => !isMobile || browserName !== 'chromium',
  'Pixel Chromium proof',
)
test.setTimeout(180_000)
// One `goto` is one app load: no service-worker update handoff reloads the page.
test.use({ serviceWorkers: 'block' })

const PILOT = 'MobX pilot'

/** One app load at Settings; returns the graph-chunk requests it makes. */
async function launch(page: Page): Promise<string[]> {
  const chunks: string[] = []
  page.removeAllListeners('request')
  page.on('request', (request) => {
    if (/\/runtime-pool-[^/]*\.js$/.test(new URL(request.url()).pathname))
      chunks.push(request.url())
  })
  await page.goto(`/mobile/settings?server=${RELAY}`, { waitUntil: 'domcontentloaded' })
  await expect(page.getByText('Settings', { exact: true })).toBeVisible({ timeout: 60_000 })
  await expect(page.getByText('Sync cursor')).toBeVisible({ timeout: 60_000 })
  return chunks
}

/** Let the write-behind storage bridge flush before the next app load. */
const settle = (page: Page) => page.waitForTimeout(2_000)

const uiStateKey = (page: Page) =>
  page.evaluate(() =>
    Object.keys(localStorage).find(
      (key) => key.startsWith('podium.replica') && key.endsWith('.uistate.v1'),
    ),
  )

test('the mobile pool switch is off by default', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  const chunks = await launch(page)
  await expect(page.getByLabel(PILOT, { exact: true })).toHaveCount(0)
  await settle(page)
  expect(chunks).toEqual([])
  expect(errors).toEqual([])
})

test('the saved setting builds the pool at the next start, and only then', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  expect(await launch(page)).toEqual([])
  await expect.poll(() => uiStateKey(page), { timeout: 30_000 }).toBeTruthy()
  await settle(page)
  await page.evaluate(() => {
    const key = Object.keys(localStorage).find(
      (name) => name.startsWith('podium.replica') && name.endsWith('.uistate.v1'),
    )
    if (!key) throw new Error('no UI-state blob for this principal')
    const ui = JSON.parse(localStorage.getItem(key) ?? '{}') as Record<string, string>
    localStorage.setItem(key, JSON.stringify({ ...ui, 'podium.mobxSidebar': '1' }))
  })

  const on = await launch(page)
  await expect(page.getByLabel(PILOT, { exact: true })).toBeChecked()
  await expect(page.getByText('Applies at the next app start. This launch: on.')).toBeVisible()
  // The graph chunk loads once, for this launch's pool; a failed build or
  // import would surface as a page error or in the shell's banner.
  await expect.poll(() => on.length, { timeout: 30_000 }).toBe(1)
  await settle(page)
  expect(on).toHaveLength(1)

  // Turning it off is saved for the next start; this launch keeps its pool.
  await page.getByLabel(PILOT, { exact: true }).click()
  await expect(page.getByLabel(PILOT, { exact: true })).not.toBeChecked()
  await expect(page.getByText('Applies at the next app start. This launch: on.')).toBeVisible()
  await settle(page)

  const off = await launch(page)
  await expect(page.getByLabel(PILOT, { exact: true })).toHaveCount(0)
  await settle(page)
  expect(off).toEqual([])
  expect(errors).toEqual([])
})
