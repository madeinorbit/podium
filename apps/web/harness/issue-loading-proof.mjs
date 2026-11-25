/** Isolated visual/timing proof: bun run capture:issue-loading -- <output-directory>. */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium, expect } from '@playwright/test'
import { createServer } from 'vite'

const webRoot = fileURLToPath(new URL('..', import.meta.url))
const out = resolve(process.argv[2] ?? '.artifacts/issue-loading')
const surfaces = process.argv.length > 3 ? process.argv.slice(3) : ['panel', 'page']
assert(
  surfaces.every((surface) => ['panel', 'page'].includes(surface)),
  'Unknown issue surface',
)
const cache = mkdtempSync(resolve(tmpdir(), 'issue-loading-vite-'))
mkdirSync(out, { recursive: true })
const result = { sha: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim() }
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
  for (const surface of surfaces) {
    for (const before of [true, false]) {
      const name = `${surface}-${before ? 'before' : 'after'}`
      const prefix = surface === 'page' ? 'page-' : ''
      process.env.ISSUE_LOADING_BEFORE = before ? '1' : '0'
      const errors = []
      result[name] = { errors }
      const server = await createServer({
        configFile: resolve(webRoot, 'vite.issue-loading-harness.config.ts'),
        cacheDir: resolve(cache, name),
      })
      let context
      let page
      try {
        await server.listen()
        const origin = `http://127.0.0.1:${server.httpServer.address().port}`
        context = await browser.newContext({
          viewport: { width: surface === 'page' ? 1100 : 620, height: 740 },
          serviceWorkers: 'block',
        })
        await context.route('**/*', (route) => {
          if (new URL(route.request().url()).origin === origin) return route.continue()
          errors.push(`Unexpected request: ${route.request().url()}`)
          return route.abort()
        })
        page = await context.newPage()
        page.on('pageerror', (error) => errors.push(error.message))
        page.setDefaultTimeout(30_000)
        await page.goto(
          `${origin}/harness/issue-loading.html${surface === 'page' ? '?page' : ''}`,
          { waitUntil: 'domcontentloaded' },
        )
        // The device bootstrap yields with zero-delay timers. Let it finish
        // before pausing the UI clock, then mount at a known instant.
        await page.waitForFunction(() => Boolean(window.issueLoading))
        await page.clock.install()
        await page.clock.pauseAt(new Date())
        await page.evaluate(() => window.issueLoading.mount())
        await page.getByTestId(surface === 'page' ? 'issue-page' : 'dock-comments').waitFor()
        await page.evaluate(() => document.fonts.ready)
        const panel = page.getByTestId('issue-loading-harness')
        if (before) {
          await expect(panel.getByText('Loading…', { exact: true })).toHaveCount(
            surface === 'page' ? 4 : 3,
          )
          await panel.screenshot({
            path: resolve(out, `${prefix}before.png`),
            animations: 'disabled',
          })
        } else {
          await page.clock.runFor(299)
          await expect(panel.getByText('Loading…', { exact: true })).toHaveCount(0)
          await panel.screenshot({
            path: resolve(out, `${prefix}after-quiet.png`),
            animations: 'disabled',
          })
          await page.clock.runFor(1)
          await expect(panel.getByText('Loading…', { exact: true })).toHaveCount(1)
          await panel.screenshot({
            path: resolve(out, `${prefix}after.png`),
            animations: 'disabled',
          })
        }
        await page.clock.resume()
        await page.evaluate(() => window.issueLoading.settle())
        await expect(
          panel.getByText('Keep the issue page quiet while its details arrive.', { exact: true }),
        ).toBeVisible()
        await expect(panel.getByText('Loading…', { exact: true })).toHaveCount(0)
        if (!before) {
          await expect(page.getByTestId('issue-loading-block')).toHaveAttribute(
            'aria-busy',
            'false',
          )
          const animation = await page.getByTestId('issue-section-content').evaluate((node) => ({
            name: getComputedStyle(node).animationName,
            duration: getComputedStyle(node).animationDuration,
          }))
          assert.deepEqual(animation, { name: 'issue-sections-enter', duration: '0.16s' })
          await page.clock.runFor(200)
          await panel.screenshot({
            path: resolve(out, `${prefix}after-ready.png`),
            animations: 'disabled',
          })
          await page.emulateMedia({ reducedMotion: 'reduce' })
          assert.equal(
            await page
              .getByTestId('issue-section-content')
              .evaluate((node) => getComputedStyle(node).animationName),
            'none',
          )
        }
        result[name] = {
          requested: await page.evaluate(() => [...window.issueLoading.requested()].sort()),
          errors,
        }
        assert.deepEqual(errors, [], `${name}: browser errors`)
      } catch (error) {
        result[name].failure = String(error.stack ?? error)
        await page
          ?.screenshot({ path: resolve(out, `${name}-failed.png`), timeout: 5000 })
          .catch(() => {})
        throw new Error(`${name}: ${error}\n${errors.join('\n')}`, { cause: error })
      } finally {
        await context?.close()
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
    assert.deepEqual(
      result[`${surface}-after`].requested,
      result[`${surface}-before`].requested,
      'grouping changes no held reads',
    )
  }
  result.status = 'passed'
} finally {
  writeFileSync(resolve(out, 'result.json'), `${JSON.stringify(result, null, 2)}\n`)
  await browser.close()
  rmSync(cache, { recursive: true, force: true })
  delete process.env.ISSUE_LOADING_BEFORE
}
if (shutdownTimedOut) process.exit(1)
console.log(`Issue loading layout proof passed; captures at ${out}`)
