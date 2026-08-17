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
      const stack = (new Error().stack || '').split('\\n').filter(Boolean).slice(1, 6).join('|').slice(0, 300)
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
  let last = null, lastSh = null
  const sample = () => {
    const g = gap(), sh = scroller.scrollHeight
    if (last === null || Math.abs(g - last) > 0.5 || sh !== lastSh) { ev({ k: 'gap', gap: g, sh, top: +top().toFixed(1) }); last = g; lastSh = sh }
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
// From-load CSS (P1160_CSS env): installed at document-start, so it is present
// at the scroller's FIRST layout — the moment the POD-993 registration landmine
// fires. A runtime toggle cannot prove that path; this can.
const injectCss = process.env.P1160_CSS ?? ''
if (injectCss) {
  await page.addInitScript(`
    const s = document.createElement('style')
    s.id = 'p1160initcss'
    s.textContent = ${JSON.stringify(injectCss)}
    document.addEventListener('DOMContentLoaded', () => document.head.appendChild(s))
    if (document.head) document.head.appendChild(s)
  `)
  console.log(`from-load css: ${injectCss}`)
}
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

if (scenario === 'why') {
  // Which scroll APIs move the feed, vs a minimal fixture injected into the
  // SAME page? Isolates "engine build can't do X" from "this element can't".
  const tryScroll = async (target: 'feed' | 'fixture', code: string) => {
    const sel = target === 'feed'
      ? `document.querySelector('[data-feed-scroller]')`
      : `document.getElementById('p1160fix')`
    const before = (await page.evaluate(`${sel}.scrollTop`)) as number
    await page.evaluate(`(() => { const el = ${sel}; ${code} })()`)
    await page.waitForTimeout(900)
    const after = (await page.evaluate(`${sel}.scrollTop`)) as number
    console.log(`  ${target.padEnd(7)} ${code.padEnd(58)} ${before} -> ${after} (moved ${Math.round(after - before)})`)
    return after - before
  }
  await page.evaluate(`(() => {
    const fix = document.createElement('div')
    fix.id = 'p1160fix'
    fix.style.cssText = 'position:fixed;left:0;top:0;width:200px;height:200px;overflow-y:auto;z-index:9999;background:#222'
    fix.innerHTML = '<div style="height:3000px"></div>'
    document.body.appendChild(fix)
    fix.scrollTop = 1500
  })()`)
  for (const target of ['fixture', 'feed'] as const) {
    await tryScroll(target, `el.scrollTop = el.scrollTop - 200`)
    await tryScroll(target, `el.scrollBy(0, -200)`)
    await tryScroll(target, `el.scrollBy({ top: -200, behavior: 'instant' })`)
    await tryScroll(target, `el.scrollBy({ top: -200, behavior: 'smooth' })`)
    await tryScroll(target, `el.scrollTo({ top: el.scrollTop - 200, behavior: 'smooth' })`)
  }
  // Wheel via Playwright, on each.
  for (const target of ['fixture', 'feed'] as const) {
    const sel = target === 'feed' ? `[data-feed-scroller]` : `#p1160fix`
    const box = (await page.evaluate(`(() => { const r = document.querySelector('${sel}').getBoundingClientRect(); return { x: r.x + r.width / 2, y: Math.max(r.y + 40, r.y + r.height / 2) } })()`)) as { x: number; y: number }
    const before = (await page.evaluate(`document.querySelector('${sel}').scrollTop`)) as number
    await page.mouse.move(box.x, box.y)
    await page.mouse.wheel(0, -200)
    await page.waitForTimeout(900)
    const after = (await page.evaluate(`document.querySelector('${sel}').scrollTop`)) as number
    console.log(`  ${target.padEnd(7)} mouse.wheel(0,-200)${' '.repeat(40)} ${before} -> ${after} (moved ${Math.round(after - before)})`)
  }
  // Ancestor chain styles that can break scroll pathways.
  const styles = (await page.evaluate(`(() => {
    const out = []
    let el = document.querySelector('[data-feed-scroller]')
    while (el && el !== document.documentElement) {
      const cs = getComputedStyle(el)
      const pick = {}
      for (const p of ['overflow-x','overflow-y','transform','will-change','contain','content-visibility','overscroll-behavior','scroll-behavior','scroll-snap-type','position','display','height']) {
        const v = cs.getPropertyValue(p)
        if (v && v !== 'none' && v !== 'visible' && v !== 'static' && v !== 'auto none' && v !== 'normal') pick[p] = v
      }
      out.push({ el: (el.tagName + '.' + String(el.className).split(' ').slice(0,3).join('.')).slice(0, 80), ...pick })
      el = el.parentElement
    }
    return out
  })()`)) as Record<string, string>[]
  console.log('\nancestor styles:')
  for (const s of styles) console.log(' ', JSON.stringify(s))
}

if (scenario === 'fix') {
  // Latch the release first (wheel-up) so NO app writer runs, then measure how
  // an instant -200 write behaves: apply latency, applied fraction, and
  // whether the engine reverts it. Repeated 5x per config. Then: does
  // Playwright's real wheel input move the scroller under this config?
  const STYLE = `(css) => {
    let s = document.getElementById('p1160style')
    if (!s) { s = document.createElement('style'); s.id = 'p1160style'; document.head.appendChild(s) }
    s.textContent = css
  }`
  const configs: [string, string][] = [
    ['baseline', ''],
    // The POD-993 landmine, on purpose, to re-confirm it is still a landmine.
    ['scroller anchor none', `[data-feed-scroller] { overflow-anchor: none }`],
    // Exclude every child from anchor SELECTION; the scroller stays registered.
    ['children anchor none', `[data-feed-scroller] > * { overflow-anchor: none }`],
    // Exclude only the below-the-last-message UI.
    ['tail anchor none', `.feed-tail, .transcript-daymark { overflow-anchor: none }`],
    ['back to baseline', ``],
  ]
  const feedBox = (await page.evaluate(`(() => { const r = document.querySelector('[data-feed-scroller]').getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 } })()`)) as { x: number; y: number }
  for (const [label, setup] of configs) {
    await page.evaluate(`(${STYLE})(${JSON.stringify(setup)})`)
    await page.waitForTimeout(300)
    console.log(`\n== ${label}`)
    // POD-993 geometry check: is the reported max actually reachable, and does
    // the last element land at the scrollport bottom?
    const geo = (await page.evaluate(`(() => {
      const el = document.querySelector('[data-feed-scroller]')
      window.__p1160drive(1e6)
      const reportedMax = el.scrollHeight - el.clientHeight
      const achieved = el.scrollTop
      const last = el.lastElementChild
      const overhang = last ? +(last.getBoundingClientRect().bottom - el.getBoundingClientRect().bottom).toFixed(1) : null
      return { unreachable: +(reportedMax - achieved).toFixed(1), overhang }
    })()`)) as { unreachable: number; overhang: number | null }
    console.log(`  geometry: unreachable=${geo.unreachable}px overhang=${geo.overhang}px`)
    for (let rep = 1; rep <= 5; rep++) {
      await drive(`document.querySelector('[data-feed-scroller]').scrollHeight`)
      await page.waitForTimeout(700)
      await wheelUp() // latch: app writers stand down
      const trace = (await page.evaluate(`(async () => {
        const el = document.querySelector('[data-feed-scroller]')
        const t0 = performance.now()
        const start = el.scrollTop
        window.__p1160drive(start - 200)
        const out = []
        while (performance.now() - t0 < 2500) {
          await new Promise((r) => requestAnimationFrame(r))
          out.push([Math.round(performance.now() - t0), +(el.scrollTop - start).toFixed(1)])
        }
        return out
      })()`)) as [number, number][]
      const applied = trace.find(([, d]) => d < -1)
      const atEnd = trace[trace.length - 1]
      const min = Math.min(...trace.map(([, d]) => d))
      console.log(
        `  rep ${rep}: applied ${applied ? `${applied[1]}px @ ${applied[0]}ms` : 'NEVER'}; deepest ${min}px; at 2.5s ${atEnd?.[1]}px`,
      )
    }
    // Real wheel input under this config.
    const before = (await geom()).top
    await page.mouse.move(feedBox.x, feedBox.y)
    await page.mouse.wheel(0, -200)
    await page.waitForTimeout(800)
    const after = (await geom()).top
    console.log(`  mouse.wheel(0,-200): moved ${Math.round(after - before)}px`)
  }
}

if (scenario === 'isolate') {
  // Which property makes the engine's own idea of maxScroll fall SHORT of
  // layout's? Metric: silence the app writers (synthetic wheel-up latch), write
  // the true bottom, then watch 5s — the engine pulls up to ITS max; the rest
  // gap is the shortfall. One mutation at a time, restore between.
  const MUTATIONS: [string, string][] = [
    ['baseline', ''],
    ['spacer mt-0', `document.querySelector('[data-feed-scroller] > .mt-auto').style.marginTop = '0'`],
    ['scroller pb-0', `document.querySelector('[data-feed-scroller]').style.paddingBottom = '0'`],
    ['scroller pt-0', `document.querySelector('[data-feed-scroller]').style.paddingTop = '0'`],
    ['region clip none', `document.querySelector('.offer-lift-region').style.clipPath = 'none'`],
    ['region transform none', `document.querySelector('.offer-lift-region').style.transform = 'none'`],
    ['tail hidden', `const t = document.querySelector('.feed-tail'); if (t) t.style.display = 'none'`],
    ['overflow-x visible', `document.querySelector('[data-feed-scroller]').style.overflowX = 'visible'`],
    ['contain strict off', `document.querySelector('[data-feed-scroller]').style.contain = 'none'`],
  ]
  const RESTORE = `(() => {
    const s = document.querySelector('[data-feed-scroller]')
    s.style.paddingBottom = ''; s.style.paddingTop = ''; s.style.overflowX = ''; s.style.contain = ''
    const sp = document.querySelector('[data-feed-scroller] > .mt-auto'); if (sp) sp.style.marginTop = ''
    const r = document.querySelector('.offer-lift-region'); r.style.clipPath = ''; r.style.transform = ''
    const t = document.querySelector('.feed-tail'); if (t) t.style.display = ''
  })()`
  for (const [label, mutate] of MUTATIONS) {
    await page.evaluate(RESTORE)
    if (mutate) await page.evaluate(`(() => { ${mutate} })()`)
    await page.waitForTimeout(400)
    const reps: number[] = []
    for (let rep = 0; rep < 3; rep++) {
      await wheelUp()
      await drive(`document.querySelector('[data-feed-scroller]').scrollHeight`)
      let worst = 0
      const t0 = Date.now()
      while (Date.now() - t0 < 5000) {
        await page.waitForTimeout(150)
        const g = await geom()
        if (g.gap > worst) worst = g.gap
      }
      reps.push(Math.round(worst))
    }
    console.log(`${label.padEnd(24)} engine pull-up per rep: ${reps.join(' ')}px`)
  }
}

if (scenario === 'stale') {
  // Is the engine's max a STALE SNAPSHOT? Grow the content and see if the
  // shortfall grows by the same amount; force a scroll-container rebuild and
  // see if it resets to zero.
  const pullUp = async () => {
    await wheelUp()
    await drive(`document.querySelector('[data-feed-scroller]').scrollHeight`)
    let worst = 0
    const t0 = Date.now()
    while (Date.now() - t0 < 5000) {
      await page.waitForTimeout(150)
      const g = await geom()
      if (g.gap > worst) worst = g.gap
    }
    return Math.round(worst)
  }
  console.log(`baseline pull-up:                 ${await pullUp()}px`)
  await page.evaluate(`(() => { const d = document.createElement('div'); d.id = 'p1160grow'; d.style.height = '300px'; document.querySelector('[data-feed-scroller]').appendChild(d) })()`)
  await page.waitForTimeout(400)
  console.log(`after +300px appended:            ${await pullUp()}px`)
  await page.evaluate(`document.getElementById('p1160grow').remove()`)
  await page.waitForTimeout(400)
  console.log(`after removing it again:          ${await pullUp()}px`)
  await page.evaluate(`(async () => { const el = document.querySelector('[data-feed-scroller]'); el.style.overflowY = 'hidden'; el.getBoundingClientRect(); await new Promise((r) => requestAnimationFrame(r)); el.style.overflowY = '' })()`)
  await page.waitForTimeout(600)
  console.log(`after overflow-y toggle rebuild:  ${await pullUp()}px`)
  await page.evaluate(`(async () => { const el = document.querySelector('[data-feed-scroller]'); el.style.display = 'none'; el.getBoundingClientRect(); await new Promise((r) => requestAnimationFrame(r)); el.style.display = '' })()`)
  await page.waitForTimeout(600)
  console.log(`after display toggle rebuild:     ${await pullUp()}px`)
}

if (scenario === 'flip') {
  // Emulate the proposed app behavior: while pinned the LAST CHILD is anchor-
  // eligible (engine holds the bottom); a wheel-up flips every child to
  // overflow-anchor:none (engine cannot fight the reader); arriving back at
  // the bottom flips eligibility back. Then run the whole reader journey.
  await page.evaluate(`(() => {
    const el = document.querySelector('[data-feed-scroller]')
    const s = document.createElement('style'); s.id = 'p1160flip'; document.head.appendChild(s)
    const PINNED = '[data-feed-scroller] > * { overflow-anchor: none !important } [data-feed-scroller] > *:last-child { overflow-anchor: auto !important }'
    const FREE = '[data-feed-scroller] > * { overflow-anchor: none !important }'
    s.textContent = PINNED
    window.__p1160mode = 'pinned'
    el.addEventListener('wheel', (e) => {
      if (e.deltaY < 0 && window.__p1160mode !== 'free') { s.textContent = FREE; window.__p1160mode = 'free' }
    }, { passive: true })
    // Downward MOVEMENT restores end-anchor eligibility BEFORE arrival — works
    // for wheel, touch and scrollbar drags alike. The style change itself
    // refreshes the engine's stale max, and an eligible anchor below the
    // viewport cannot fight the reader.
    let lastTop = el.scrollTop
    el.addEventListener('scroll', () => {
      const top = el.scrollTop
      if (top > lastTop && window.__p1160mode !== 'pinned') { s.textContent = PINNED; window.__p1160mode = 'pinned' }
      lastTop = top
    }, { passive: true })
  })()`)
  await page.waitForTimeout(1000)
  const feedBox = (await page.evaluate(`(() => { const r = document.querySelector('[data-feed-scroller]').getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 } })()`)) as { x: number; y: number }
  await page.mouse.move(feedBox.x, feedBox.y)
  const start = await geom()
  for (let i = 0; i < 12; i++) { await page.mouse.wheel(0, -120); await page.waitForTimeout(120) }
  await page.waitForTimeout(1500)
  const up = await geom()
  console.log(`escape: gap ${start.gap} -> ${up.gap} (mode=${await page.evaluate('window.__p1160mode')})`)
  const holdLine: string[] = []
  for (let s = 1; s <= 8; s++) { await page.waitForTimeout(1000); holdLine.push(String(Math.round((await geom()).gap))) }
  console.log(`hold while free: ${holdLine.join(' ')}`)
  for (let i = 0; i < 20; i++) { await page.mouse.wheel(0, 120); await page.waitForTimeout(100) }
  await page.waitForTimeout(1000)
  const landed = await geom()
  const back: string[] = []
  for (let s = 1; s <= 12; s++) { await page.waitForTimeout(1000); back.push(String(Math.round((await geom()).gap))) }
  console.log(`landed gap=${landed.gap} (mode=${await page.evaluate('window.__p1160mode')}); per-second after: ${back.join(' ')}`)
  // And a second full cycle, to prove the flip is repeatable.
  for (let i = 0; i < 6; i++) { await page.mouse.wheel(0, -120); await page.waitForTimeout(120) }
  await page.waitForTimeout(1200)
  const up2 = await geom()
  for (let i = 0; i < 12; i++) { await page.mouse.wheel(0, 120); await page.waitForTimeout(100) }
  await page.waitForTimeout(1200)
  const landed2 = await geom()
  console.log(`cycle 2: escaped to gap=${up2.gap}, landed back gap=${landed2.gap} (mode=${await page.evaluate('window.__p1160mode')})`)
}

if (scenario === 'heal') {
  // After growth at the END leaves the engine's max one refresh behind, does
  // the next small layout change (a tail clock tick) heal it?
  await page.waitForTimeout(1500)
  await page.evaluate(`(() => { const d = document.createElement('div'); d.id = 'p1160grow'; d.style.height = '300px'; d.textContent = ' '; document.querySelector('[data-feed-scroller]').appendChild(d) })()`)
  await page.waitForTimeout(300)
  await wheelUp()
  await drive(`document.querySelector('[data-feed-scroller]').scrollHeight`)
  await page.waitForTimeout(1500)
  console.log(`after append+write, before ticks: gap=${(await geom()).gap}`)
  for (let s = 1; s <= 8; s++) {
    await page.evaluate(`(() => { const t = document.querySelector('.feed-tail-figure, .feed-tail-label'); if (t) t.textContent = t.textContent + ''; const d = document.getElementById('p1160grow'); d.textContent = 'tick ${'x'.repeat(1)}' + ${s} })()`)
    await page.waitForTimeout(1000)
    console.log(`  tick ${s}: gap=${(await geom()).gap}`)
  }
  await drive(`document.querySelector('[data-feed-scroller]').scrollHeight`)
  await page.waitForTimeout(2000)
  console.log(`after re-write at end: gap=${(await geom()).gap}`)
}

if (scenario === 'escape') {
  // The POD-993 escape check, finally runnable in WebKit: from the pinned
  // bottom, twelve ordinary upward wheel notches while the app's writers are
  // live. The intent latch should let every notch count.
  await page.waitForTimeout(1500)
  const feedBox = (await page.evaluate(`(() => { const r = document.querySelector('[data-feed-scroller]').getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 } })()`)) as { x: number; y: number }
  await page.mouse.move(feedBox.x, feedBox.y)
  const start = await geom()
  for (let i = 0; i < 12; i++) {
    await page.mouse.wheel(0, -120)
    await page.waitForTimeout(120)
  }
  await page.waitForTimeout(1000)
  const g = await geom()
  console.log(`escape: gap ${start.gap} -> ${g.gap} after 12 up-notches (escaped ${Math.round(g.gap - start.gap)}px, jumpBtn=${g.jumpBtn})`)
  // ...and does the position HOLD, or does something pull the reader back?
  const line: string[] = []
  for (let s = 1; s <= 10; s++) {
    await page.waitForTimeout(1000)
    line.push(String(Math.round((await geom()).gap)))
  }
  console.log(`after escape, gap per second: ${line.join(' ')}`)
  // Then wheel back down to the bottom and watch for the yank-up.
  for (let i = 0; i < 20; i++) {
    await page.mouse.wheel(0, 120)
    await page.waitForTimeout(100)
  }
  await page.waitForTimeout(500)
  const landed = await geom()
  const back: string[] = []
  for (let s = 1; s <= 12; s++) {
    await page.waitForTimeout(1000)
    back.push(String(Math.round((await geom()).gap)))
  }
  console.log(`wheeled back down: landed gap=${landed.gap}; per-second after: ${back.join(' ')}`)
  const evs = await events()
  const noise = (el: unknown) => String(el).match(/^(P\.|#text|H[1-6]|UL|OL|TABLE|LI|SPAN\.|A\.|CODE|PRE|STRONG|EM)/)
  const keep = evs.filter((e) => !((e.k === 'add' || e.k === 'rm') && noise(e.el)))
  console.log(`\nlast 120 events (dom noise filtered):`)
  for (const e of keep.slice(-120)) console.log(' ', JSON.stringify(e))
}

if (scenario === 'poke') {
  // From a pinned rest at the bottom, one instant write of -200 with NO wheel
  // latch, then watch 4s at full resolution. Separates: app writes (logged with
  // stacks), engine moves (scroll events with no write), and where it rests.
  await page.waitForTimeout(2000)
  const preEv = (await events()).length
  await drive(`document.querySelector('[data-feed-scroller]').scrollTop - 200`)
  await page.waitForTimeout(4000)
  const g = await geom()
  console.log(`rest after poke: ${JSON.stringify(g)}`)
  const evs = (await events()).slice(preEv)
  for (const e of evs) {
    if (e.k === 'add' || e.k === 'rm') {
      const el = String(e.el)
      if (!el.startsWith('P.') && !el.startsWith('#text') && !el.startsWith('H2') && !el.startsWith('UL') && !el.startsWith('TABLE')) console.log(' ', JSON.stringify(e))
      continue
    }
    console.log(' ', JSON.stringify(e))
  }
}

if (scenario === 'park') {
  // Park the reader at several distances from the bottom, latched-released the
  // way a real wheel-up leaves them, and watch whether the position RATCHETS
  // as the DOM below the fold changes. gap=0 is "arrived exactly"; 2 is a
  // fractional-residue arrival; 10 is within the 80px near band but above the
  // 4px re-pin; 60 is clearly near-but-not-at.
  for (const parkGap of [0, 2, 10, 60]) {
    await wheelUp()
    for (let i = 0; i < 8; i++) { await drive(`document.querySelector('[data-feed-scroller]').scrollTop - 150`); await page.waitForTimeout(50) }
    await page.waitForTimeout(500)
    for (let i = 0; i < 9; i++) { await drive(`document.querySelector('[data-feed-scroller]').scrollTop + 130`); await page.waitForTimeout(50) }
    await drive(`document.querySelector('[data-feed-scroller]').scrollHeight - document.querySelector('[data-feed-scroller]').clientHeight - ${parkGap}`)
    await page.waitForTimeout(300)
    const start = await geom()
    const preEv = (await events()).length
    const line: string[] = []
    for (let s = 1; s <= 20; s++) {
      await page.waitForTimeout(1000)
      const g = await geom()
      line.push(`${Math.round(g.gap)}`)
    }
    const end = await geom()
    console.log(`\npark at gap=${parkGap}: start gap=${start.gap} → per-second: ${line.join(' ')}  (jumpBtn=${end.jumpBtn})`)
    if (Math.abs(end.gap - start.gap) > 4) {
      const evs = (await events()).slice(preEv)
      const interesting = evs.filter((e) => e.k !== 'gap' || Math.abs(Number(e.gap)) > 0.5)
      console.log(`  drifted ${Math.round(Number(end.gap) - start.gap)}px — ${interesting.length} events:`)
      for (const e of interesting.slice(0, 80)) console.log('   ', JSON.stringify(e))
    }
  }
  await page.screenshot({ path: `${OUT}.png` })
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
