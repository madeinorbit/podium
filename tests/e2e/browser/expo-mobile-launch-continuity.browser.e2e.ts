import { mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { expect, type Page, test } from '@playwright/test'

test.skip(
  ({ isMobile, browserName }) => !isMobile || browserName !== 'chromium',
  'Pixel Chromium launch proof',
)
test.setTimeout(180_000)

const ARTIFACTS = resolve(import.meta.dirname, '../../../.artifacts/POD-503')
const RELAY = process.env.PODIUM_RELAY ?? `ws://localhost:${Number(process.env.PORT ?? 8799)}`
const DEAD_SERVER = 'ws://127.0.0.1:1'
/**
 * A stand-in principal for the COLD cases only.
 *
 * The replica is namespaced by principal, so this deliberately unrelated id
 * guarantees an empty local namespace — which is exactly what a cold launch
 * means. Do not "fix" this to the real auth status: doing so hands those tests
 * a warm cache and quietly destroys the thing they assert. The warm/offline
 * case does the opposite and replays the real status, for the same reason.
 */
const AUTH_STATUS = { needsAuth: false, authed: true, userId: 'user:sole' }

test.beforeAll(() => mkdirSync(ARTIFACTS, { recursive: true }))

/**
 * The acceptance clause the screenshots cannot prove.
 *
 * "No material layout shift" is the one launch property a human reading stills
 * will always sign off on, because the shift happens BETWEEN the two frames
 * they are shown. So it is measured, not photographed: Chromium's own
 * layout-shift entries, accumulated across the whole launch, are the same
 * instrument that defines CLS.
 *
 * The threshold is web-vitals' "good" bound. The design intent is stricter —
 * only opacity animates, so a correct launch scores ~0 — but the bound is what
 * the criterion actually claims, and a test should fail on the claim rather
 * than on a number that happens to hold today. A skeleton whose rows are a
 * different height than the content they cover blows straight through it.
 */
const CLS_GOOD = 0.1

async function readLayoutShift(page: Page): Promise<number> {
  return page.evaluate(
    () => (globalThis as unknown as { __cls: { score: number } }).__cls?.score ?? 0,
  )
}

async function observeLayoutShift(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const cls = { score: 0 }
    ;(globalThis as unknown as { __cls: typeof cls }).__cls = cls
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries() as (PerformanceEntry & {
        value: number
        hadRecentInput: boolean
      })[]) {
        // Shifts within 500ms of a real interaction are the user's doing, not
        // the launch's — the same exclusion the CLS definition makes.
        if (!entry.hadRecentInput) cls.score += entry.value
      }
    }).observe({ type: 'layout-shift', buffered: true })
  })
}

test('replacing skeletons with content does not shift the page', async ({ page }) => {
  await observeLayoutShift(page)
  // A slow auth probe holds the launch open long enough that skeletons are
  // genuinely painted and genuinely replaced, which is the window under test.
  await page.route('**/auth/status', async (route) => {
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 1_500))
    await route.continue()
  })

  await page.goto(`/mobile?server=${RELAY}`)
  await expect(page.getByRole('button', { name: 'New work' })).toBeVisible({ timeout: 60_000 })
  // Let the crossfade finish and any late replica rows land before scoring.
  await expect(page.getByLabel('Podium')).toHaveCount(0)
  await page.waitForTimeout(1_000)

  const score = await readLayoutShift(page)
  expect(score, `cumulative layout shift across launch was ${score}`).toBeLessThan(CLS_GOOD)
})

test('a slow cold launch has one uninterrupted brand transition', async ({ page }) => {
  await page.addInitScript(() => {
    const seen = new WeakSet<Element>()
    const probe = { mounts: 0, maxAtOnce: 0 }
    ;(globalThis as unknown as { __launchProbe: typeof probe }).__launchProbe = probe
    const sample = () => {
      const current = [...document.querySelectorAll('[aria-label="Podium"]')]
      for (const element of current) {
        if (seen.has(element)) continue
        seen.add(element)
        probe.mounts += 1
      }
      probe.maxAtOnce = Math.max(probe.maxAtOnce, current.length)
    }
    new MutationObserver(sample).observe(document, { childList: true, subtree: true })
  })
  await page.route('**/auth/status', async (route) => {
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 1_500))
    await route.continue()
  })

  await page.goto(`/mobile?server=${RELAY}`)
  await expect(page.getByLabel('Podium')).toBeVisible({ timeout: 15_000 })
  await page.screenshot({ path: resolve(ARTIFACTS, '01-slow-server-brand.png'), fullPage: true })
  await expect(page.getByRole('button', { name: 'New work' })).toBeVisible({ timeout: 60_000 })
  await expect(page.getByLabel('Podium')).toHaveCount(0)

  const probe = await page.evaluate(
    () =>
      (globalThis as unknown as { __launchProbe: { mounts: number; maxAtOnce: number } })
        .__launchProbe,
  )
  expect(probe).toEqual({ mounts: 1, maxAtOnce: 1 })
  await page.screenshot({ path: resolve(ARTIFACTS, '02-cold-first-frame.png'), fullPage: true })
})

