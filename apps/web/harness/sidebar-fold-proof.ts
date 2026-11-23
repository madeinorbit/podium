/** Matched, offline fold comparison at the POD-7415 browser scale.
 * Run on an agent VM through validation-admission, with --before=<base SHA>.
 * Default: replace only work-folds.tsx for the control. With --scroll-anchor,
 * replace only the virtualizer instead, to compare viewport preservation.
 * --trace-anchor adds clamp ownership/corrections to the clamped sample.
 */
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { chromium, type Page } from '@playwright/test'
import { createServer } from 'vite'

const before = process.argv.find((arg) => arg.startsWith('--before='))?.slice(9)
if (!before) throw new Error('Pass --before=<base SHA> for the matched control')
const base = execFileSync('git', ['rev-parse', '--verify', `${before}^{commit}`], {
  encoding: 'utf8',
}).trim()
const compareAnchoring = process.argv.includes('--scroll-anchor')
const traceAnchoring = process.argv.includes('--trace-anchor')
const virtualizerFile = 'apps/web/src/features/issues/use-bounded-virtual-list.ts'
const comparisonFile = compareAnchoring
  ? virtualizerFile
  : 'apps/web/src/features/worklist/work-folds.tsx'
const original = execFileSync('git', ['show', `${base}:${comparisonFile}`], { encoding: 'utf8' })
const out = resolve(`.artifacts/sidebar-${compareAnchoring ? 'scroll-anchor' : 'fold'}`)
await mkdir(out, { recursive: true })
const browserEnv = { ...process.env }
const userLib = `${process.env.HOME}/.cache/podium-chromium-deps/root/usr/lib/x86_64-linux-gnu`
if (existsSync(userLib)) browserEnv.LD_LIBRARY_PATH = userLib
else delete browserEnv.LD_LIBRARY_PATH
const browser = await chromium.launch({ headless: true, env: browserEnv, args: ['--no-sandbox'] })
const evidence: Record<string, unknown> = {
  base,
  comparisonFile,
  viewport: { width: 1600, height: 950 },
}

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

