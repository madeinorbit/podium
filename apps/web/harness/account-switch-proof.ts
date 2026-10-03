/** Focused Chromium proof over the ordinary synthetic full-screen fixture.
 * Run on flatblock: bun apps/web/harness/account-switch-proof.ts
 * --plant-stale-handler retains the first real close-tab closure and must fail. */
import { execFileSync } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { hostname } from 'node:os'
import { extname, resolve } from 'node:path'
import { chromium, type Page } from '@playwright/test'
import { build } from 'vite'
import config from './sidebar-acceptance.vite'
import type {} from '../test/sidebar-acceptance.browser'

const args = process.argv.slice(2)
const planted = args.includes('--plant-stale-handler')
const sharedScopePlant = args.includes('--plant-shared-scope-callback')
const unkeyedPlant = args.includes('--plant-unkeyed-account')
const pilotArg = args.find(arg => arg.startsWith('--pilot='))?.slice(8)
if (pilotArg !== undefined && !['0', '1'].includes(pilotArg)) throw new Error('Invalid pilot arm')
const pilots = pilotArg === undefined ? [0, 1] : [Number(pilotArg)]
const out = resolve(args.find(arg => arg.startsWith('--out='))?.slice(6) ?? '.artifacts/account-switch')
const buildDir = resolve(out, 'build')
const sourceSha = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
const switches = ['mobxSidebar', 'mobxPane', 'mobxSessionPane', 'mobxChatContext', 'mobxHeader',
  'mobxChips', 'mobxCommands', 'mobxNotices', 'mobxShell', 'mobxPreferences', 'mobxSettings',
  'mobxWorkflows', 'mobxBoard', 'mobxSuperagent', 'mobxAutomations', 'mobxSpecs']
