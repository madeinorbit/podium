/**
 * Isolate the POD-5844 named animation without loading live operator data.
 *
 * bun apps/web/harness/working-mark-style.tsx --output <count-only.json>
 *
 * Uses the exact historical/current WorkingMark markup and motion stylesheet.
 * CDP duration/count metrics run without CPU sampling or timeline recording.
 * This measures the mark fixture, not whole-app CPU or WebKit/GPU cost.
 */
import { execFileSync } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { chromium, type Browser, type Page } from '@playwright/test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { WorkingMark } from '../src/lib/motion/WorkingMark'

const ROOT = join(import.meta.dir, '../../..')
const MOTION = 'apps/web/src/lib/motion/'
const args = process.argv.slice(2)
function option(name: string, fallback: string): string {
  const index = args.indexOf(`--${name}`)
  return index < 0 ? fallback : (args[index + 1] ?? '')
}
const legacyRef = option('legacy-ref', '44809b1850')
const marks = Number(option('marks', '4'))
const windowSeconds = Number(option('window', '60'))
const output = option('output', '')
if (!output || !Number.isInteger(marks) || marks < 1 || !Number.isFinite(windowSeconds) || windowSeconds <= 0) {
  throw new Error('Provide --output <path>, --marks <positive integer>, --window <positive seconds>')
}
function historical(path: string): string {
  return execFileSync('git', ['show', `${legacyRef}:${path}`], { cwd: ROOT, encoding: 'utf8' })
}
const sourceRef = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim()
const legacySourceRef = execFileSync('git', ['rev-parse', `${legacyRef}^{commit}`], { cwd: ROOT, encoding: 'utf8' }).trim()
const currentCss = await readFile(join(ROOT, MOTION, 'motion.css'), 'utf8')
const legacyCss = historical(`${MOTION}motion.css`)
const temporary = await mkdtemp(join(import.meta.dir, '.working-mark-style-'))

