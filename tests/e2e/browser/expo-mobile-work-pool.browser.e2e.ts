import { mkdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { type APIRequestContext, expect, type Page, test } from '@playwright/test'
import { paintOf, traceStart } from '../../../apps/web/harness/browser-paint'
import { RELAY } from './_harness'

// Synthetic rows on the isolated harness server, never the operator's data.
test.skip(
  ({ isMobile, browserName }) => !isMobile || browserName !== 'chromium',
  'Pixel Chromium proof',
)
test.use({ serviceWorkers: 'block' })
test.setTimeout(240_000)
const HTTP = RELAY.replace(/^ws/, 'http')
// Fault controls exercise the same parity assertions without taking timing or
// heap samples. Positive captures run under the shared benchmark lease.
const parityOnly = process.env.POD4977_PARITY_ONLY === '1'

async function rpc<T>(
  request: APIRequestContext,
  proc: string,
  input: unknown = {},
  method: 'get' | 'post' = 'post',
): Promise<T> {
  const result =
    method === 'get'
      ? await request.get(`${HTTP}/trpc/${proc}?input=${encodeURIComponent(JSON.stringify(input))}`)
      : await request.post(`${HTTP}/trpc/${proc}`, { data: input })
  if (!result.ok()) throw new Error(`${proc}: ${result.status()} ${await result.text()}`)
  return (await result.json()).result.data as T
}

async function launchWork(page: Page) {
  await page.goto(`/mobile/work?server=${RELAY}`, { waitUntil: 'domcontentloaded' })
}

test('production mobile work has stable pool rows and styles, and a real press paints the mission', async ({
  page,
  request,
}, testInfo) => {
  const errors: string[] = []
  const resourceReports: { message: string; path: string }[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  page.on('console', (message) => {
    if (message.type() !== 'error') return
    // The anonymous harness refuses authenticated device requests. Keep that
    // network evidence separate; every app error and other resource error fails.
    if (
      /^Failed to load resource: the server responded with a status of 401\b/.test(message.text())
    ) {
      const url = message.location().url
      resourceReports.push({ message: message.text(), path: url ? new URL(url).pathname : '' })
    } else errors.push(message.text())
  })
  const repos = await rpc<string[]>(request, 'repos.list', {}, 'get')
  if (!repos[0]) throw new Error('isolated harness has no repo')
  const title = `Native pool ${Date.now().toString(36)}`
  for (let n = 1; n <= 3; n++)
    await rpc(request, 'issues.create', {
      repoPath: repos[0],
      title: `${title} ${n}`,
      startNow: true,
    })
  const prefix = '(?:[A-Z]+-\\d+|#\\d+)'
  const row = () => page.getByRole('button', { name: new RegExp(`^${prefix} ${title} 1$`) })
  // Prime the normal mark-read write before comparing the same data across fresh starts.
  await launchWork(page)
  await expect(row()).toBeVisible({ timeout: 60_000 })
  await row().click()
  await expect(page.getByLabel('Mission actions', { exact: true })).toBeVisible({ timeout: 30_000 })

  const cdp = await page.context().newCDPSession(page)
  const heap = async () => {
    await cdp.send('HeapProfiler.collectGarbage')
    return (await cdp.send('Runtime.getHeapUsage')).usedSize as number
  }
  const cells: unknown[] = []
  let expected: unknown
  for (const start of [1, 2]) {
    await launchWork(page)
    await expect(row()).toBeVisible({ timeout: 60_000 })
    // Each hard navigation constructs the real principal-scoped provider and
    // pool again. This is startup-to-row readiness, not a mounted user switch.
    const startupToRowMs = parityOnly ? undefined : await page.evaluate(() => performance.now())
    await page.waitForTimeout(250)
    const look = await page
      .getByRole('button', { name: new RegExp(`^${prefix} ${title} [123]$`) })
      .evaluateAll((nodes) =>
        nodes.map((node) => ({
          label: node.getAttribute('aria-label'),
          text: node.textContent,
          styles: [node, ...node.querySelectorAll('*')].map((element) => {
            const style = getComputedStyle(element)
            return [
              style.color,
              style.backgroundColor,
              style.opacity,
              style.fontSize,
              style.fontWeight,
              style.fontFamily,
              style.lineHeight,
              style.padding,
              style.border,
              style.display,
              style.flexDirection,
            ]
          }),
        })),
      )
    expect(look).toHaveLength(3)
    if (expected === undefined) expected = look
    else expect(look).toEqual(expected)
    if (parityOnly) continue
    const before = await heap()
    const label = await row().getAttribute('aria-label')
    await page.evaluate((label) => {
      const target = [...document.querySelectorAll('[aria-label]')].find(
        (el) => el.getAttribute('aria-label') === label,
      )
      if (!target) throw new Error('missing mobile row')
      performance.clearMarks()
      const capture = { input: false, ready: false }
      Object.assign(window, { __mobileWorkPaint: capture })
      target.addEventListener(
        'pointerdown',
        () => {
          capture.input = true
          performance.mark('mobile:input')
        },
        { once: true },
      )
      const observer = new MutationObserver(() => {
        if (!capture.input || !document.querySelector('[aria-label="Mission actions"]')) return
        observer.disconnect()
        performance.mark('mobile:dom')
        requestAnimationFrame(() =>
          requestAnimationFrame(() => {
            capture.ready = true
          }),
        )
      })
      observer.observe(document.body, { subtree: true, childList: true, attributes: true })
    }, label)
    const stop = await traceStart(cdp)
    try {
      await row().click()
      await expect(page).toHaveURL(/\/mobile\/mission\//)
      await page.waitForFunction(() => Reflect.get(window, '__mobileWorkPaint')?.ready)
    } finally {
      const events = await stop()
      const timing = paintOf(events, 'mobile:input', 'mobile:dom')
      cells.push({
        start,
        ...timing,
        startupToRowMs,
        heapBeforeBytes: before,
        heapAfterBytes: await heap(),
      })
    }
  }
  expect(errors).toEqual([])
  const directory = resolve('.artifacts/POD-4977')
  mkdirSync(directory, { recursive: true })
  const path = resolve(directory, 'mobile-browser.json')
  writeFileSync(
    path,
    JSON.stringify(
      {
        browser: await page.context().browser()?.version(),
        differences: 0,
        resourceReports,
        samples: cells,
        scope:
          'Synthetic production Expo export; repeated pool-only startups on one SHA; actual Chromium Paint after mission DOM.',
      },
      null,
      2,
    ) + '\n',
  )
  await testInfo.attach('Mobile pool browser comparison', { path, contentType: 'application/json' })
  console.info('[mobile browser]', JSON.stringify(cells))
})
