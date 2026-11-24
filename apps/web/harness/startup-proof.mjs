/** Isolated Chromium smoke check. Run from the repo: bun run test:harness-startup. */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium, expect } from '@playwright/test'
import { createLogger, createServer } from 'vite'

const webRoot = fileURLToPath(new URL('..', import.meta.url))
const out = resolve(process.argv[2] ?? '.artifacts/harness-startup')
const names = process.argv.length > 3 ? process.argv.slice(3) : ['settings-frame', 'deck']
assert(
  names.every((name) => ['settings-frame', 'deck'].includes(name)),
  'Unknown harness screen',
)
mkdirSync(out, { recursive: true })
const cacheRoot = mkdtempSync(resolve(tmpdir(), 'podium-harness-startup-'))
const result = {
  sha: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
  screens: [],
}
const browserEnv = { ...process.env }
const userLib = resolve(homedir(), '.cache/podium-chromium-deps/root/usr/lib/x86_64-linux-gnu')
if (existsSync(userLib))
  browserEnv.LD_LIBRARY_PATH = [userLib, browserEnv.LD_LIBRARY_PATH].filter(Boolean).join(':')
const browser = await chromium.launch({
  env: browserEnv,
  args: ['--no-sandbox', '--disable-dev-shm-usage'],
})
let shutdownTimedOut = false
try {
  for (const name of names) {
    const screen = { name, status: 'running', errors: [], logs: [], failed: [], pending: [] }
    result.screens.push(screen)
    const logger = createLogger('warn')
    for (const level of ['info', 'warn', 'error']) {
      const log = logger[level].bind(logger)
      logger[level] = (message, options) => {
        screen.logs.push(String(message))
        log(message, options)
      }
    }
    let server
    let context
    let page
    const pending = new Set()
    try {
      server = await createServer({
        configFile: resolve(webRoot, `vite.${name}-harness.config.ts`),
        cacheDir: resolve(cacheRoot, name),
        customLogger: logger,
        server: { host: '127.0.0.1', port: 0, strictPort: false, proxy: {} },
      })
      await server.listen()
      const address = server.httpServer.address()
      const origin = `http://127.0.0.1:${address.port}`
      context = await browser.newContext({
        viewport: { width: 1440, height: 960 },
        serviceWorkers: 'block',
      })
      // A stubbed harness must never contact an installed instance or another host.
      await context.route('**/*', (route) => {
        if (new URL(route.request().url()).origin === origin) return route.continue()
        screen.errors.push(`Unexpected request: ${route.request().url()}`)
        return route.abort()
      })
      page = await context.newPage()
      page.setDefaultTimeout(45_000)
      page.on('pageerror', (error) => screen.errors.push(error.stack ?? error.message))
      page.on('console', (message) => {
        if (message.type() === 'error' || message.type() === 'warn')
          screen.logs.push(`${message.type()}: ${message.text()}`)
      })
      page.on('request', (request) => pending.add(request.url()))
      page.on('requestfinished', (request) => pending.delete(request.url()))
      page.on('requestfailed', (request) => {
        pending.delete(request.url())
        screen.failed.push({ url: request.url(), error: request.failure() })
      })
      page.on('response', (response) => {
        if (response.status() >= 400)
          screen.failed.push({ url: response.url(), status: response.status() })
      })
      await page.goto(
        `${origin}/harness/${name}.html${name === 'settings-frame' ? '?page=appearance&populated' : ''}`,
        { waitUntil: 'domcontentloaded' },
      )
      if (name === 'settings-frame') {
        await expect(page.getByRole('heading', { name: 'Appearance', exact: true })).toBeVisible({
          timeout: 45_000,
        })
        await page.getByRole('button', { name: 'Machines', exact: true }).click()
        // Workspace headings include a visible scope tag in their accessible name.
        await expect(page.getByRole('heading', { name: /^Machines\b/ })).toBeVisible({
          timeout: 45_000,
        })
        await expect(page.getByText('Studio', { exact: true }).first()).toBeVisible()
        await expect(page.getByText('Travel laptop', { exact: true }).first()).toBeVisible()
      } else {
        await page.waitForFunction(() => Boolean(window.deck))
        await page.evaluate(() => window.deck.setWidth(525))
        await expect(page.locator('.deck-header')).toBeVisible()
        assert((await page.locator('.deck-header').innerText()).trim().length > 0)
      }
      await page.evaluate(() => document.fonts.ready)
      await page.screenshot({ path: resolve(out, `${name}.png`), animations: 'disabled' })
      assert.deepEqual(screen.errors, [], `${name}: browser errors`)
      assert.deepEqual(screen.failed, [], `${name}: failed requests`)
      screen.status = 'passed'
    } catch (error) {
      screen.status = 'failed'
      screen.failure = String(error.stack ?? error)
      screen.pending = [...pending]
      screen.body = await page?.locator('body').innerText({ timeout: 2000 }).catch(String)
      await page
        ?.screenshot({ path: resolve(out, `${name}-failed.png`), timeout: 5000 })
        .catch(() => {})
      console.error(`${name}: ${screen.failure}`)
    } finally {
      writeFileSync(resolve(out, 'result.json'), `${JSON.stringify(result, null, 2)}\n`)
      console.log(JSON.stringify(screen, null, 2))
      await context?.close()
      if (server) {
        let timer
        await Promise.race([
          server.close(),
          new Promise((done) => {
            timer = setTimeout(() => {
              shutdownTimedOut = true
              server.httpServer?.closeAllConnections()
              done()
            }, 5000)
          }),
        ])
        clearTimeout(timer)
      }
    }
  }
} finally {
  await browser.close()
  rmSync(cacheRoot, { recursive: true, force: true })
}
// A failed optimizer can leave Vite's transform promises pending forever.
// The browser has closed and diagnostics are saved; release the lane too.
if (shutdownTimedOut) process.exit(1)
assert(
  result.screens.every((screen) => screen.status === 'passed'),
  'Harness startup failed',
)
console.log(`Harness startup passed: ${names.join(', ')} captured.`)
