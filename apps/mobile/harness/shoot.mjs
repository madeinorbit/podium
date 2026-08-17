/**
 * Captures the working-mark harness (POD-1259). Run the harness first:
 *   npx vite --config vite.harness.config.ts
 * then `node harness/shoot.mjs`.
 */
import { mkdir } from 'node:fs/promises'
import { chromium } from 'playwright'

const OUT = new URL('../../../.design/POD-1259-working-mark/', import.meta.url)
await mkdir(OUT, { recursive: true })

const browser = await chromium.launch()

async function shoot(name, { reducedMotion = 'no-preference', settle = 0 } = {}) {
  const page = await browser.newPage({
    viewport: { width: 720, height: 780 },
    deviceScaleFactor: 3,
    reducedMotion,
  })
  const problems = []
  page.on('console', (m) => m.type() === 'error' && problems.push(m.text()))
  page.on('pageerror', (e) => problems.push(String(e)))
  await page.goto('http://localhost:8091/mark-harness.html', { waitUntil: 'networkidle' })
  await page.waitForSelector('svg')
  if (settle) await page.waitForTimeout(settle)
  await page.screenshot({ path: new URL(`${name}.png`, OUT).pathname })
  const dots = await page.locator('svg circle').count()
  console.log(
    `${name}: ${dots} dots drawn${problems.length ? ` — ERRORS: ${problems.join(' | ')}` : ''}`,
  )
  await page.close()
  return problems
}

// One still of every surface the mark lands on (the wave itself is in
// record.mjs — a frame cannot show it), and the rest state an operator who
// asked for less motion gets.
const all = []
all.push(...(await shoot('working-mark-sizes', { settle: 1200 })))
all.push(...(await shoot('working-mark-reduced-motion', { reducedMotion: 'reduce', settle: 1200 })))

await browser.close()
if (all.length) {
  console.error('page errors present')
  process.exit(1)
}