async function anchor(
  page: Page,
  mode: string,
  name: string,
  foldIndex = 0,
  targetIndex = 1,
  bottom = false,
) {
  if (bottom)
    await page.getByTestId('work-scroll').evaluate((el) => {
      el.scrollTop = el.scrollHeight
    })
  else
    await header(page, targetIndex).evaluate((button) => button.scrollIntoView({ block: 'start' }))
  await settle(page)
  const visible = await page.getByTestId('work-scroll').evaluate((el) => {
    const viewport = el.getBoundingClientRect()
    return [...el.querySelectorAll<HTMLElement>('[data-window-row]')].flatMap((row) => {
      const rect = row.getBoundingClientRect()
      const key = row.dataset.windowRow
      return key && rect.height > 0 && rect.bottom > viewport.top && rect.top < viewport.bottom
        ? [{ key, top: rect.top }]
        : []
    })
  })
  const first = visible[0]
  if (!first) throw new Error('Missing visible anchor row')
  const { key, top } = first
  const scroll = await page.getByTestId('work-scroll').evaluate((el) => el.scrollTop)
  if (traceAnchoring && name === 'clamped')
    await page.evaluate(() => {
      Reflect.set(window, '__anchorTrace', [{ phase: 'close' }])
      Reflect.set(window, '__traceAnchor', true)
    })
  if (name === 'large') await page.screenshot({ path: `${out}/${mode}-anchor-open.png` })
  // The header is above the viewport: do not let Playwright scroll it into view.
  await header(page, foldIndex).evaluate((button) => {
    if (button instanceof HTMLElement) button.click()
  })
  await group(page, foldIndex).getByTestId('project-group-rows').waitFor({ state: 'detached' })
  await settle(page)
  const finalRow = page.locator(`[data-window-row="${key}"]`)
  const finalTop = await finalRow.evaluateAll((rows) => rows[0]?.getBoundingClientRect().y ?? null)
  const finalScroll = await page.getByTestId('work-scroll').evaluate((el) => el.scrollTop)
  const positions = () =>
    page.getByTestId('work-scroll').evaluate((el, rows) => {
      const mounted = new Map(
        [...el.querySelectorAll<HTMLElement>('[data-window-row]')].map((row) => [
          row.dataset.windowRow,
          row.getBoundingClientRect().top,
        ]),
      )
      return rows.map(({ key, top }) => {
        const position = mounted.get(key)
        return { key, displacementPx: position === undefined ? null : position - top }
      })
    }, visible)
  const closedRows = await positions()
  if (traceAnchoring && name === 'clamped')
    await page.evaluate(() => Reflect.get(window, '__anchorTrace').push({ phase: 'reopen' }))
  if (name === 'large') await page.screenshot({ path: `${out}/${mode}-anchor-closed.png` })
  await header(page, foldIndex).evaluate((button) => {
    if (button instanceof HTMLElement) button.click()
  })
  await settle(page)
  const reopenedRows = await positions()
  const reopenedScroll = await page.getByTestId('work-scroll').evaluate((el) => el.scrollTop)
  const trace =
    traceAnchoring && name === 'clamped'
      ? await page.evaluate(() => {
          Reflect.set(window, '__traceAnchor', false)
          return Reflect.get(window, '__anchorTrace')
        })
      : undefined
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
    reopenedScroll,
    closedRows,
    reopenedRows,
    trace,
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
      plugins: [
        {
          name: 'fold-control',
          enforce: 'pre',
          transform(code, id) {
            const path = id.split('?')[0]
            let source = mode === 'before' && path === resolve(comparisonFile) ? original : code
            if (
              traceAnchoring &&
              path === resolve(virtualizerFile) &&
              !(mode === 'before' && compareAnchoring)
            ) {
              source = source
                .replace(
                  'const changed = prior !== current || top !== currentTop',
                  `const changed = prior !== current || top !== currentTop
                if (Reflect.get(window, '__traceAnchor')) Reflect.get(window, '__anchorTrace').push({
                  key: current.keys[0], currentTop, top, scrollTop, maxScroll, anchorScrollTop,
                  anchorVersion, visible, saved, section: scroll ? sectionBounds(scroll, container) : null
                })`,
                )
                .replace(
                  'scroll.scrollTop += delta',
                  `if (Reflect.get(window, '__traceAnchor')) Reflect.get(window, '__anchorTrace').push({
                  key: current.keys[0], delta, before: scroll.scrollTop, maxScroll, anchorVersion
                })
                scroll.scrollTop += delta`,
                )
            }
            return source === code ? undefined : source
          },
        },
      ],
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
      const scrollAnchor = await anchor(page, mode, 'large')
      const smallAnchor = await anchor(page, mode, 'small', 1, 2)
      const belowAnchor = await anchor(page, mode, 'below', 15, 1)
      const clampedAnchor = await anchor(page, mode, 'clamped', 0, 15, true)
      await page.emulateMedia({ reducedMotion: 'reduce' })
      const reduced = await close(page)
      await reopen(page)
      const reducedAnchor = await anchor(page, mode, 'reduced')
      await page.emulateMedia({ reducedMotion: 'no-preference' })
      const behavior = mode === 'after' ? await interactions(page) : null
      if (errors.length) throw new Error(errors.join('\n'))
      const anchors = {
        large: scrollAnchor,
        small: smallAnchor,
        below: belowAnchor,
        clamped: clampedAnchor,
        reduced: reducedAnchor,
      }
      evidence[mode] = { counts, large, small, reduced, scrollAnchor, anchors, behavior }
      console.log(
        `${mode}: 58-row commit-to-removal ms ${large.map((sample) => sample.commitToRemovalMs.toFixed(1)).join(', ')}; anchor ${JSON.stringify(scrollAnchor)}`,
      )
      await writeFile(`${out}/results.json`, JSON.stringify(evidence, null, 2))
      if (mode === 'after' || !compareAnchoring)
        for (const [name, sample] of Object.entries(anchors))
          for (const state of ['closedRows', 'reopenedRows'] as const)
            if (
              sample[state].some(
                (row) => row.displacementPx === null || Math.abs(row.displacementPx) > 1,
              )
            )
              throw new Error(`${name} ${state} lost visible rows: ${JSON.stringify(sample)}`)
    } catch (error) {
      console.error({
        mode,
        errors,
        body: await page.locator('body').innerText(),
        groups: await page.getByTestId('project-group').evaluateAll((groups) =>
          groups.map((el) => ({
            key: el.getAttribute('data-folder-key'),
            label: el.textContent?.slice(0, 120),
          })),
        ),
      })
      await page.screenshot({ path: `${out}/${mode}-failure.png` })
      throw error
    } finally {
      await page.close()
      await server.close()
    }
  }
  console.log(`Sidebar fold proof green; evidence ${out}`)
} finally {
  await browser.close()
}
