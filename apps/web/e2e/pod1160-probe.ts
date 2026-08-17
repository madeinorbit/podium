/**
 * SAFARI SCROLL PROBE (POD-1160) — reproduce the two live symptoms with numbers.
 *
 * Drives the LIVE instance (127.0.0.1:18787) in Playwright WebKit (or Chromium
 * for a baseline), instruments the feed scroller, and replays a reader:
 *
 *   explore  — open the workspace, open the target transcript, report geometry
 *              and the tail's state; screenshot. Sanity check for everything else.
 *   hold     — simulate "manually scroll to the bottom": latch release with a
 *              synthetic wheel-up, walk up, walk back down to the true bottom,
 *              then WATCH for 15s. Reports every scroll movement, every DOM
 *              add/remove under the scroller, and whether the view stayed put.
 *   jump     — walk up, then click "Jump to bottom" (in-page dispatchEvent —
 *              Playwright WebKit cannot complete pointer input here) and sample
 *              the gap for 4s. Repeats 5x. Reports landing gap and drift.
 *
 * Every scrollTop WRITE through the element property is logged with a stack
 * fragment, so app writes are attributable; movement seen by scroll events with
 * no matching write is the ENGINE (native anchoring, clamping) or the harness.
 * Harness writes go through __p1160drive so they are tagged apart.
 *
 * USAGE
 *   podium auth mint-session   (cookie cached; pass value via PODIUM_SESSION_COOKIE)
 *   bun run apps/web/e2e/pod1160-probe.ts <explore|hold|jump> [webkit|chromium] [rowText]
 */
import { chromium, webkit } from 'playwright'

const [scenario = 'explore', engineArg = 'webkit', rowText = 'Node usage in Podium'] =
  process.argv.slice(2)
const ORIGIN = 'http://127.0.0.1:18787'
const WT = '/home/podium/podium'
const COOKIE = process.env.PODIUM_SESSION_COOKIE ?? ''
const OUT = `apps/web/e2e/pod1160-${scenario}-${engineArg}`

const INSTRUMENT = `() => {
  const scroller = document.querySelector('[data-feed-scroller]')
  if (!scroller) return false
  const w = window
  if (w.__p1160) return true
  const t0 = performance.now()
  const S = (w.__p1160 = { events: [], writes: 0, driving: false })
  const ev = (o) => {
    if (S.events.length < 30000) S.events.push(Object.assign({ t: Math.round(performance.now() - t0) }, o))
  }
  let p = Object.getPrototypeOf(scroller), d = null
  while (p && !(d = Object.getOwnPropertyDescriptor(p, 'scrollTop'))) p = Object.getPrototypeOf(p)
  const top = () => d.get.call(scroller)
  const gap = () => +(scroller.scrollHeight - top() - scroller.clientHeight).toFixed(2)
  Object.defineProperty(scroller, 'scrollTop', {
    configurable: true,
    get() { return d.get.call(this) },
    set(v) {
      S.writes++
      const stack = (new Error().stack || '').split('\\n').filter(Boolean).slice(1, 3).join('|').slice(0, 160)
      ev({ k: 'write', v: Math.round(v), from: Math.round(top()), drive: S.driving, stack })
      d.set.call(this, v)
    },
  })
  // The harness drives through here so its own writes are tagged.
  w.__p1160drive = (v) => { S.driving = true; scroller.scrollTop = v; S.driving = false }
  w.__p1160geom = () => ({ top: +top().toFixed(2), sh: scroller.scrollHeight, ch: scroller.clientHeight, gap: gap(),
    jumpBtn: [...document.querySelectorAll('button')].some((b) => b.textContent.includes('Jump to bottom')) })
  scroller.addEventListener('scroll', () => ev({ k: 'scroll', top: +top().toFixed(2), sh: scroller.scrollHeight, gap: gap() }), { passive: true })
  const name = (n) => {
    if (!(n instanceof Element)) return n.nodeName
    const c = typeof n.className === 'string' ? n.className : ''
    return (n.tagName + '.' + c.split(' ').slice(0, 2).join('.')).slice(0, 60)
  }
  new MutationObserver((muts) => {
    for (const m of muts) {
      if (m.type === 'attributes') { ev({ k: 'attr', a: m.attributeName, v: m.target.getAttribute(m.attributeName), el: name(m.target), gap: gap() }); continue }
      for (const n of m.addedNodes) ev({ k: 'add', el: name(n), parent: name(m.target), gap: gap(), sh: scroller.scrollHeight })
      for (const n of m.removedNodes) ev({ k: 'rm', el: name(n), parent: name(m.target), gap: gap(), sh: scroller.scrollHeight })
    }
  }).observe(scroller, { subtree: true, childList: true, attributes: true, attributeFilter: ['data-tail', 'data-unroll'] })
  let last = null
  const sample = () => {
    const g = gap()
    if (last === null || Math.abs(g - last) > 0.5) { ev({ k: 'gap', gap: g, sh: scroller.scrollHeight }); last = g }
    requestAnimationFrame(sample)
  }
  requestAnimationFrame(sample)
  return true
}`