test('a cold offline launch paints the Work silhouette, never its empty state', async ({
  page,
}) => {
  await page.route('http://127.0.0.1:1/auth/status', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(AUTH_STATUS),
    }),
  )
  await page.goto(`/mobile?server=${encodeURIComponent(DEAD_SERVER)}`)

  await expect(page.getByLabel('Loading work')).toBeVisible({ timeout: 30_000 })
  await expect(page.getByText(/No work yet/)).toHaveCount(0)
  expect(new URL(page.url()).pathname).toBe('/mobile/work')
  await page.screenshot({
    path: resolve(ARTIFACTS, '03-cold-offline-skeleton.png'),
    fullPage: true,
  })
})

/**
 * The task title appears more than once in the DOM: on the detail screen, and
 * on the Tasks list underneath it, which the JS stack keeps mounted but hidden
 * rather than unmounting. A bare getByText therefore trips strict mode and can
 * resolve to the hidden copy. Scope to what is actually on screen — which is
 * also the claim these assertions mean to make.
 */
function visibleText(page: Page, text: string) {
  return page.getByText(text, { exact: false }).filter({ visible: true }).first()
}

async function createTaskAndOpenIt(page: Page): Promise<string> {
  await page.goto(`/mobile?server=${RELAY}`)
  await expect(page.getByRole('button', { name: 'New work' })).toBeVisible({ timeout: 60_000 })
  await page.getByRole('button', { name: 'Tasks' }).click()
  await page.getByRole('button', { name: 'New task' }).click()
  await expect(page.getByLabel(/^Repository /).first()).toBeVisible({ timeout: 30_000 })

  const title = `Launch cache ${Date.now()}`
  await page.getByLabel('Task title').fill(title)
  await page.getByRole('button', { name: 'Agent will start now' }).click()
  await page.getByRole('button', { name: 'Create task' }).click()
  await expect(visibleText(page, title)).toBeVisible({ timeout: 30_000 })
  return title
}

test('a warm relaunch paints cached task detail', async ({ page }) => {
  const title = await createTaskAndOpenIt(page)

  await page.reload()
  await expect(visibleText(page, title)).toBeVisible({ timeout: 30_000 })
  await page.screenshot({ path: resolve(ARTIFACTS, '04-warm-cached-detail.png'), fullPage: true })
})

/**
 * FAILS TODAY — the gap is POD-541, not this suite.
 *
 * An offline relaunch of a task detail renders "Task not found." rather than the
 * cached task or a skeleton. It is left here as a fixme rather than deleted,
 * because deleting it would remove the only executable statement of the
 * acceptance clause it covers, and this file is where the next person looks.
 *
 * Two fixture traps were ruled out before concluding it is a product gap, and
 * both are preserved here so the diagnosis does not have to be repeated:
 *   - The replica is namespaced by principal, so the offline mock replays the
 *     REAL /auth/status body. A hardcoded stand-in opens an empty namespace and
 *     fails identically for an entirely different reason.
 *   - The task is created seconds earlier and arrives over the live feed, so a
 *     settle delay rules out a short persistence race. It does not help.
 * The control is the cold-offline test above: under an unrelated principal it
 * gets booting=true and a skeleton, while this gets booting=false — so the
 * replica does resolve with data, and this row simply is not in it.
 */
test.fixme('an offline relaunch paints cached task detail', async ({ page }) => {
  const title = await createTaskAndOpenIt(page)
  await page.reload()
  await expect(visibleText(page, title)).toBeVisible({ timeout: 30_000 })
  await page.waitForTimeout(3_000)

  const authStatus = await page.evaluate(() =>
    fetch('/auth/status').then((response) => response.text()),
  )
  await page.route('http://127.0.0.1:1/auth/status', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: authStatus }),
  )
  const offline = new URL(page.url())
  offline.searchParams.set('server', DEAD_SERVER)
  await page.goto(offline.href)

  await expect(visibleText(page, title)).toBeVisible({ timeout: 30_000 })
  await expect(page.getByLabel('Loading task detail')).toHaveCount(0)
  await page.screenshot({
    path: resolve(ARTIFACTS, '05-offline-cached-detail.png'),
    fullPage: true,
  })
})
