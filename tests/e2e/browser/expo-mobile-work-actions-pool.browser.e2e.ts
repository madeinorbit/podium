import { mkdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  type APIRequestContext,
  type CDPSession,
  expect,
  type Page,
  type Route,
  test,
} from '@playwright/test'
import { paintOf, traceStart } from '../../../apps/web/harness/browser-paint'
import { RELAY } from './_harness'

// The lane owns an isolated server with synthetic issues only.
test.skip(
  ({ isMobile, browserName }) => !isMobile || browserName !== 'chromium',
  'Pixel Chromium proof',
)
test.use({ serviceWorkers: 'block' })
test.setTimeout(240_000)
const HTTP = RELAY.replace(/^ws/, 'http')
const parityOnly = process.env.POD4978_PARITY_ONLY === '1'
async function rpc<T>(
  request: APIRequestContext,
  procedure: string,
  input: unknown,
  query = false,
): Promise<T> {
  const result = query
    ? await request.get(
        `${HTTP}/trpc/${procedure}?input=${encodeURIComponent(JSON.stringify(input))}`,
      )
    : await request.post(`${HTTP}/trpc/${procedure}`, { data: input })
  if (!result.ok()) throw new Error(`${procedure}: ${result.status()} ${await result.text()}`)
  return (await result.json()).result.data as T
}
async function longPress(page: Page, cdp: CDPSession, label: string) {
  const row = page.getByRole('button', { name: label, exact: true })
  await row.scrollIntoViewIfNeeded()
  const box = await row.boundingBox()
  if (!box) throw new Error('Missing native row')
  await cdp.send('Input.dispatchTouchEvent', {
    type: 'touchStart',
    touchPoints: [{ x: box.x + box.width / 2, y: box.y + box.height / 2 }],
  })
  await page.waitForTimeout(500)
  await expect(page.getByRole('button', { name: 'Rename', exact: true })).toBeVisible()
  // The new native modal owns input now. Terminate the row's touch rather than
  // synthesizing a compatibility mouse click onto its new backdrop.
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchCancel', touchPoints: [] })
}

async function launchWork(page: Page, on: boolean, previousOn: boolean) {
  await page.goto(`/mobile/settings?server=${RELAY}`, { waitUntil: 'domcontentloaded' })
  await expect(page.getByText('Sync cursor')).toBeVisible({ timeout: 60_000 })
  const toggle = page.getByLabel('MobX pilot', { exact: true })
  await expect(toggle).toBeChecked({ checked: previousOn })
  if (previousOn !== on) await toggle.click()
  await expect(toggle).toBeChecked({ checked: on })
  await page.waitForTimeout(2_000)
  // A hard navigation rebuilds the principal-scoped provider. The latch never
  // changes under mounted WorkScreen hooks.
  await page.goto(`/mobile/work?server=${RELAY}`, { waitUntil: 'domcontentloaded' })
}