// In-page click — Playwright WebKit hangs on locator.click() against this app.
const CLICK_TEXT = `(text) => {
  const nodes = [...document.querySelectorAll('button, [role="button"], a, div, span')]
  const hit = nodes.filter((n) => n.textContent && n.textContent.includes(text) && n.getClientRects().length)
    .sort((a, b) => a.textContent.length - b.textContent.length)[0]
  if (!hit) return null
  for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) {
    hit.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window }))
  }
  return hit.textContent.slice(0, 80)
}`

const engine = engineArg === 'chromium' ? chromium : webkit
const browser = await engine.launch()
const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } })
if (COOKIE) {
  await ctx.addCookies([
    { name: 'podium_session', value: COOKIE, domain: '127.0.0.1', path: '/', httpOnly: false, secure: false },
  ])
}
const page = await ctx.newPage()
page.on('console', (m) => { if (m.type() === 'error') console.log('  [console.error]', m.text().slice(0, 200)) })
await page.goto(`${ORIGIN}/workspace?wt=${encodeURIComponent(WT)}`, { waitUntil: 'domcontentloaded' })
await page.waitForTimeout(3000)

let armed = false
for (let i = 0; i < 25 && !armed; i++) {
  const clicked = await page.evaluate(`(${CLICK_TEXT})(${JSON.stringify(rowText)})`)
  if (i === 0 || clicked) console.log(`row click attempt ${i}: ${clicked ?? 'NOT FOUND'}`)
  await page.waitForTimeout(1500)
  armed = (await page.evaluate(`(${INSTRUMENT})()`)) as boolean
}
if (!armed) {
  console.error('no [data-feed-scroller] — transcript did not open')
  await page.screenshot({ path: `${OUT}-fail.png` })
  await browser.close()
  process.exit(2)
}

const geom = () => page.evaluate('__p1160geom()') as Promise<{ top: number; sh: number; ch: number; gap: number; jumpBtn: boolean }>
// A hibernated session reads its snapshot from disk — the feed is a skeleton
// with no overflow until that lands. Wait for real content.
for (let i = 0; i < 120; i++) {
  const g = await geom()
  if (g.sh > g.ch + 500) break
  await page.waitForTimeout(1000)
}
const drive = (v: number | string) => page.evaluate(`__p1160drive(${v})`)
const wheelUp = () =>
  page.evaluate(`document.querySelector('[data-feed-scroller]').dispatchEvent(new WheelEvent('wheel', { deltaY: -120, bubbles: true, cancelable: true }))`)
const events = () => page.evaluate('window.__p1160.events') as Promise<Record<string, unknown>[]>

console.log('armed. initial geometry:', JSON.stringify(await geom()))

