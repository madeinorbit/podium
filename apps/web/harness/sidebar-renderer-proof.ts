/** Focused browser/performance acceptance of the real sidebar on synthetic
 * StoreProvider data. Run through test:sidebar-renderer on flatblock. */
import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { chromium, type Page } from '@playwright/test'
import type {} from '../test/sidebar-renderer.browser'

const count = Number(process.argv.find((arg) => arg.startsWith('--rows='))?.slice(7) ?? 18)
const target = `synthetic-${count - 1}`
const targetSeq = String(1000 + count - 1)
const out = resolve(`.artifacts/sidebar-renderer/${count}`)
await mkdir(out, { recursive: true })
const origin = 'http://127.0.0.1:41655'
const requireCheck = process.argv.includes('--check-s5')
const worklistProof = process.argv.includes('--no-legacy-worklist')
if (worklistProof && requireCheck)
  throw new Error('The legacy comparison diagnostic must be off for the no-derivation proof')
const server = Bun.spawn(
  [
    'timeout',
    '600s',
    process.execPath,
    'run',
    '--cwd',
    'apps/web',
    'dev',
    '--',
    '--config',
    'vite.sidebar-pool-perf.config.ts',
    '--host',
    '127.0.0.1',
    '--port',
    '41655',
  ],
  { stdout: 'ignore', stderr: 'inherit' },
)
console.log(`Synthetic sidebar server PID ${server.pid}`)
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined
try {
  const until = Date.now() + 60000
  while (true) {
    try {
      if (
        (
          await fetch(`${origin}/test/sidebar-renderer.browser.html`, {
            signal: AbortSignal.timeout(2000),
          })
        ).ok
      )
        break
    } catch {}
    if (Date.now() >= until) throw new Error('Synthetic sidebar server did not start')
    await Bun.sleep(200)
  }
  browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--enable-precise-memory-info', '--js-flags=--expose-gc'],
  })
  const readPaint = (page: Page) =>
    page.evaluate(() => ({
      rows: [...document.querySelectorAll('[data-testid="unified-issue-row"]')].map((row) => {
        const body = row.querySelector('[data-issue-row]')!
        const css = getComputedStyle(body)
        return {
          id: body.getAttribute('data-issue-row'),
          text: row.textContent,
          selected: body.getAttribute('data-selected'),
          class: body.className,
          height: body.getBoundingClientRect().height,
          color: css.color,
          background: css.backgroundColor,
          font: css.font,
        }
      }),
      guests: [...document.querySelectorAll('[data-session]')].map((row) => ({
        id: row.getAttribute('data-session'),
        text: row.textContent,
        class: row.className,
      })),
      bands: [...document.querySelectorAll('[data-testid="project-group-label"]')].map(
        (row) => row.textContent,
      ),
      folds: [
        ...document.querySelectorAll(
          '[data-testid="snoozed-fold-toggle"], [data-testid="closed-fold-toggle"]',
        ),
      ].map((row) => row.textContent),
    }))
  const results: Record<string, unknown> = {}
  const modes = worklistProof ? (['pool', 'legacy'] as const) : (['legacy', 'pool'] as const)
  for (const mode of modes) {
    const page = await browser.newPage({
      viewport: { width: 1000, height: 800 },
      reducedMotion: 'reduce',
    })
    const checkpoints: Array<{ phase: string; worklist: number; publishes: number }> = []
    const checkpoint = async (phase: string, mustAdvance = false) => {
      if (!worklistProof) return
      // The census is enabled before the provider mounts, never reset, and
      // covers ALL runtime owners, including bootstrap/rebuild casualties.
      const stats = await page.evaluate(() => window.__sidebarRenderer.stats())
      const worklist = stats.runtimes.reduce((sum, row) => sum + (row.slices['worklist'] ?? 0), 0)
      const publishes = stats.runtimes.reduce((sum, row) => sum + row.publishes, 0)
      if (!stats.enabled || stats.dropped !== 0 || publishes === 0)
        throw new Error(`${mode} ${phase}: inactive or incomplete store-stats census`)
      const previous = checkpoints.at(-1)?.worklist ?? 0
      if (mode === 'pool' && worklist !== 0)
        throw new Error(`${mode} ${phase}: legacy worklist derived ${worklist} times (expected 0)`)
      if (mode === 'legacy' && (worklist === 0 || (mustAdvance && worklist <= previous)))
        throw new Error(`${mode} ${phase}: expected the existing legacy derivation; got ${worklist}`)
      checkpoints.push({ phase, worklist, publishes })
      console.log(`${mode} ${phase}: worklist=${worklist}, publishes=${publishes}`)
    }
    const failures: string[] = []
    page.on('pageerror', (error) => {
      failures.push(error.message)
      console.error(error.message)
    })
    await page.goto(
      `${origin}/test/sidebar-renderer.browser.html?rows=${count}&mobxSidebar=${mode === 'pool' ? 1 : 0}&perfPanel=1${worklistProof ? '&worklistProof=1' : ''}${requireCheck && mode === 'pool' ? '&mobxSidebarCheck=1' : ''}`,
      { timeout: 60000, waitUntil: 'networkidle' },
    )
    await page
      .waitForFunction(
        (target) =>
          window.__sidebarRenderer?.ready() &&
          document.querySelector(`[data-issue-row="${target}"]`) !== null &&
          document.querySelectorAll('[data-session^="synthetic-guest-"]').length === 2,
        target,
        { timeout: 30000 },
      )
      .catch(async (error) => {
        console.error(
          mode,
          await page.evaluate(() => ({
            ready: window.__sidebarRenderer?.ready(),
            state: window.__sidebarRenderer?.state(),
            errors: window.__sidebarRenderer?.failures(),
            text: document.body.innerText.slice(0, 4000),
          })),
        )
        throw error
      })
    await page.evaluate(
      () =>
        new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        ),
    )
    await page.evaluate(() => document.fonts.ready)
    await checkpoint('bootstrap')
    if (requireCheck && mode === 'pool')
      await page.waitForFunction(
        () => globalThis.__podiumSidebarPerf?.read().check.state === 'match',
        null,
        { timeout: 30000 },
      )
    const check = await page.evaluate(() => window.__sidebarRenderer.perf()?.check)
    const initial = await readPaint(page)
    await page.screenshot({ path: `${out}/${mode}.png`, fullPage: true })
    await page.getByText('Only responsive target', { exact: true }).click()
    await page.waitForFunction(
      (target) => window.__sidebarRenderer.state().selected === target,
      target,
    )
    await page.evaluate(
      () =>
        new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        ),
    )
    const navigation = await page.evaluate(() => window.__sidebarRenderer.state())
    const click = await page.evaluate(() => window.__sidebarRenderer.perf()?.input)
    await checkpoint('issue selection')
    await page.getByTestId('snoozed-fold-toggle').click()
    await page.getByTestId('closed-fold-toggle').click()
    await page.waitForFunction(
      () => document.querySelectorAll('[data-testid="folded-work-row"]').length === 2,
    )
    const folded = await page.locator('[data-testid="folded-work-row"]').allTextContents()
    await checkpoint('tail folds')
    await page.getByTestId('work-search-input').fill('only responsive target')
    await page.waitForFunction(
      () => document.querySelectorAll('[data-testid="unified-issue-row"]').length === 1,
    )
    const filter = await page.getByTestId('work-search-count').textContent()
    await checkpoint('filter')
    await page.getByTestId('work-search-clear').click()
    await page.waitForFunction(
      (expected) =>
        document.querySelectorAll('[data-testid="unified-issue-row"]').length === expected,
      initial.rows.length,
    )
    await page.evaluate(
      () =>
        new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        ),
    )
    await page.evaluate(() => window.__sidebarRenderer.update({ title: 'Changed synthetic title' }))
    await page.getByText('Changed synthetic title', { exact: true }).waitFor()
    await page.evaluate(
      () =>
        new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        ),
    )
    const update = await page.evaluate(() => window.__sidebarRenderer.perf()?.lastUpdate)
    await checkpoint('incoming update', true)
    const updated = await readPaint(page)
    if (worklistProof) {
      await page.locator(`[data-issue-row="${target}"]`).click({ button: 'right' })
      await page.getByRole('menu').waitFor()
      await checkpoint('issue menu')
      await page.keyboard.press('Escape')
      await page.getByRole('menu').waitFor({ state: 'hidden' })
      await page.getByRole('button', { name: 'Collapse project', exact: true }).click()
      await checkpoint('project fold')
      await page.getByRole('button', { name: 'Expand project', exact: true }).click()
      await page.getByRole('button', { name: /^Collapse pinned$/i }).click()
      await checkpoint('pinned fold')
      await page.getByRole('button', { name: /^Expand pinned$/i }).click()
      await page.getByTestId('manage-projects').click()
      const projects = page.getByRole('dialog')
      await projects.getByRole('button', { name: 'Move empty up' }).click()
      await projects.getByRole('button', { name: 'Save order' }).click()
      await projects.waitFor({ state: 'hidden' })
      await page.waitForFunction(
        () => window.__sidebarRenderer.state().projectOrder?.[0] === 'empty-repo',
      )
      await checkpoint('manage projects')
      await page.evaluate(() => window.__sidebarRenderer.palette(true))
      const palette = page.getByRole('dialog', { name: 'Command palette' })
      await palette.waitFor()
      await palette.getByRole('combobox').press('ArrowDown')
      await checkpoint('command palette')
      await palette.getByRole('combobox').press('Escape')
      await palette.waitFor({ state: 'hidden' })
      // Restore the shared comparison fixture's original project order.
      await page.getByTestId('manage-projects').click()
      await projects.getByRole('button', { name: 'Move project up' }).click()
      await projects.getByRole('button', { name: 'Save order' }).click()
      await projects.waitFor({ state: 'hidden' })
    }
    await page.locator('[data-session="synthetic-guest-0"] button').first().click()
    await page.waitForFunction(() => window.__sidebarRenderer.state().pane === 'synthetic-guest-0')
    const guestNavigation = await page.evaluate(() => window.__sidebarRenderer.state())
    await checkpoint('guest selection')
    await page.evaluate(() => window.__sidebarRenderer.rail(true))
    await page.getByTestId('sidebar-rail').waitFor()
    const rail = await page.locator('[data-testid="sidebar-rail"]').innerText()
    await checkpoint('collapsed rail')
    if (worklistProof) {
      await page.getByTestId('sidebar-rail').getByText(targetSeq, { exact: true }).click()
      await page.waitForFunction(
        (target) => window.__sidebarRenderer.state().selected === target,
        target,
      )
      await checkpoint('rail selection')
      await page.evaluate(() => window.__sidebarRenderer.update({ title: 'Rail feed update' }))
      await page.getByTestId('sidebar-rail').getByText(targetSeq, { exact: true }).hover()
      await page.getByTestId('rail-hover-card').getByText(/Rail feed update$/).waitFor()
      await checkpoint('rail incoming update', true)
    }
    await page.evaluate(() => window.__sidebarRenderer.rail(false))
    await page.getByTestId('work-scroll').waitFor()
    await checkpoint('expanded sidebar')
    if (worklistProof) {
      const coarseNow = await page.evaluate(() => window.__sidebarRenderer.state().coarseNow)
      console.log(`${mode}: waiting for the real runtime's idle coarse-clock tick`)
      await page.waitForFunction(
        (before) => window.__sidebarRenderer.state().coarseNow !== before,
        coarseNow,
        { timeout: 75000 },
      )
      await page.evaluate(
        () => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))),
      )
      await checkpoint('idle clock tick', true)
    }
    const builds: unknown[] = []
    const cdp = await page.context().newCDPSession(page)
    for (const [name, rebuild] of [
      ['renderer-bob', false],
      ['renderer-bob', true],
      [null, false],
    ] as const) {
      const began = performance.now()
      await page.evaluate(({ name, rebuild }) => window.__sidebarRenderer.show(name, rebuild), {
        name,
        rebuild,
      })
      if (name !== null) await page.waitForFunction(() => window.__sidebarRenderer.ready())
      const readyMs = performance.now() - began
      // The retained exit/motion callbacks have their existing finite lifetime.
      // Measure readiness separately, then check ownership after that tail.
      await page.evaluate(() => new Promise<void>((resolve) => setTimeout(resolve, 1000)))
      await cdp.send('HeapProfiler.collectGarbage')
      // MobX's abandoned-render reactions are owned by FinalizationRegistry.
      // Its cleanup runs in a later task; back-to-back collections retain the
      // reaction's pool before that task has had a chance to dispose it.
      await page.evaluate(() => new Promise<void>((resolve) => setTimeout(resolve, 100)))
      await cdp.send('HeapProfiler.collectGarbage')
      const survivors = await page.evaluate(() => window.__sidebarRenderer.survivors())
      if (survivors.length) throw new Error(`${mode} principal retained ${survivors.join(', ')}`)
      const heap = await cdp.send('Runtime.getHeapUsage')
      await checkpoint(name === null ? 'sign out' : rebuild ? 'runtime rebuild' : 'principal switch')
      builds.push({
        name,
        rebuild,
        readyMs,
        elapsedMs: performance.now() - began,
        heap: heap.usedSize,
        survivors,
      })
    }
    if (failures.length) throw new Error(`${mode} browser errors: ${failures.join('; ')}`)
    const fixtureFailures = await page.evaluate(() => window.__sidebarRenderer.failures())
    if (fixtureFailures.length) throw new Error(fixtureFailures.join('; '))
    results[mode] = {
      initial,
      navigation,
      guestNavigation,
      click,
      check,
      folded,
      filter,
      update,
      updated,
      rail,
      builds,
      ...(worklistProof ? { checkpoints } : {}),
    }
  }
  const legacy = results['legacy'] as {
    initial: unknown
    navigation: { selected: unknown; pane: unknown }
    guestNavigation: { selected: unknown; pane: unknown }
    folded: unknown
    filter: unknown
    updated: unknown
    rail: unknown
    update: { work: { rows: number } }
  }
  const pool = results['pool'] as typeof legacy
  for (const field of ['initial', 'folded', 'filter', 'updated', 'rail'] as const)
    if (JSON.stringify(legacy[field]) !== JSON.stringify(pool[field]))
      throw new Error(`Sidebar parity differs at ${field}`)
  if (
    legacy.navigation.selected !== pool.navigation.selected ||
    legacy.navigation.pane !== pool.navigation.pane
  )
    throw new Error('Sidebar navigation differs')
  if (
    legacy.guestNavigation.selected !== pool.guestNavigation.selected ||
    legacy.guestNavigation.pane !== pool.guestNavigation.pane
  )
    throw new Error('Guest navigation differs')
  if ((pool.update?.work.rows ?? Infinity) > (legacy.update?.work.rows ?? 0))
    throw new Error('Pool row commits exceed legacy')
  await writeFile(`${out}/results.json`, JSON.stringify(results, null, 2))
  console.log(`Sidebar browser parity green; evidence ${out}`)
  if (worklistProof) console.log('No legacy worklist derivation: pool 0 throughout; legacy control derived')
} finally {
  await browser?.close()
  server.kill()
  await server.exited
}
