/**
 * Records the working mark actually moving (POD-1259) — a still frame cannot
 * show a wave. Harness must be running; see shoot.mjs.
 */
import { rename, readdir, rm } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'

const OUT = fileURLToPath(new URL('../../../.design/POD-1259-working-mark/', import.meta.url))
const TMP = fileURLToPath(new URL('../../../.design/POD-1259-working-mark/.rec/', import.meta.url))

const browser = await chromium.launch()
const context = await browser.newContext({
  viewport: { width: 720, height: 780 },
  deviceScaleFactor: 2,
  recordVideo: { dir: TMP, size: { width: 720, height: 780 } },
})
const page = await context.newPage()
await page.goto('http://localhost:8091/mark-harness.html', { waitUntil: 'networkidle' })
await page.waitForSelector('svg circle')
// Three full 1.5s cycles, so the loop is visibly seamless.
await page.waitForTimeout(4600)
await context.close()
await browser.close()

const [file] = await readdir(TMP)
await rename(`${TMP}${file}`, `${OUT}working-mark-moving.webm`)
await rm(TMP, { recursive: true, force: true })
console.log('wrote working-mark-moving.webm')