try {
  const legacyModule = join(temporary, 'WorkingMark.tsx')
  await writeFile(legacyModule, historical(`${MOTION}WorkingMark.tsx`))
  const { WorkingMark: LegacyMark } = await import(legacyModule)
  function markup(component: typeof WorkingMark): string {
    return Array.from({ length: marks }, () =>
      `<div class="fixture-row"><span>Working</span>${renderToStaticMarkup(createElement(component, { size: 12 }))}</div>`,
    ).join('')
  }
  const legacyMarkup = markup(LegacyMark)
  const currentMarkup = markup(WorkingMark)
  const assets = new Map(
    ['small', 'medium', 'large'].map((size) => {
      const name = `working-mark-${size}.svg`
      return [`/${name}`, historical(`${MOTION}${name}`)]
    }),
  )
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch(request) {
      const asset = assets.get(new URL(request.url).pathname)
      if (asset !== undefined) return new Response(asset, { headers: { 'content-type': 'image/svg+xml' } })
      return new Response(`<!doctype html><html class="dark" data-theme="podium"><head>
        <style>body{margin:16px;background:#141416;color:#ddd;font:13px sans-serif}
        .fixture-row{display:flex;align-items:center;gap:8px;height:28px;width:320px}</style>
        <style id="motion">${legacyCss}</style></head><body>${legacyMarkup}</body></html>`,
        { headers: { 'content-type': 'text/html' } })
    },
  })
  let browser: Browser | undefined
  try {
    browser = await chromium.launch({ headless: true })
    const page = await browser.newPage({ viewport: { width: 1600, height: 1000 }, reducedMotion: 'no-preference' })
    const errors: string[] = []
    page.on('pageerror', (error) => errors.push(error.message))
    page.on('requestfailed', (request) => errors.push(request.failure()?.errorText ?? 'request failed'))
    await page.goto(server.url.href, { waitUntil: 'networkidle' })
    const cdp = await page.context().newCDPSession(page)
    await cdp.send('Performance.enable')
    async function metrics(): Promise<Record<string, number>> {
      const response = await cdp.send('Performance.getMetrics')
      return Object.fromEntries(response.metrics.map(({ name, value }) => [name, value]))
    }
    async function state(page: Page) {
      return page.evaluate(() => {
        const cells = [...document.querySelectorAll('.pod-mark')]
        const animations = cells.flatMap((cell) => cell.getAnimations({ subtree: true }))
        return {
          visible: document.visibilityState,
          marks: cells.length,
          circles: cells.reduce((total, cell) => total + cell.querySelectorAll('circle').length, 0),
          visibleMarks: cells.filter((cell) => {
            const box = cell.getBoundingClientRect()
            return box.width > 0 && box.height > 0 && box.top >= 0 && box.bottom <= innerHeight
          }).length,
          animations: animations.map((animation) => ({
            name: (animation as CSSAnimation).animationName,
            playState: animation.playState,
            currentTime: animation.currentTime,
          })),
        }
      })
    }
    const rows = []
    for (const arm of ['legacy-running', 'legacy-paused', 'legacy-restored', 'current-static']) {
      if (arm === 'legacy-paused' || arm === 'legacy-restored') {
        await page.evaluate((paused) => {
          for (const animation of document.getAnimations()) paused ? animation.pause() : animation.play()
        }, arm === 'legacy-paused')
      } else if (arm === 'current-static') {
        await page.evaluate(({ css, html }) => {
          document.getElementById('motion')!.textContent = css
          document.body.innerHTML = html
        }, { css: currentCss, html: currentMarkup })
      }
      await page.waitForTimeout(3000)
      const beforeState = await state(page)
      const expectedAnimations = arm === 'current-static' ? 0 : marks
      if (beforeState.visible !== 'visible' || beforeState.visibleMarks !== marks || beforeState.circles !== marks * 8 || beforeState.animations.length !== expectedAnimations) {
        throw new Error(`${arm}: invalid fixture: ${JSON.stringify(beforeState)}`)
      }
      if (beforeState.animations.some((animation) => animation.name !== 'podium-mark-frames' || animation.playState !== (arm === 'legacy-paused' ? 'paused' : 'running'))) {
        throw new Error(`${arm}: unexpected animation state`)
      }
      const before = await metrics()
      await page.waitForTimeout(windowSeconds * 1000)
      const after = await metrics()
      const afterState = await state(page)
      if (errors.length || afterState.visible !== 'visible') throw new Error(errors.join('; ') || 'Fixture became hidden')
      if (afterState.animations.some((animation, index) => {
        const start = beforeState.animations[index]?.currentTime
        if (typeof start !== 'number' || typeof animation.currentTime !== 'number') return true
        return arm === 'legacy-paused' ? animation.currentTime !== start : animation.currentTime <= start
      })) throw new Error(`${arm}: animation did not hold/advance as expected`)
      const delta = (name: string): number => {
        if (!(name in before) || !(name in after)) throw new Error(`Missing CDP metric ${name}`)
        return after[name]! - before[name]!
      }
      const row = {
        arm,
        elapsedSeconds: delta('Timestamp'),
        styleCount: delta('RecalcStyleCount'),
        styleMs: delta('RecalcStyleDuration') * 1000,
        layoutCount: delta('LayoutCount'),
        layoutMs: delta('LayoutDuration') * 1000,
        scriptMs: delta('ScriptDuration') * 1000,
        taskMs: delta('TaskDuration') * 1000,
        beforeState,
        afterState,
      }
      rows.push(row)
      console.log(JSON.stringify(row))
    }
    await writeFile(output, `${JSON.stringify({
      collectedAt: new Date().toISOString(), sourceRef, legacySourceRef,
      browser: browser.version(), headless: true, viewport: { width: 1600, height: 1000 },
      marks, windowSeconds, warmupSeconds: 3, profiler: false, traceRecorder: false,
      fixture: 'isolated exact mark markup/motion CSS; no live data, React updates or messages', rows,
    }, null, 2)}\n`)
  } finally {
    await browser?.close()
    await server.stop(true)
  }
} finally {
  await rm(temporary, { recursive: true, force: true })
}