if (scenario === 'input') {
  // Which input paths actually move this nested scroller in this engine?
  const box = await page.evaluate(`(() => { const r = document.querySelector('[data-feed-scroller]').getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 } })()`) as { x: number; y: number }
  const report = async (label: string, before: number) => {
    const g = await geom()
    console.log(`${label}: top ${before} -> ${g.top} (moved ${Math.round(g.top - before)})`)
  }
  let g = await geom()
  await page.mouse.move(box.x, box.y)
  await page.mouse.wheel(0, -300)
  await page.waitForTimeout(800)
  await report('mouse.wheel -300', g.top)

  g = await geom()
  await page.evaluate(`document.querySelector('[data-feed-scroller]').setAttribute('tabindex', '-1'); document.querySelector('[data-feed-scroller]').focus()`)
  await page.keyboard.press('PageUp')
  await page.waitForTimeout(800)
  await report('PageUp (focused scroller)', g.top)

  g = await geom()
  await page.keyboard.press('End')
  await page.waitForTimeout(800)
  await report('End (focused scroller)', g.top)

  g = await geom()
  // scrollBy with smooth behaviour — an engine-animated scroll, closest
  // programmatic cousin of momentum.
  await page.evaluate(`document.querySelector('[data-feed-scroller]').scrollBy({ top: -400, behavior: 'smooth' })`)
  await page.waitForTimeout(1200)
  await report('scrollBy smooth -400', g.top)

  const evs = await events()
  console.log(`\nlast 40 events:`)
  for (const e of evs.slice(-40)) console.log(' ', JSON.stringify(e))
}

if (scenario === 'explore') {
  await page.waitForTimeout(5000)
  console.log('after 5s idle:', JSON.stringify(await geom()))
  const evs = await events()
  console.log(`events during idle: ${evs.length}`)
  for (const e of evs.slice(-60)) console.log(' ', JSON.stringify(e))
  await page.screenshot({ path: `${OUT}.png` })
}

if (scenario === 'hold') {
  // A reader leaves the bottom: intent first (wheel-up latch), then movement.
  await wheelUp()
  for (let i = 0; i < 10; i++) { await drive(`document.querySelector('[data-feed-scroller]').scrollTop - 140`); await page.waitForTimeout(60) }
  console.log('after walk up:  ', JSON.stringify(await geom()))
  await page.waitForTimeout(800)
  // ...and comes back down by hand, landing on the true bottom.
  for (let i = 0; i < 14; i++) { await drive(`document.querySelector('[data-feed-scroller]').scrollTop + 120`); await page.waitForTimeout(60) }
  await drive(`document.querySelector('[data-feed-scroller]').scrollHeight`)
  const landed = await geom()
  console.log('landed at bottom:', JSON.stringify(landed))
  const evCountAtLanding = (await events()).length
  // WATCH. Nothing else touches the page for 15s.
  const timeline: { s: number; gap: number; jumpBtn: boolean }[] = []
  for (let s = 1; s <= 15; s++) {
    await page.waitForTimeout(1000)
    const g = await geom()
    timeline.push({ s, gap: g.gap, jumpBtn: g.jumpBtn })
  }
  console.log('\nhold timeline (gap px by second):')
  console.log(timeline.map((x) => `  ${x.s}s gap=${x.gap} jumpBtn=${x.jumpBtn}`).join('\n'))
  const evs = await events()
  console.log(`\nevents after landing (${evs.length - evCountAtLanding}):`)
  for (const e of evs.slice(evCountAtLanding)) console.log(' ', JSON.stringify(e))
  await page.screenshot({ path: `${OUT}.png` })
}

if (scenario === 'jump') {
  for (let round = 1; round <= 5; round++) {
    await wheelUp()
    for (let i = 0; i < 8; i++) { await drive(`document.querySelector('[data-feed-scroller]').scrollTop - 160`); await page.waitForTimeout(50) }
    await page.waitForTimeout(600)
    const before = await geom()
    const preEvents = (await events()).length
    const hit = await page.evaluate(`(${CLICK_TEXT})('Jump to bottom')`)
    const samples: number[] = []
    for (let i = 0; i < 40; i++) { await page.waitForTimeout(100); samples.push((await geom()).gap) }
    const g = await geom()
    console.log(`\nround ${round}: clicked=${JSON.stringify(hit)} before gap=${before.gap}`)
    console.log(`  gap after click, 100ms steps: ${samples.map((x) => Math.round(x)).join(' ')}`)
    console.log(`  final: ${JSON.stringify(g)}`)
    if (Math.abs(g.gap) > 4) {
      const evs = await events()
      console.log(`  FAILED — events since click:`)
      for (const e of evs.slice(preEvents)) console.log('   ', JSON.stringify(e))
    }
  }
  await page.screenshot({ path: `${OUT}.png` })
}

await browser.close()
