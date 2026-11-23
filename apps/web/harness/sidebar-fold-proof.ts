/** Matched, offline fold comparison at the POD-7415 browser scale.
 * Run on an agent VM through validation-admission, with --before=<base SHA>.
 * Only work-folds.tsx is replaced for the control; all other code/data is shared.
 */
import { execFileSync } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { chromium, type Page } from '@playwright/test'
import { createServer } from 'vite'

const before = process.argv.find((arg) => arg.startsWith('--before='))?.slice(9)
if (!before) throw new Error('Pass --before=<base SHA> for the matched control')
const base = execFileSync('git', ['rev-parse', '--verify', `${before}^{commit}`], {
  encoding: 'utf8',
}).trim()
const foldPath = 'apps/web/src/features/worklist/work-folds.tsx'
const original = execFileSync('git', ['show', `${base}:${foldPath}`], { encoding: 'utf8' })
const out = resolve('.artifacts/sidebar-fold')
await mkdir(out, { recursive: true })
const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] })
const evidence: Record<string, unknown> = { base, viewport: { width: 1600, height: 950 } }

type Sample = {
  input: number
  commit: number | null
  removed: number | null
  commitPaint: number | null
  removedPaint: number | null
  heights: Array<{ time: number; height: number }>
}
declare global {
  interface Window {
    __foldProbe: Sample
  }
}

const group = (page: Page, index = 0) => page.locator(`[data-folder-key="fold-repo-${index}"]`)
const header = (page: Page, index = 0) => group(page, index).getByTestId('project-group-label')
const settle = (page: Page) => page.waitForTimeout(450)

async function close(page: Page, index = 0) {
  await header(page, index).scrollIntoViewIfNeeded()
  await header(page, index).evaluate((button) => {
    const section = button.closest('[data-folder-key]')
    const panel = section?.querySelector('[data-work-fold-panel]')
    if (!section || !panel) throw new Error('Missing open fold')
    const sample: Sample = {
      input: 0,
      commit: null,
      removed: null,
      commitPaint: null,
      removedPaint: null,
      heights: [],
    }
    window.__foldProbe = sample
    const paint = (done: (time: number) => void) =>
      requestAnimationFrame(() => requestAnimationFrame(() => done(performance.now())))
    const observer = new MutationObserver(() => {
      const now = performance.now()
      if (button.getAttribute('aria-expanded') === 'false' && sample.commit === null) {
        sample.commit = now
        paint((time) => {
          sample.commitPaint = time
        })
      }
      if (!panel.isConnected && sample.removed === null) {
        sample.removed = now
        paint((time) => {
          sample.removedPaint = time
        })
        observer.disconnect()
      }
    })
    observer.observe(section, {
      attributes: true,
      childList: true,
      subtree: true,
    })
    button.addEventListener(
      'click',
      () => {
        sample.input = performance.now()
        const frame = () => {
          if (!panel.isConnected) return
          sample.heights.push({
            time: performance.now(),
            height: panel.getBoundingClientRect().height,
          })
          requestAnimationFrame(frame)
        }
        requestAnimationFrame(frame)
      },
      { once: true },
    )
  })
  await header(page, index).click()
  await page.waitForFunction(() => window.__foldProbe.removedPaint !== null)
  const sample = await page.evaluate(() => window.__foldProbe)
  const { commit, removed, commitPaint, removedPaint } = sample
  if (commit === null || removed === null || commitPaint === null || removedPaint === null)
    throw new Error('Incomplete fold sample')
  return {
    ...sample,
    inputToCommitMs: commit - sample.input,
    commitToRemovalMs: removed - commit,
    inputToRemovalMs: removed - sample.input,
    commitToPaintMs: commitPaint - commit,
    removalToPaintMs: removedPaint - removed,
  }
}

async function reopen(page: Page, index = 0) {
  await header(page, index).click()
  await group(page, index).getByTestId('project-group-rows').waitFor()
  await settle(page)
}

async function anchor(page: Page) {
  await header(page, 1).evaluate((button) => button.scrollIntoView({ block: 'start' }))
  await settle(page)
  const row = group(page, 1).locator('[data-window-row]').first()
  const key = await row.getAttribute('data-window-row')
  const box = await row.boundingBox()
  if (!box) throw new Error('Missing visible anchor row')
  const top = box.y
  const scroll = await page.getByTestId('work-scroll').evaluate((el) => el.scrollTop)
  // The header is above the viewport: do not let Playwright scroll it into view.
  await header(page).evaluate((button) => {
    if (button instanceof HTMLElement) button.click()
  })
  await group(page).getByTestId('project-group-rows').waitFor({ state: 'detached' })
  await settle(page)
  const finalRow = page.locator(`[data-window-row="${key}"]`)
  const finalTop = (await finalRow.boundingBox())?.y ?? null
  const finalScroll = await page.getByTestId('work-scroll').evaluate((el) => el.scrollTop)
  await header(page).evaluate((button) => {
    if (button instanceof HTMLElement) button.click()
  })
  await settle(page)
  await page.getByTestId('work-scroll').evaluate((el) => {
    el.scrollTop = 0
  })
  await settle(page)
  return {
    key,
    top,
    finalTop,
    displacementPx: finalTop === null ? null : finalTop - top,
    scroll,
    finalScroll,
  }
}

