/** Bounded layout + real DOM routing proof, with no backend/provider.
 * Run through scripts/validation-admission.ts focused (hold validation:6567).
 * CONTEXT_EVIDENCE_DIR selects the uncommitted screenshot/report directory. */
import assert from 'node:assert/strict'
import { mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { chromium, expect, type Page } from '@playwright/test'

const out = resolve(process.env.CONTEXT_EVIDENCE_DIR ?? '/tmp/context-usage-6588')
await mkdir(out, { recursive: true })
const port = 55688
const origin = `http://127.0.0.1:${port}`
await Bun.write(`${out}/vite.log`, '')
await Bun.write(`${out}/vite-error.log`, '')
const server = Bun.spawn(
  [
    'bun',
    'run',
    '--cwd',
    'apps/web',
    'dev',
    '--config',
    'harness/vite.context-usage.config.ts',
    '--host',
    '127.0.0.1',
    '--port',
    String(port),
    '--strictPort',
  ],
  {
    detached: true,
    stdout: Bun.file(`${out}/vite.log`),
    stderr: Bun.file(`${out}/vite-error.log`),
  },
)
const report: Record<string, unknown> = {
  kind: 'RUN — isolated layout harness; invented normalized data',
  screenshots: [] as string[],
  layouts: [] as unknown[],
}
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined
const errors: string[] = []
try {
  const deadline = Date.now() + 60_000
  while (true) {
    if (server.exitCode !== null) throw new Error(`Layout server exited ${server.exitCode}`)
    if (
      (await Bun.file(`${out}/vite.log`).text()).includes(`http://127.0.0.1:${port}/`) &&
      (await fetch(`${origin}/harness/context-usage.html`)
        .then((r) => r.ok)
        .catch(() => false))
    )
      break
    if (Date.now() > deadline) throw new Error('Layout server did not start')
    await Bun.sleep(150)
  }
  browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] })
  const page = await browser.newPage({ viewport: { width: 960, height: 820 } })
  page.on('pageerror', (error) => errors.push(error.message))
  // No active instance, external account or real provider is reachable here.
  await page.route('**/*', (route) =>
    route.request().url().startsWith(origin) ? route.continue() : route.abort(),
  )
  const data = (target: Page = page) =>
    target.evaluate(
      () =>
        (
          window as unknown as {
            __contextFixture: {
              reads: { aborted: boolean }[]
              counts: { sends: number; interrupts: number; globalEscapes: number }
            }
          }
        ).__contextFixture,
    )
  const shot = async (name: string, target: Page = page) => {
    await target.screenshot({ path: `${out}/${name}.png` })
    ;(report.screenshots as string[]).push(`${name}.png`)
  }
  for (const compact of [false, true]) {
    for (const width of [960, 360]) {
      await page.setViewportSize({ width, height: 820 })
      const name = `${compact ? 'compact' : 'regular'}-${width}`
      await page.goto(
        `${origin}/harness/context-usage.html?${compact ? 'compact&' : ''}theme=light`,
      )
      const ring = page.getByTestId('context-usage')
      const model = page.getByTestId('session-model')
      const panel = page.getByTestId('context-usage-panel')
      await expect(ring).toBeVisible()
      await page.getByRole('textbox').fill('Review the context measurement.')
      await page.evaluate(() => {
        const ta = document.querySelector('textarea')
        if (!ta) throw new Error('Missing composer textarea')
        ta.setSelectionRange(7, 7)
      })
      assert.equal((await data()).reads.length, 0)
      await shot(`${name}-closed`)
      const r = await ring.boundingBox(),
        m = await model.boundingBox()
      assert.ok(r && m)
      assert.ok(
        r.x >= m.x + m.width - 1 && r.x - m.x - m.width <= 4,
        'circle immediately follows model/effort',
      )
      assert.ok(Math.abs(r.y - m.y) < 2)
      assert.ok(r.x + r.width <= width && m.x >= 0)
      const modelText = await model
        .getByRole('button', { name: 'Model', exact: true })
        .locator('.truncate')
        .evaluate((el) => ({ content: el.scrollWidth, available: el.clientWidth }))
      assert.ok(
        modelText.content <= modelText.available,
        'model label remains readable at narrow width',
      )
      assert.equal(
        await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
        false,
      )
      await ring.hover()
      await expect(panel).toBeVisible()
      await expect(panel).toContainText('Context composition')
      assert.equal((await data()).reads.length, 1)
      assert.equal(
        await page
          .getByRole('textbox')
          .evaluate(
            (ta) =>
              document.activeElement === ta && (ta as HTMLTextAreaElement).selectionStart === 7,
          ),
        true,
        'hover preserves caret',
      )
      const p = await panel.boundingBox()
      assert.ok(p && p.x >= 0 && p.x + p.width <= width && p.y >= 0 && p.y + p.height <= 820)
      assert.equal(
        await panel.evaluate((el) => el.scrollHeight > el.clientHeight),
        true,
        'detail scrolls within its bound',
      )
      await shot(`${name}-open`)
      ;(report.layouts as unknown[]).push({
        name,
        viewport: { width, height: 820 },
        ring: r,
        model: m,
        popup: p,
        reads: 1,
        hoverPreservesCaret: true,
        noHorizontalOverflow: true,
      })
      await page.keyboard.press('Escape')
      await expect(panel).not.toBeVisible()
      assert.deepEqual((await data()).counts, { sends: 0, interrupts: 0, globalEscapes: 0 })
    }
  }

  // One actual pointer/keyboard boundary, including the textarea's interrupt
  // chord, native non-submit button behavior, popup Tab order and focus return.
  await page.setViewportSize({ width: 960, height: 820 })
  await page.goto(`${origin}/harness/context-usage.html`)
  const ring = page.getByTestId('context-usage'),
    panel = page.getByTestId('context-usage-panel')
  await page.getByRole('textbox').focus()
  await ring.hover()
  await expect(panel).toBeVisible()
  await page.mouse.move(10, 100)
  await expect(panel).not.toBeVisible()
  await expect(page.getByRole('textbox')).toBeFocused()
  await page.keyboard.press('Tab')
  await expect(page.getByRole('button', { name: 'Model', exact: true })).toBeFocused()
  await page.keyboard.press('Tab')
  await expect(page.getByRole('button', { name: 'Effort', exact: true })).toBeFocused()
  await page.keyboard.press('Tab')
  await expect(ring).toBeFocused()
  await expect(panel).toBeVisible()
  await expect(panel).toContainText('Context composition')
  const focus = await ring.evaluate((el) => ({
    visible: el.matches(':focus-visible'),
    outline: getComputedStyle(el).outlineWidth,
  }))
  assert.equal(focus.visible, true)
  assert.notEqual(focus.outline, '0px')
  const name = await ring.getAttribute('aria-label')
  assert.ok(name?.includes('84,000 (reported) tokens used'))
  await shot('keyboard-focus')
  await page.keyboard.press('Enter')
  await page.keyboard.press('Space')
  await expect(panel).toBeVisible()
  assert.equal((await data()).counts.sends, 0)
  await page.keyboard.press('Tab')
  await expect(page.getByRole('button', { name: 'Close context usage' })).toBeFocused()
  await page.getByRole('textbox').click({ position: { x: 8, y: 8 } })
  await expect(page.getByRole('textbox')).toBeFocused()
  await expect(panel).not.toBeVisible()
  await page.keyboard.press('Tab')
  await page.keyboard.press('Tab')
  await page.keyboard.press('Tab')
  await expect(ring).toBeFocused()
  await expect(panel).toBeVisible()
  await page.keyboard.press('Tab')
  await expect(page.getByRole('button', { name: 'Close context usage' })).toBeFocused()
  await page.keyboard.press('Escape')
  await expect(panel).not.toBeVisible()
  await expect(ring).toBeFocused()
  assert.deepEqual((await data()).counts, { sends: 0, interrupts: 0, globalEscapes: 0 })
  report.keyboard = {
    tabOrder: ['Model', 'Effort', 'Context usage', 'Close context usage'],
    visibleFocus: focus,
    accessibleName: name,
    enterSpaceSubmissions: 0,
    escapeGlobalCancels: 0,
    escapeRunInterrupts: 0,
    focusReturnsToTrigger: true,
    hoverLeaveThenTabOpens: true,
    outsideTextareaKeepsClickedFocus: true,
  }

  // Existing picker menus remain reachable alongside the circle.
  await page.getByRole('button', { name: 'Model', exact: true }).click()
  await expect(page.getByRole('menuitem', { name: /Demo Small/ })).toBeVisible()
  await page.keyboard.press('Escape')
  await page.getByRole('button', { name: 'Effort', exact: true }).click()
  await expect(page.getByRole('menuitem', { name: /Low/ })).toBeVisible()
  await page.keyboard.press('Escape')
  report.pickerMenusPreserved = true

  await page.goto(`${origin}/harness/context-usage.html?readonly&compact`)
  await expect(page.getByTestId('session-model')).toHaveAttribute('data-configurable', 'false')
  await page.getByTestId('context-usage').hover()
  await expect(page.getByTestId('context-usage-panel')).toContainText('Context composition')
  await shot('readonly-compact')
  await page.goto(`${origin}/harness/context-usage.html?future&state=estimated`)
  await expect(page.getByTestId('context-usage')).toBeVisible()
  await expect(page.getByTestId('session-model')).toHaveCount(0)
  await page.getByTestId('context-usage').hover()
  await expect(page.getByTestId('context-usage-panel')).toContainText('21.375% (estimated)')
  await shot('unknown-harness')
  report.unknownHarness = 'Same normalized fixture and component; no model chip required'

  const touch = await browser.newContext({
    viewport: { width: 360, height: 820 },
    hasTouch: true,
    isMobile: true,
  })
  const touchPage = await touch.newPage()
  touchPage.on('pageerror', (error) => errors.push(error.message))
  await touchPage.route('**/*', (route) =>
    route.request().url().startsWith(origin) ? route.continue() : route.abort(),
  )
  await touchPage.goto(`${origin}/harness/context-usage.html?compact&theme=dark`)
  await touchPage.getByTestId('context-usage').tap()
  await expect(touchPage.getByTestId('context-usage-panel')).toContainText('Context composition')
  await shot('touch-compact-narrow', touchPage)
  assert.equal((await data(touchPage)).reads.length, 1)
  await touchPage.getByRole('button', { name: 'Close context usage' }).tap()
  await expect(touchPage.getByTestId('context-usage-panel')).not.toBeVisible()
  assert.equal((await data(touchPage)).counts.sends, 0)
  report.touch = { tapOpensSameBreakdown: true, reads: 1, closeDismisses: true, submissions: 0 }
  await touch.close()
  assert.deepEqual(errors, [])
  report.errors = errors
  report.result = 'PASS'
} catch (error) {
  report.result = 'FAIL'
  report.error = String(error)
  report.errors = errors
  throw error
} finally {
  await Bun.write(`${out}/interaction-proof.json`, JSON.stringify(report, null, 2))
  await browser?.close()
  server.kill()
  await server.exited
}
console.log(JSON.stringify(report, null, 2))
