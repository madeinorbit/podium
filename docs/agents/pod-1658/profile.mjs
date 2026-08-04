/**
 * POD-1658 — capture a V8 CPU profile of the BUILT web app over CDP.
 *
 * Thin descendant of docs/agents/pod-1641/cdp.mjs: same reason for existing
 * (Chromium's Profiler samples from the browser process, so a wedged main thread
 * still yields a profile, which Firefox's Gecko profiler cannot do), parameterised
 * for whichever instance you point it at. The profile it writes is MANGLED — run
 * docs/agents/pod-1658/resolve-profile.mjs over it with the dist to get real names.
 *
 * Usage:
 *   PODIUM_COOKIE=<podium_session value, if the instance has a password> \
 *   node docs/agents/pod-1658/profile.mjs <url> <seconds> <out.cpuprofile>
 *
 * PODIUM_WALK=/issues,/usage,/specs cycles those routes for the whole window
 * (client-side navigation via history.pushState, so it exercises the app's render
 * and viewmodel paths rather than reloading the bundle). Leave it unset to profile
 * a plain load — which is what you want when reproducing a load-time freeze.
 */
import fs from 'node:fs'
import { chromium } from 'playwright'

const url = process.argv[2] || 'http://127.0.0.1:18787/'
const secs = Number(process.argv[3] || 60)
const out = process.argv[4] || 'profile.cpuprofile'

const browser = await chromium.launch({
  headless: true,
  args: ['--no-sandbox', '--js-flags=--max-old-space-size=4096'],
})
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } })
if (process.env.PODIUM_COOKIE) {
  await ctx.addCookies([
    {
      name: 'podium_session',
      value: process.env.PODIUM_COOKIE,
      domain: new URL(url).hostname,
      path: '/',
    },
  ])
}
const page = await ctx.newPage()
page.on('crash', () => console.log('PAGE CRASH'))
page.on('console', (m) => {
  if (m.type() === 'error') console.log('CERR', m.text().slice(0, 150))
})

const cdp = await ctx.newCDPSession(page)
await cdp.send('Profiler.enable')
await cdp.send('Profiler.setSamplingInterval', { interval: 1000 })
await cdp.send('Profiler.start')
console.log('profiler started; loading', url)
// Never `await` a blocking page.evaluate against a frozen page — that is what made
// headless chromium look like it "dies" in POD-1641. Fire the navigation and wait
// on the clock instead.
page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch((e) => {
  console.log('goto', e.message.slice(0, 80))
})
const walk = (process.env.PODIUM_WALK || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean)
const deadline = Date.now() + secs * 1000
if (walk.length) {
  // Give the shell a moment to mount before steering it.
  await new Promise((r) => setTimeout(r, 5000))
  for (let i = 0; Date.now() < deadline; i++) {
    const to = walk[i % walk.length]
    // pushState + popstate is how the app's own router is driven; a page.goto here
    // would reload the bundle and profile module init over and over instead.
    await page
      .evaluate((path) => {
        window.history.pushState({}, '', path)
        window.dispatchEvent(new PopStateEvent('popstate'))
      }, to)
      .catch(() => {})
    // Stir the shell as well as the router: the command palette mounts a list over
    // the whole issue corpus and re-filters on every keystroke, which is the kind of
    // render work a route change alone does not provoke.
    await page.keyboard.press('Escape').catch(() => {})
    await page.keyboard.press('Control+k').catch(() => {})
    await page.keyboard.type('se', { delay: 40 }).catch(() => {})
    await page.keyboard.press('Escape').catch(() => {})
    await new Promise((r) => setTimeout(r, 500))
  }
} else {
  await new Promise((r) => setTimeout(r, secs * 1000))
}

const { profile } = await cdp.send('Profiler.stop')
fs.writeFileSync(out, JSON.stringify(profile))
console.log('wrote', out, '- samples', profile.samples.length, 'nodes', profile.nodes.length)
await browser.close().catch(() => {})
