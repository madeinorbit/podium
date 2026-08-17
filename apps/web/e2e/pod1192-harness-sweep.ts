/**
 * SWEEP THE REAL SHELF COMPONENT (POD-1192).
 *
 * Drives harness/shelf-entry.tsx, which renders the SHIPPING `PinnedBrief`
 * against the SHIPPING stylesheet, beside a LEGACY shelf reproducing the
 * measurement POD-993 replaced.
 *
 * The legacy shelf is the positive control and it is checked first. The
 * historical flicker was transition-driven — `clientHeight` sampled while a
 * height animation was mid-flight — so the sweep also TOGGLES the shelf open
 * and shut, because a control that never moves cannot prove the instrument
 * sees a moving one. If legacy does not oscillate, this harness is blind and
 * nothing it says about the real shelf counts.
 *
 *   bunx vite --config vite.harness.config.ts --port 55599   # in apps/web
 *   bunx tsx apps/web/e2e/pod1192-harness-sweep.ts
 */
import { chromium, webkit } from 'playwright'

const URL_ = 'http://localhost:55599/shelf-harness.html'
const W = 'transcript '

function bodies(n: number): { name: string; html: string }[] {
  const half = W.repeat(Math.max(1, Math.floor(n / 2)))
  return [
    { name: `p1(${n})`, html: `<p>${W.repeat(n)}${'x'.repeat(n % 5)}</p>` },
    { name: `p2(${n})`, html: `<p>${half}</p><p>${half}</p>` },
  ]
}

async function run(name: string, launch: typeof chromium, compact: boolean): Promise<void> {
  const browser = await launch.launch()
  const page = await browser.newPage({ viewport: { width: 1100, height: 800 } })
  const errs: string[] = []
  page.on('pageerror', (e) => errs.push(e.message))
  await page.goto(URL_, { waitUntil: 'networkidle' })
  await page.waitForFunction('window.shelf !== undefined', undefined, { timeout: 20000 })
  await page.evaluate(`window.shelf.setDensity(${JSON.stringify(compact ? 'compact' : 'default')})`)
  await page.waitForTimeout(500)

  const real: string[] = []
  const legacy: string[] = []
  let checked = 0
  for (let n = 3; n <= 14; n++) {
    for (const body of bodies(n)) {
      for (const width of [560, 680]) {
        for (const doToggle of [false, true]) {
          checked++
          await page.evaluate(
            `window.shelf.setWidth(${width}); window.shelf.setBrief(${JSON.stringify(body.html)})`,
          )
          await page.waitForTimeout(120)
          await page.evaluate('window.shelf.reset()')
          if (doToggle) {
            // Open and shut, so any measurement sampled mid-transition shows up.
            await page.evaluate('window.shelf.toggle()')
            await page.waitForTimeout(420)
            await page.evaluate('window.shelf.toggle()')
          }
          await page.waitForTimeout(420)
          const r = (await page.evaluate('window.shelf.read()')) as { real: number; legacy: number }
          const tag = `${body.name} w=${width}${doToggle ? ' toggled' : ''}`
          // 1 flip is the answer settling. More than 2 across an open+shut cycle
          // is the answer changing its mind.
          const budget = doToggle ? 2 : 1
          if (r.real > budget) real.push(`${tag} flips=${r.real}`)
          if (r.legacy > budget) legacy.push(`${tag} flips=${r.legacy}`)
        }
      }
    }
  }
  const label = `${name}${compact ? ' compact' : ''}`.padEnd(18)
  console.log(
    `${label} ${checked} combos | CONTROL(legacy) oscillating: ${legacy.length} | shipping shelf oscillating: ${real.length}${errs.length ? ` | pageerrors: ${errs[0]}` : ''}`,
  )
  for (const l of legacy.slice(0, 4)) console.log(`   control: ${l}`)
  for (const l of real.slice(0, 10)) console.log(`   SHIPPING: ${l}`)
  await browser.close()
}

await run('webkit', webkit, false)
await run('chromium', chromium, false)
await run('webkit', webkit, true)
