/** Run after the isolated Vite build. Timing needs bench:flatblock; --counts-only never reads a clock. */
import { createServer } from 'node:http'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join, extname, dirname } from 'node:path'
import { chromium } from '@playwright/test'

const dir = 'packages/worklist-proto/harness/browser/dist-window-cost'
const countsOnly = process.argv.includes('--counts-only')
const mime: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' }
const server = createServer((req, res) => {
  const path = new URL(req.url ?? '/', 'http://localhost').pathname
  try {
    const file = join(dir, path === '/' ? 'window-cost.html' : path)
    res.writeHead(200, { 'content-type': mime[extname(file)] ?? 'application/octet-stream' })
    res.end(readFileSync(file))
  } catch { res.writeHead(404); res.end() }
})
await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
const address = server.address()
if (address === null || typeof address === 'string') throw new Error('no browser probe port')
const browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] })
try {
  const rows: object[] = []
  for (const scale of [1, 4]) {
    const context = await browser.newContext({ viewport: { width: 1600, height: 5800 } })
    try {
      const page = await context.newPage()
      await page.goto(`http://127.0.0.1:${address.port}/window-cost.html?scale=${scale}${countsOnly ? '&counts-only' : ''}`)
      await page.waitForFunction(() => (window as unknown as { windowCost?: object }).windowCost !== undefined, undefined, { timeout: 120_000 })
      const result = await page.evaluate(() => (window as unknown as { windowCost: { error?: string } }).windowCost)
      if (result.error !== undefined) throw new Error(result.error)
      rows.push(result)
    } finally { await context.close() }
  }
  const output = { browser: browser.version(), rows }
  const out = process.argv.slice(2).find((arg) => arg !== '--counts-only') ??
    `packages/worklist-proto/harness/browser/results/window-cost${countsOnly ? '-counts' : ''}.json`
  mkdirSync(dirname(out), { recursive: true })
  writeFileSync(out, JSON.stringify(output, null, 2))
  console.info(JSON.stringify(output, null, 2))
} finally {
  await browser.close()
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
}