type Lifetime = { principal: string; retired: { name: string; present: boolean; destroyed?: boolean }[] }
declare global {
  interface Window { __accountLifetime(): Lifetime; __PODIUM_CLOSE_TAB__?: () => boolean }
}
if (hostname() !== 'flatblock') throw new Error('Account-switch proof runs on flatblock')
await mkdir(out, { recursive: true })
await build({
  ...config, configFile: false, logLevel: 'warn',
  plugins: [...(config.plugins ?? []).filter((plugin: any) => plugin?.name !== 'acceptance-state-boundaries'), {
    name: 'account-lifetime-probe', enforce: 'pre',
    transform(code: string, id: string) {
      if (unkeyedPlant && id.endsWith('/react/provider.tsx')) {
        const key = 'key={runtimeGeneration.current}'
        if (!code.includes(key)) throw new Error('Unkeyed account plant was not armed')
        return { code: code.replace(key, ''), map: null }
      }
      if (sharedScopePlant && id.endsWith('/app/Workspace.tsx')) {
        const close = '  const closeTab = (tabId: string): void => {'
        if (!code.includes(close)) throw new Error('Shared-scope callback plant was not armed')
        return { code: "import { useCallback as retainAccountCallback } from 'react';\n" +
          code.replace(close, '  retainAccountCallback(() => closeFileTab, [])\n' + close), map: null }
      }
      if (!id.endsWith('/test/sidebar-acceptance.browser.tsx')) return
      // Observe identities through the fixture's existing WeakRefs. This probe
      // returns only scalars and never holds a runtime in a browser handle.
      return { code: code + `\nObject.assign(window, { __accountLifetime: () => ({
        principal: owner?.principal.userId,
        retired: retired.map(({ name, ref }) => {
          const value = ref.deref();
          return { name, present: value !== undefined, destroyed: value?.destroyed };
        }),
      }) });\n`, map: null }
    },
  }],
  build: { ...config.build, outDir: buildDir, minify: 'esbuild', sourcemap: 'hidden' },
})
const server = createServer(async (request, response) => {
  try {
    const path = resolve(buildDir, '.' + new URL(request.url!, 'http://localhost').pathname)
    if (!path.startsWith(buildDir + '/')) { response.writeHead(403); response.end(); return }
    const bytes = await readFile(path)
    response.setHeader('Content-Type', ({ '.html': 'text/html', '.js': 'text/javascript',
      '.css': 'text/css', '.woff2': 'font/woff2' } as Record<string, string>)[extname(path)] ?? 'application/octet-stream')
    response.end(bytes)
  } catch { response.writeHead(404); response.end() }
})
await new Promise<void>(done => server.listen(0, '127.0.0.1', done))
const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`
const browser = await chromium.launch({ headless: true,
  executablePath: process.env.PODIUM_CHROMIUM_PATH,
  args: ['--no-sandbox', '--disable-dev-shm-usage', '--js-flags=--expose-gc'],
})
async function settle(page: Page): Promise<void> {
  await page.evaluate(() => window.__acceptance.settled())
  await page.evaluate(() => new Promise<void>(done => requestAnimationFrame(() => requestAnimationFrame(() => done()))))
}
const records: unknown[] = [], failures: string[] = []
try {
  for (const pilot of pilots) {
    const context = await browser.newContext({ viewport: { width: 1800, height: 1000 }, reducedMotion: 'reduce' })
    try {
      const page = await context.newPage(), errors: string[] = []
      page.on('pageerror', error => errors.push(error.message))
      await page.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort())
      const params = new URLSearchParams({ scale: '1', surface: 'full', panelMode: 'chat' })
      for (const key of switches) params.set(key, String(pilot))
      await page.goto(`${origin}/test/sidebar-acceptance.browser.html?${params}`)
      await page.waitForFunction(() => window.__acceptance?.ready() && !!window.__PODIUM_CLOSE_TAB__)
      await settle(page)
      const startup = await page.evaluate(() => ({ ...window.__acceptance.state(), mode: window.__acceptance.mode() }))
      if (startup.issues !== 4867 || startup.sessions !== 4302 || startup.mode !== (pilot ? 'pool' : 'legacy'))
        throw new Error('Startup/corpus guard failed')
      for (const key of switches) if (startup.switches[key] !== String(pilot)) throw new Error(`Missing startup switch ${key}`)
      const cdp = await context.newCDPSession(page)
      if (planted) await page.evaluate(() => {
        // Keep the actual installed handler, rather than planting a name in the
        // report. Its captured account must make the survivor guard go red.
        Object.assign(window, { __plantedStaleCloseTab: window.__PODIUM_CLOSE_TAB__ })
      })
      for (const principal of ['acceptance-bob', 'acceptance-alice']) {
        await page.evaluate(name => window.__acceptance.show(name), principal)
        await page.waitForFunction(() => window.__acceptance.ready())
        await settle(page)
        const beforeGc = await page.evaluate(() => window.__accountLifetime())
        if (beforeGc.principal !== principal) throw new Error('Actual principal did not change')
        if (beforeGc.retired.some(row => row.name.endsWith('.runtime') && row.present && !row.destroyed))
          throw new Error('Retired runtime was not destroyed')
        for (let round = 0; round < 5; round++) {
          await cdp.send('HeapProfiler.collectGarbage')
          await page.waitForTimeout(100)
          await settle(page)
        }
        const lifetime = await page.evaluate(() => window.__accountLifetime())
        const survivors = await page.evaluate(() => window.__acceptance.survivors())
        const state = await page.evaluate(() => window.__acceptance.state())
        records.push({ pilot, principal, beforeGc, lifetime, survivors, state })
        console.log(JSON.stringify({ pilot, principal, survivors }))
        if (survivors.length) failures.push(`pilot=${pilot} ${principal}: ${survivors.join(', ')}`)
      }
      if (errors.length || (await page.evaluate(() => window.__acceptance.errors())).length)
        throw new Error(`Browser errors: ${errors.join('; ')}`)
    } finally { await context.close() }
  }
  await writeFile(resolve(out, 'report.json'), JSON.stringify({ sourceSha, browser: browser.version(),
    host: hostname(), seed: 4443, issues: 4867, sessions: 4302, switches, planted, sharedScopePlant, unkeyedPlant, records, failures }, null, 2) + '\n')
  if (failures.length) throw new Error(`Account survivors guard failed:\n${failures.join('\n')}`)
  console.log(`Account-switch proof passed: zero retired survivors in startup arms ${pilots.join(', ')}`)
} finally {
  await browser.close()
  await new Promise<void>(done => server.close(() => done()))
}
