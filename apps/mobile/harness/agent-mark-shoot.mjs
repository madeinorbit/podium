/**
 * Captures the harness-mark harness (POD-1355). Run the harness first:
 *   npx vite --config vite.harness.config.ts
 * then `node harness/agent-mark-shoot.mjs`.
 */
import { mkdir } from 'node:fs/promises'
import { chromium } from 'playwright'

const PORT = process.env.HARNESS_PORT ?? '8091'
const OUT = new URL('../../../.design/POD-1355-harness-marks/', import.meta.url)
await mkdir(OUT, { recursive: true })

const browser = await chromium.launch()
const page = await browser.newPage({
  viewport: { width: 760, height: 780 },
  deviceScaleFactor: 3,
})
const problems = []
page.on('console', (m) => m.type() === 'error' && problems.push(m.text()))
page.on('pageerror', (e) => problems.push(String(e)))
await page.goto(`http://localhost:${PORT}/agent-mark-harness.html`, { waitUntil: 'networkidle' })
await page.waitForSelector('svg path')
await page.screenshot({ path: new URL('harness-marks.png', OUT).pathname, fullPage: true })

// The positive control: count the drawn marks. Six kinds × four chips + six ×
// five ladder rows + six dimmed = 66 real marks, and the unknown harness must
// draw NONE of them (it is a letter), so a count that includes it is the rig
// lying about what rendered.
const paths = await page.locator('svg path').count()
console.log(`marks drawn: ${paths}${problems.length ? ` — ERRORS: ${problems.join(' | ')}` : ''}`)

await browser.close()
if (problems.length) {
  console.error('page errors present')
  process.exit(1)
}
