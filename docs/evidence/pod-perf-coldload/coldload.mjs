// Cold-load profile of the live instance in a FRESH context (incognito-equivalent:
// no IndexedDB, no localStorage, no HTTP cache), capturing EVERY network call with
// timing plus main-thread CPU. Answers: which calls are slow, and what burns CPU
// before anything paints.
import { firefox } from 'playwright'
import { writeFileSync } from 'node:fs'

const OUT = process.env.OUT ?? '/tmp/coldload'
const b = await firefox.launch()
// A brand-new context is a brand-new profile: empty IndexedDB and empty cache.
const ctx = await b.newContext({ viewport: { width: 1600, height: 1000 } })
await ctx.addCookies([
  { name: 'podium_session', value: process.env.T, domain: '127.0.0.1', path: '/' },
])
const p = await ctx.newPage()

const calls = []
const t0 = Date.now()
p.on('request', (r) => {
  r._t = Date.now()
})
p.on('response', async (r) => {
  const req = r.request()
  let size = 0
  try {
    size = (await r.body()).length
  } catch {}
  calls.push({
    at: (req._t ?? Date.now()) - t0,
    ms: Date.now() - (req._t ?? Date.now()),
    status: r.status(),
    size,
    url: r.url().replace('http://127.0.0.1:18787', ''),
  })
})
const errs = []
p.on('console', (m) => {
  if (m.type() === 'error') errs.push(m.text().slice(0, 160))
})

await p.goto('http://127.0.0.1:18787/', { waitUntil: 'domcontentloaded', timeout: 60000 })

// Sample paint progress + main-thread responsiveness every 500ms.
const samples = []
let painted = 0
for (let i = 0; i < 240; i++) {
  const s0 = Date.now()
  let m
  try {
    m = await p.evaluate(() => ({
      c: document.body ? document.body.innerText.length : 0,
      h: performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1048576) : -1,
    }))
  } catch {
    break
  }
  // How long a trivial evaluate took = how blocked the main thread is.
  samples.push({ t: Date.now() - t0, chars: m.c, heapMB: m.h, probeMs: Date.now() - s0 })
  if (!painted && m.c > 20000) {
    painted = Date.now() - t0
    console.log(`PAINTED_AT_MS=${painted}`)
  }
  if (painted && Date.now() - t0 > painted + 15000) break
  await p.waitForTimeout(500)
}

writeFileSync(`${OUT}-calls.json`, JSON.stringify(calls, null, 1))
writeFileSync(`${OUT}-samples.json`, JSON.stringify(samples, null, 1))

console.log(`TOTAL_CALLS=${calls.length}`)
console.log(`PAINTED_AT_MS=${painted || -1}`)
console.log(`CONSOLE_ERRORS=${errs.length}`)
console.log('\n--- SLOWEST CALLS (ms) ---')
for (const c of [...calls].sort((a, b) => b.ms - a.ms).slice(0, 20))
  console.log(`${String(c.ms).padStart(6)}ms  at+${String(c.at).padStart(6)}ms  ${String(c.size).padStart(8)}B  ${c.status}  ${c.url.slice(0, 90)}`)
console.log('\n--- BIGGEST CALLS (bytes) ---')
for (const c of [...calls].sort((a, b) => b.size - a.size).slice(0, 10))
  console.log(`${String(c.size).padStart(9)}B  ${String(c.ms).padStart(6)}ms  ${c.url.slice(0, 90)}`)
console.log('\n--- MAIN-THREAD BLOCKED (probe > 400ms) ---')
for (const s of samples.filter((s) => s.probeMs > 400))
  console.log(`t=${String(s.t).padStart(6)}ms probe=${String(s.probeMs).padStart(6)}ms chars=${s.chars} heap=${s.heapMB}MB`)
const blocked = samples.filter((s) => s.probeMs > 400).reduce((a, s) => a + s.probeMs, 0)
console.log(`\nTOTAL_BLOCKED_MS=${blocked}`)
await b.close().catch(() => {})
