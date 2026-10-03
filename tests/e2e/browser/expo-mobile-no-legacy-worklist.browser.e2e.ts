import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
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
test.setTimeout(720_000)
const HTTP = RELAY.replace(/^ws/, 'http')
// Fault controls exercise the same parity assertions without taking timing or
// heap samples. Positive captures run under the shared benchmark lease.
const parityOnly = process.env.POD4979_PARITY_ONLY === '1'
// Optional coordination with the operator of bench:flatblock. Ready is emitted
// only after the production build; done releases the lease before idle checks.
const captureGate = process.env.POD4979_CAPTURE_GATE

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

async function launchWork(page: Page, on: boolean, previousOn: boolean) {
  await page.goto(`/mobile/settings?server=${RELAY}`, { waitUntil: 'domcontentloaded' })
  await expect(page.getByText('Sync cursor')).toBeVisible({ timeout: 60_000 })
  const toggle = page.getByLabel('MobX pilot', { exact: true })
  // Pilot-on preferences arrive with the lazy pool. The screen's initial
  // fallback is off, so wait for our last saved value before deciding to click.
  await expect(toggle).toBeChecked({ checked: previousOn })
  if (previousOn !== on) await toggle.click()
  await expect(toggle).toBeChecked({ checked: on })
  await page.waitForTimeout(2_000)
  await page.goto(`/mobile/work?server=${RELAY}`, { waitUntil: 'domcontentloaded' })
}

test('production mobile never derives worklist with the pilot on, including mission details', async ({
  page,
  request,
}, testInfo) => {
  // The stats module defines this door during module evaluation, before any
  // provider exists. Enable at that instant, including on every fresh document.
  await page.addInitScript(() => {
    const define = Object.defineProperty
    Object.defineProperty = (target, key, descriptor) => {
      const result = define(target, key, descriptor)
      if (target === globalThis && key === '__podiumStoreStats') {
        descriptor.value.enable()
        Object.defineProperty = define
      }
      return result
    }
  })
  const counts: { on: boolean; phase: string; worklist: number }[] = []
  async function checkpoint(on: boolean, phase: string) {
    const stats = await page.evaluate(() => {
      const value = Reflect.get(globalThis, '__podiumStoreStats')
      if (!value) throw new Error('store stats missing before bootstrap')
      return value.snapshot() as {
        enabled: boolean
        dropped: number
        runtimes: { publishes: number; slices: Record<string, number> }[]
      }
    })
    expect(stats.enabled, phase).toBe(true)
    expect(stats.dropped, phase).toBe(0)
    expect(
      stats.runtimes.reduce((sum, runtime) => sum + runtime.publishes, 0),
      phase,
    ).toBeGreaterThan(0)
    const worklist = stats.runtimes.reduce(
      (sum, runtime) => sum + (runtime.slices.worklist ?? 0),
      0,
    )
    if (on) expect(worklist, phase).toBe(0)
    else expect(worklist, phase).toBeGreaterThan(0)
    counts.push({ on, phase, worklist })
  }
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
  const title = `Mobile worklist ${Date.now().toString(36)}`
  const issues: { id: string }[] = []
  for (let n = 1; n <= 3; n++)
    issues.push(
      await rpc(request, 'issues.create', {
        repoPath: repos[0],
        title: `${title} ${n}`,
        startNow: true,
      }),
    )
  const prefix = '(?:[A-Z]+-\\d+|#\\d+)'
  const row = () => page.getByRole('button', { name: new RegExp(`^${prefix} ${title} 1$`) })
  // Prime the normal mark-read write before comparing the same data in both arms.
  await launchWork(page, false, false)
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
  let savedOn = false
  for (const [arm, on] of [false, true, false, true].entries()) {
    await launchWork(page, on, savedOn)
    savedOn = on
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
    await checkpoint(on, 'bootstrap/rebuild')
    await page.getByLabel('New work', { exact: true }).click()
    await expect(page.getByLabel(/^Start in /)).toBeVisible()
    await checkpoint(on, 'new work sheet')
    await page.getByLabel('Close', { exact: true }).click({ position: { x: 8, y: 8 } })
    await rpc(request, 'issues.update', {
      id: issues[0]!.id,
      patch: { description: `Incoming update ${on}` },
    })
    await page.waitForTimeout(250)
    await checkpoint(on, 'incoming update')
    if (captureGate && !parityOnly) {
      writeFileSync(`${captureGate}.${arm}.ready`, 'ready\n')
      const deadline = Date.now() + 180_000
      while (!existsSync(`${captureGate}.${arm}.go`)) {
        if (Date.now() > deadline) throw new Error('Benchmark lease was not granted within three minutes')
        await new Promise(resolve => setTimeout(resolve, 200))
      }
    }
    const before = parityOnly ? undefined : await heap()
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
    const stop = parityOnly ? null : await traceStart(cdp)
    try {
      await row().click()
      await expect(page).toHaveURL(/\/mobile\/mission\//)
      await page.waitForFunction(() => Reflect.get(window, '__mobileWorkPaint')?.ready)
    } finally {
      if (stop) {
        const events = await stop()
        const timing = paintOf(events, 'mobile:input', 'mobile:dom')
        cells.push({
          on,
          ...timing,
          startupToRowMs,
          heapBeforeBytes: before,
          heapAfterBytes: await heap(),
        })
      }
    }
    await checkpoint(on, 'mission press and mark read')
    await page.getByLabel('Mission details', { exact: true }).click()
    await expect(page).toHaveURL(/\/mobile\/mission\/[^/]+\/details/)
    await expect(page.getByText('Mission details', { exact: true })).toBeVisible()
    await checkpoint(on, 'mission details')
    if (captureGate && !parityOnly) writeFileSync(`${captureGate}.${arm}.done`, 'done\n')
    if (!parityOnly) {
      // One genuine scheduled clock publication per arm; no manually invoked
      // slice and no reset can erase a late eager derivation.
      await page.waitForTimeout(61_000)
      await checkpoint(on, 'idle minute')
    }
  }
  expect(errors).toEqual([])
  const directory = resolve('.artifacts/POD-4979')
  mkdirSync(directory, { recursive: true })
  const path = resolve(directory, 'mobile-browser.json')
  writeFileSync(
    path,
    JSON.stringify(
      {
        browser: await page.context().browser()?.version(),
        differences: 0,
        counts,
        resourceReports,
        samples: cells,
        scope:
          'Synthetic production Expo export; interleaved startup arms on one SHA; actual Chromium Paint after mission DOM.',
      },
      null,
      2,
    ) + '\n',
  )
  await testInfo.attach('Mobile zero legacy worklist proof', {
    path,
    contentType: 'application/json',
  })
  console.info('[mobile legacy derivations]', JSON.stringify(counts))
  console.info('[mobile browser]', JSON.stringify(cells))
})
