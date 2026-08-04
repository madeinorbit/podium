// Does the post-paint block recur, or is it a once-per-browser priming cost
// (IndexedDB / cache)? Same context, two navigations. If load 2 is fast, it primes.
import { firefox } from 'playwright'

const b = await firefox.launch()
const ctx = await b.newContext({ viewport: { width: 1600, height: 1000 } })
await ctx.addCookies([
  { name: 'podium_session', value: process.env.T, domain: '127.0.0.1', path: '/' },
])
const p = await ctx.newPage()

async function run(label) {
  const t0 = Date.now()
  await p.goto('http://127.0.0.1:18787/', { waitUntil: 'domcontentloaded', timeout: 60000 })
  let painted = 0
  let blocked = 0
  for (let i = 0; i < 200; i++) {
    const s0 = Date.now()
    let c = 0
    try {
      c = await p.evaluate(() => (document.body ? document.body.innerText.length : 0))
    } catch {
      console.log(`${label}: page died`)
      return
    }
    const probe = Date.now() - s0
    if (probe > 400) blocked += probe
    if (!painted && c > 20000) painted = Date.now() - t0
    if (painted && Date.now() - t0 > painted + 100000) break
    await p.waitForTimeout(500)
  }
  console.log(`${label}: paint=${painted}ms blockedAfter=${blocked}ms`)
}

await run('LOAD-1 (cold: empty IndexedDB + cache)')
await run('LOAD-2 (warm: same context, primed)')
await run('LOAD-3 (warm again)')
await b.close().catch(() => {})
