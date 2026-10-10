/** Compressed, review-only screenshots/video of the self-contained options.
 *  Never supplies benchmark numbers. Own context, recorded PIDs, no live app.
 *  bun apps/web/harness/working-mark-capture.mjs --html <file> --out <issue-dir>
 */
import { mkdir, rename, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'
import { chromium } from '@playwright/test'

const { values } = parseArgs({ options: { html: { type: 'string' }, out: { type: 'string' } } })
if (!values.html || !values.out)
  throw Error('Self-contained --html and issue-owned --out are required')
const out = resolve(values.out)
await mkdir(out, { recursive: true })
const browser = await chromium.launch({ headless: true })
const context = await browser.newContext({
  viewport: { width: 1120, height: 820 },
  deviceScaleFactor: 2,
  reducedMotion: 'no-preference',
  recordVideo: { dir: resolve(out, 'video'), size: { width: 1120, height: 820 } },
})
const cdp = await browser.newBrowserCDPSession()
await writeFile(
  resolve(out, 'capture-processes.json'),
  JSON.stringify(
    { pid: process.pid, processes: (await cdp.send('SystemInfo.getProcessInfo')).processInfo },
    null,
    2,
  ),
)
const page = await context.newPage()
try {
  await page.goto(pathToFileURL(resolve(values.html)).href, { waitUntil: 'load' })
  await page.waitForTimeout(600)
  await page.screenshot({ path: resolve(out, 'all-options-dark.png'), type: 'png' })
  for (const candidate of ['breathe', 'signal', 'apng', 'webp']) {
    await page.selectOption('#candidate', candidate)
    await page.waitForTimeout(450)
    await page.screenshot({ path: resolve(out, `${candidate}.png`), type: 'png' })
    await page.waitForTimeout(2000)
  }
  await page.click('#theme')
  await page.waitForTimeout(450)
  await page.screenshot({ path: resolve(out, 'all-options-light.png'), type: 'png' })
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.waitForTimeout(450)
  await page.screenshot({ path: resolve(out, 'reduced-motion.png'), type: 'png' })
} finally {
  await context.close()
  const video = await page.video().path()
  await rename(video, resolve(out, 'working-mark-options.webm'))
  await browser.close()
}