test('production pool mobile menu renames optimistically, rewinds refusal, and opens the mission', async ({
  page,
  request,
}, testInfo) => {
  const errors: string[] = []
  const resourceReports: { message: string; path: string }[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  page.on('console', (message) => {
    if (message.type() !== 'error') return
    const url = message.location().url
    const path = url ? new URL(url).pathname : ''
    // Record the anonymous harness's authenticated-device refusal and our one
    // deliberate mutation refusal. Other resource errors remain failures.
    if (
      /^Failed to load resource: the server responded with a status of 401\b/.test(
        message.text(),
      ) ||
      (path === '/trpc/issues.update' &&
        /^Failed to load resource: the server responded with a status of 400\b/.test(
          message.text(),
        ))
    ) {
      resourceReports.push({ message: message.text(), path })
    } else errors.push(message.text())
  })
  const repos = await rpc<string[]>(request, 'repos.list', {}, true)
  if (!repos[0]) throw new Error('Isolated harness has no repo')
  const title = `Mobile action ${Date.now().toString(36)}`
  await rpc(request, 'issues.create', { repoPath: repos[0], title, startNow: true })
  const initial = () =>
    page.getByRole('button', { name: new RegExp(`^(?:[A-Z]+-\\d+|#\\d+) ${title}$`) })
  // Settle the usual read-on-open before interleaving the same fixture's arms.
  await launchWork(page, false, false)
  await expect(initial()).toBeVisible({ timeout: 60_000 })
  await initial().tap()
  await expect(page.getByLabel('Mission actions', { exact: true })).toBeVisible({ timeout: 30_000 })

  const cdp = await page.context().newCDPSession(page)
  const heap = async () => {
    await cdp.send('HeapProfiler.collectGarbage')
    return (await cdp.send('Runtime.getHeapUsage')).usedSize as number
  }
  const samples: unknown[] = []
  let savedOn = false
  for (const on of parityOnly ? [true] : [false, true, false, true]) {
    await launchWork(page, on, savedOn)
    savedOn = on
    await expect(initial()).toBeVisible({ timeout: 60_000 })
    const startupToRowMs = parityOnly ? undefined : await page.evaluate(() => performance.now())
    const before = parityOnly ? undefined : await heap()
    const label = (await initial().getAttribute('aria-label'))!
    const ref = label.slice(0, -(title.length + 1))
    const renamed = `${title} renamed`
    const renamedLabel = `${ref} ${renamed}`
    let held: Route | undefined
    await page.route('**/trpc/issues.update*', (route) => {
      held = route
    })
    await longPress(page, cdp, label)
    await page.getByRole('button', { name: 'Rename', exact: true }).tap({ timeout: 15_000 })
    await page.getByRole('textbox', { name: 'Rename task', exact: true }).fill(renamed, {
      timeout: 15_000,
    })
    const confirm = page.getByRole('button', { name: 'Rename', exact: true })
    if (!parityOnly) {
      await confirm.evaluate((button, expected) => {
        performance.clearMarks()
        const capture = { input: false, ready: false }
        Object.assign(window, { __mobileActionPaint: capture })
        button.addEventListener(
          'pointerdown',
          () => {
            capture.input = true
            performance.mark('mobile-action:input')
          },
          { once: true },
        )
        const observer = new MutationObserver(() => {
          if (
            !capture.input ||
            ![...document.querySelectorAll('[aria-label]')].some(
              (node) => node.getAttribute('aria-label') === expected,
            )
          )
            return
          observer.disconnect()
          performance.mark('mobile-action:dom')
          requestAnimationFrame(() =>
            requestAnimationFrame(() => {
              capture.ready = true
            }),
          )
        })
        observer.observe(document.body, { subtree: true, childList: true, attributes: true })
      }, renamedLabel)
    }
    const stop = parityOnly ? undefined : await traceStart(cdp)
    try {
      await confirm.tap({ timeout: 15_000 })
      await expect(page.getByRole('button', { name: renamedLabel, exact: true })).toBeVisible()
      await expect.poll(() => held !== undefined).toBe(true)
      expect(held!.request().postData()).toContain(renamed)
      expect(held!.request().postData()).toContain('mutationId')
      if (!parityOnly)
        await page.waitForFunction(() => Reflect.get(window, '__mobileActionPaint')?.ready)
    } finally {
      if (stop) {
        const timing = paintOf(await stop(), 'mobile-action:input', 'mobile-action:dom')
        samples.push({
          on,
          ...timing,
          startupToRowMs,
          heapBeforeBytes: before,
          heapPendingBytes: await heap(),
        })
      }
    }
    await held!.fulfill({
      status: 400,
      contentType: 'application/json',
      body: JSON.stringify({
        error: {
          message: 'Synthetic refusal',
          code: -32600,
          data: { code: 'BAD_REQUEST', httpStatus: 400, path: 'issues.update' },
        },
      }),
    })
    await expect(page.getByRole('button', { name: label, exact: true })).toBeVisible({
      timeout: 15_000,
    })
    await expect(page.getByRole('button', { name: renamedLabel, exact: true })).toHaveCount(0)
    await page.unroute('**/trpc/issues.update*')
    await page.getByRole('button', { name: label, exact: true }).tap()
    await expect(page).toHaveURL(/\/mobile\/mission\//)
    await expect(page.getByLabel('Mission actions', { exact: true })).toBeVisible({
      timeout: 30_000,
    })
  }
  expect(errors).toEqual([])
  const directory = resolve('.artifacts/POD-4978')
  mkdirSync(directory, { recursive: true })
  const path = resolve(directory, 'mobile-browser-actions.json')
  writeFileSync(
    path,
    JSON.stringify(
      {
        browser: await page.context().browser()?.version(),
        errors,
        resourceReports,
        samples,
        scope:
          'Synthetic production Expo export; interleaved startup arms on one SHA; actual Chromium Paint after optimistic rename; HTTP refusal rollback and mission navigation.',
      },
      null,
      2,
    ) + '\n',
  )
  await testInfo.attach('Mobile pool action comparison', { path, contentType: 'application/json' })
  console.info('[mobile browser actions]', JSON.stringify(samples))
})
