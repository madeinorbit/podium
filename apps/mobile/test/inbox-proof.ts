/** Flatblock only. Timing uses bench:flatblock; all data is synthetic. Owns
 * only its Vite PID and Chromium. Runs one fresh pool-only profile. */

import { spawn } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { hostname } from 'node:os'
import { dirname, join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { chromium } from '@playwright/test'
import type {} from './inbox.browser'

if (hostname() !== 'flatblock') throw new Error('Browser validation belongs on flatblock')
const countsOnly = process.argv.includes('--counts-only'),
  complete = process.argv.includes('--complete'),
  output = '.artifacts/mobile-inbox',
  origin = 'http://127.0.0.1:45172'
await mkdir(output, { recursive: true })
const webRequire = createRequire(new URL('../../web/package.json', import.meta.url))
const viteBin = join(dirname(webRequire.resolve('vite/package.json')), 'bin/vite.js')
const server = spawn(process.execPath, [viteBin, '--config', 'apps/mobile/vite.inbox.config.ts'], {
  stdio: ['ignore', 'ignore', 'inherit'],
  env: { ...process.env, PODIUM_INBOX_COMPLETE: complete ? '1' : '0' },
})
const exited = new Promise<void>((resolve, reject) => {
  server.once('exit', () => resolve())
  server.once('error', reject)
})
console.log(`Isolated mobile Vite PID ${server.pid}`)
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined
try {
  const deadline = Date.now() + 60000
  while (true) {
    try {
      if (
        (await fetch(`${origin}/test/inbox.browser.html`, { signal: AbortSignal.timeout(2000) })).ok
      )
        break
    } catch {}
    if (Date.now() > deadline || server.exitCode !== null)
      throw new Error('Mobile fixture did not start')
    await sleep(200)
  }
  browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] })
  console.log(JSON.stringify({ browser: browser.version(), bun: process.versions.bun }))
  const results: Record<string, unknown> = {}
  for (const [arm, mode] of ['pool'].entries()) {
    const page = await browser.newPage({ viewport: { width: 430, height: 1050 } }),
      errors: string[] = []
    let failReady: (error: Error) => void = () => {}
    const startupFailure = new Promise<never>((_resolve, reject) => {
      failReady = reject
    })
    page.on('pageerror', (error) => {
      errors.push(error.message)
      console.error(error.message)
      failReady(error)
    })
    await page.context().route('http://offline.invalid/**', (route) =>
      route.fulfill({
        contentType: 'text/html',
        body: '<p>Synthetic OS fallback destination</p>',
      }),
    )
    await page.goto(`${origin}/test/inbox.browser.html?complete=${complete ? 1 : 0}`)
    try {
      await Promise.race([
        page.waitForFunction(() => window.__inbox?.ready(), null, { timeout: 20000 }),
        startupFailure,
      ])
    } catch (error) {
      console.error(
        JSON.stringify(
          await page.evaluate(() => ({
            readiness: window.__inbox?.readiness(),
            stats: window.__inbox?.stats(),
            text: document.body.textContent?.slice(-1800),
          })),
        ),
      )
      throw error
    }
    failReady = () => {}
    if (
      complete &&
      (await page.getByRole('button', { name: 'New work', exact: true }).count()) !== 1
    )
      throw new Error('Complete Inbox did not mount the real launch button')
    await page.evaluate(
      () =>
        new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        ),
    )
    const mounted = await page.evaluate(() => window.__inbox.stats())
    if (mounted.selectors || mounted.rowBuilds || Object.values(mounted.slices).some(Boolean))
      throw new Error(`Legacy work at enabled mount: ${JSON.stringify(mounted)}`)
    results[`${arm}.${mode}.mount`] = mounted
    const cdp = await page.context().newCDPSession(page)
    if (!countsOnly) await cdp.send('Performance.enable')
    const metrics = async () =>
      Object.fromEntries(
        (await cdp.send('Performance.getMetrics')).metrics.map((entry) => [
          entry.name,
          entry.value,
        ]),
      )
    for (const phase of ['activity', 'updates'] as const) {
      await page.evaluate(() => window.__inbox.reset())
      const initial = countsOnly ? {} : await metrics()
      const wallStart = performance.now()
      if (phase === 'activity') await page.evaluate(() => window.__inbox.activity(30))
      else await page.evaluate(() => window.__inbox.updates(20))
      const wallMs = performance.now() - wallStart,
        final = countsOnly ? {} : await metrics(),
        stats = await page.evaluate(() => window.__inbox.stats())
      results[`${arm}.${mode}.${phase}`] = {
        ...stats,
        ...(!countsOnly
          ? { wallMs, taskMs: ((final.TaskDuration ?? 0) - (initial.TaskDuration ?? 0)) * 1000 }
          : {}),
      }
      if (stats.selectors || stats.rowBuilds || Object.values(stats.slices).some(Boolean))
        throw new Error(`Legacy enabled work: ${JSON.stringify(stats)}`)
      if (stats.failures) throw new Error('Synthetic runtime failed')
    }
    const { default: assert } = await import('node:assert/strict')
    await page.waitForFunction(
      () => window.__inbox.outputs()?.routes.every((route) => typeof route !== 'symbol'),
      null,
      { timeout: 30000 },
    )
    const outputs = await page.evaluate(() => window.__inbox.outputs())
    assert.deepEqual(outputs, {
      routes: ['/issue/synthetic-0', '/issue/synthetic-18', null, '/session/synthetic-session-0'],
      queue: ['synthetic-2', 'synthetic-0', 'synthetic-1'],
    })
    results[`${arm}.${mode}.outputs`] = outputs
    await page.evaluate(() => window.__inbox.reset())
    await page.getByTestId('ref-SYN-1018').click()
    await page.waitForFunction(() => window.__inbox.stats().routes.includes('/issue/synthetic-18'))
    await page.getByTestId('ref-SYN-1000-A').click()
    await page.waitForFunction(() =>
      window.__inbox.stats().routes.includes('/session/synthetic-session-0'),
    )
    // Observe the actual RN Web new-tab boundary once for a cold missing ref.
    const popupPromise = page.waitForEvent('popup')
    await page.getByTestId('ref-SYN-9999').click()
    const popup = await popupPromise
    await popup.waitForURL('http://offline.invalid/issues/SYN-9999')
    await popup.close()
    if (arm === 0) {
      await page.screenshot({ path: `${output}/${complete ? 'complete-' : ''}inbox.png` })
      await page.getByRole('button', { name: 'Proposals', exact: true }).click()
      await page.screenshot({ path: `${output}/${complete ? 'complete-' : ''}proposals.png` })
      await page.getByRole('button', { name: 'Skip', exact: true }).click()
      await page.waitForFunction(() =>
        document
          .querySelector('[data-testid="screening-card"]')
          ?.textContent?.includes('Summary 0'),
      )
    }
    const acted = await page.evaluate(() => window.__inbox.stats())
    if (acted.selectors || acted.rowBuilds || Object.values(acted.slices).some(Boolean))
      throw new Error(`Legacy work while following references: ${JSON.stringify(acted)}`)
    results[`${arm}.${mode}.actions`] = acted
    if (errors.length) throw new Error(`Browser errors: ${errors.join('; ')}`)
    await page.evaluate(() => window.__inbox.close())
    await page.close()
  }
  await writeFile(
    `${output}/${complete ? 'complete-' : ''}${countsOnly ? 'counts' : 'results'}.json`,
    JSON.stringify(results, null, 2),
  )
  console.log(JSON.stringify(results))
} finally {
  await browser?.close()
  server.kill()
  await exited
}