async function interactions(page: Page) {
  const first = header(page)
  await first.focus()
  await first.press('Space')
  await group(page).getByTestId('project-group-rows').waitFor({ state: 'detached' })
  if (!(await first.evaluate((button) => button === document.activeElement)))
    throw new Error('Closing lost header focus')
  let reachedNext = false
  for (let i = 0; i < 8; i++) {
    await page.keyboard.press('Tab')
    reachedNext = await group(page, 1).evaluate((el) => el.contains(document.activeElement))
    if (reachedNext) break
  }
  if (!reachedNext) throw new Error('Tab did not leave the closed group')
  await first.focus()
  await first.press('Enter')
  await settle(page)
  const firstRow = group(page).locator('[data-window-row]').first()
  await firstRow.locator('button').first().focus()
  await page.keyboard.press('End')
  await page.waitForFunction(
    () =>
      document.activeElement?.closest('[data-window-row]')?.getAttribute('aria-posinset') === '58',
  )
  await page.keyboard.press('Home')
  await page.waitForFunction(
    () =>
      document.activeElement?.closest('[data-window-row]')?.getAttribute('aria-posinset') === '1',
  )
  await first.focus()
  await first.scrollIntoViewIfNeeded()
  await settle(page)
  // A real folder drag exercises the hidden retained subtree used by quick folds.
  const grip = await group(page).getByTestId('folder-grip').boundingBox()
  if (!grip) throw new Error('Missing folder grip')
  await page.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2)
  await page.mouse.down()
  await settle(page)
  const retained = await group(page)
    .getByTestId('project-group-rows')
    .evaluate((el) => ({
      hidden: getComputedStyle(el).display === 'none',
      inert: el.hasAttribute('inert'),
    }))
  if (!retained.hidden || !retained.inert) throw new Error('Drag fold is not hidden and inert')
  const second = await header(page, 1).boundingBox()
  if (!second) throw new Error('Missing reorder destination')
  await page.mouse.move(second.x + 50, second.y + second.height + 8, { steps: 8 })
  await page.mouse.up()
  await settle(page)
  const order = await page
    .getByTestId('project-group')
    .evaluateAll((groups) => groups.map((el) => el.getAttribute('data-folder-key')))
  if (order.indexOf('fold-repo-0') <= order.indexOf('fold-repo-1'))
    throw new Error('Folder drag did not reorder')
  await group(page).getByTestId('project-group-rows').waitFor({ state: 'visible' })
  await group(page).getByTestId('folder-options').click()
  await page.getByRole('menuitem', { name: 'Move up', exact: true }).click()
  await settle(page)
  const restored = await page
    .getByTestId('project-group')
    .evaluateAll((groups) => groups.map((el) => el.getAttribute('data-folder-key')))
  if (restored[0] !== 'fold-repo-0')
    throw new Error('Folder move did not restore the original order')
  return { headerFocus: true, tabLeavesClosedGroup: true, homeEnd: true, retained, order, restored }
}

try {
  for (const mode of ['before', 'after'] as const) {
    const server = await createServer({
      configFile: resolve('apps/web/vite.sidebar.config.ts'),
      cacheDir: resolve(`apps/web/node_modules/.cache/sidebar-fold-${mode}`),
      server: { host: '127.0.0.1', port: 41659, strictPort: true, hmr: false },
      plugins:
        mode === 'before'
          ? [
              {
                name: 'fold-control',
                enforce: 'pre',
                transform(_code, id) {
                  if (id.split('?')[0] === resolve(foldPath)) return original
                },
              },
            ]
          : [],
    })
    const page = await browser.newPage({
      viewport: { width: 1600, height: 950 },
      reducedMotion: 'no-preference',
    })
    const errors: string[] = []
    page.on('pageerror', (error) => errors.push(error.message))
    try {
      await server.listen()
      await page.goto('http://127.0.0.1:41659/sidebar-harness.html?foldBench=1', { timeout: 90000 })
      await header(page).waitFor({ timeout: 60000 })
      await page.evaluate(() => document.fonts.ready)
      await settle(page)
      const counts = await page.getByTestId('project-group-count').allTextContents()
      if (
        counts.length !== 16 ||
        Number(counts[0]) !== 58 ||
        counts.reduce((sum, count) => sum + Number(count), 0) !== 423
      )
        throw new Error(`Wrong sidebar scale: ${JSON.stringify(counts)}`)
      await page.screenshot({ path: `${out}/${mode}-open.png` })
      const large = []
      for (let i = 0; i < 3; i++) {
        large.push(await close(page))
        if (i === 0) await page.screenshot({ path: `${out}/${mode}-closed.png` })
        await reopen(page)
      }
      const small = await close(page, 1)
      await reopen(page, 1)
      const scrollAnchor = await anchor(page)
      await page.emulateMedia({ reducedMotion: 'reduce' })
      const reduced = await close(page)
      await reopen(page)
      await page.emulateMedia({ reducedMotion: 'no-preference' })
      const behavior = mode === 'after' ? await interactions(page) : null
      if (errors.length) throw new Error(errors.join('\n'))
      evidence[mode] = { counts, large, small, reduced, scrollAnchor, behavior }
      console.log(
        `${mode}: 58-row commit-to-removal ms ${large.map((sample) => sample.commitToRemovalMs.toFixed(1)).join(', ')}; anchor ${JSON.stringify(scrollAnchor)}`,
      )
      await writeFile(`${out}/results.json`, JSON.stringify(evidence, null, 2))
    } finally {
      await page.close()
      await server.close()
    }
  }
  console.log(`Sidebar fold proof green; evidence ${out}`)
} finally {
  await browser.close()
}
