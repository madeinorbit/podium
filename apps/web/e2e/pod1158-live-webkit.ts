/**
 * THE UNROLL AND THE DECK, IN REAL WEBKIT, AGAINST THE REAL APP (POD-1158).
 *
 * `pod1158-unroll-engine.ts` proves the keyframe animates in both engines. It
 * says nothing about this feed, whose whole difficulty is that three things
 * write `scrollTop` and a row growing at the bottom is a moving target for all
 * of them. This drives the running instance instead.
 *
 * WHAT IT MEASURES, per arriving row:
 *   - that `data-unroll` was actually stamped, and released again afterwards;
 *   - the row's height across the animation, so a row that "animates" to the
 *     wrong number is not counted as a pass;
 *   - every `scrollTop` write, tagged by whether a claim was in flight. The
 *     claim's contract is that during an unroll there is exactly ONE writer, so
 *     writes-per-frame > 1 while unrolling is the failure this exists to catch;
 *   - whether the view was still at the bottom when the unroll ended.
 *
 * It also counts `data-push` on work lines, which is the deck taking a sheet.
 *
 * USAGE. Point it at a session whose transcript is actively moving; the honest
 * choice is the agent's own, so its own tool calls are the traffic.
 *
 *   podium auth mint-session
 *   bunx tsx apps/web/e2e/pod1158-live-webkit.ts <session-id> <worktree-path> [seconds]
 */
import { webkit } from 'playwright'

const [sessionId, worktree, secondsArg] = process.argv.slice(2)
if (!sessionId || !worktree) {
  console.error('usage: pod1158-live-webkit.ts <session-id> <worktree-path> [seconds]')
  process.exit(1)
}
const RUN_MS = (Number(secondsArg) || 60) * 1000
const ORIGIN = 'http://127.0.0.1:18787'
const COOKIE = process.env.PODIUM_SESSION_COOKIE ?? ''

interface Report {
  unrolls: {
    heights: number[]
    released: boolean
    gapAtEnd: number
    writesDuring: number
    arriveH: string
    animName: string
    animDur: string
    display: string
  }[]
  pushes: number
  writesTotal: number
  writesWhileUnrolling: number
  framesWhileUnrolling: number
  sawFeed: boolean
}

const INSTRUMENT = `() => {
  const scroller = document.querySelector('[data-feed-scroller]')
  if (!scroller) return false
  const w = window
  w.__pod1158 = { unrolls: [], pushes: 0, writesTotal: 0, writesWhileUnrolling: 0, framesWhileUnrolling: 0, live: null }
  const S = w.__pod1158

  // Count every write the app makes, and attribute it to an unroll if one is
  // in flight. The element's own property shadows the prototype accessor.
  const proto = Object.getPrototypeOf(scroller)
  const desc = Object.getOwnPropertyDescriptor(proto, 'scrollTop')
  Object.defineProperty(scroller, 'scrollTop', {
    configurable: true,
    get() { return desc.get.call(this) },
    set(v) {
      S.writesTotal++
      if (S.live) { S.writesWhileUnrolling++; S.live.writesDuring++ }
      desc.set.call(this, v)
    },
  })

  const gap = () => Math.round(scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight)

  const watch = (row) => {
    if (row.__pod1158seen) return
    row.__pod1158seen = true
    const cs = getComputedStyle(row)
    const rec = {
      heights: [], released: false, gapAtEnd: -1, writesDuring: 0,
      arriveH: cs.getPropertyValue('--arrive-h').trim(),
      animName: cs.animationName, animDur: cs.animationDuration, display: cs.display,
    }
    S.unrolls.push(rec)
    S.live = rec
    const sample = () => {
      rec.heights.push(Math.round(row.getBoundingClientRect().height))
      S.framesWhileUnrolling++
      if (row.hasAttribute('data-unroll')) requestAnimationFrame(sample)
      else {
        rec.released = true
        rec.gapAtEnd = gap()
        if (S.live === rec) S.live = null
      }
    }
    requestAnimationFrame(sample)
  }

  // Rows are stamped in a layout effect, so an attribute observer over the
  // subtree is what catches them; childList alone would race the stamp.
  new MutationObserver((muts) => {
    for (const m of muts) {
      const t = m.target
      if (m.attributeName === 'data-unroll' && t.hasAttribute('data-unroll')) watch(t)
      if (m.attributeName === 'data-push' && t.getAttribute('data-push') === 'true') S.pushes++
    }
  }).observe(scroller, { subtree: true, attributes: true, attributeFilter: ['data-unroll', 'data-push'] })
  return true
}`

const COLLECT = `() => {
  const S = window.__pod1158
  return S ? { ...S, live: undefined, sawFeed: true } : { sawFeed: false }
}`

const browser = await webkit.launch()
const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } })
if (COOKIE) {
  await ctx.addCookies([
    { name: 'podium_session', value: COOKIE, domain: '127.0.0.1', path: '/', httpOnly: false, secure: false },
  ])
}
const page = await ctx.newPage()
const url = `${ORIGIN}/workspace?wt=${encodeURIComponent(worktree)}`
await page.goto(url, { waitUntil: 'domcontentloaded' })
// `pane` wants a pane id, not a session id, so the transcript is opened the way
// a reader opens it: click the work row, then the session under it.
await page.waitForTimeout(3000)
// Playwright's WebKit will not complete a click action against this shell —
// the same class of thing POD-1160 records for wheel input. Dispatching the
// DOM event directly sidesteps its actionability layer entirely, and a real
// `click()` is what the app's own handler listens for anyway.
const label = process.env.PODIUM_ROW_LABEL ?? 'Chat feed motion'
let opened = false
for (let i = 0; i < 20 && !opened; i++) {
  opened = await page.evaluate((wanted: string) => {
    const hit = Array.from(document.querySelectorAll('*')).find(
      (el) => el.children.length === 0 && (el.textContent ?? '').trim().includes(wanted),
    )
    if (!hit) return false
    const row = hit.closest('[data-pressable], [role="button"], button, li') ?? hit.parentElement
    ;(row ?? hit).dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    return true
  }, label)
  if (!opened) await page.waitForTimeout(1000)
}
console.log(`opened work row "${label}": ${opened}`)
await page.waitForTimeout(4000)

let armed = false
for (let i = 0; i < 60 && !armed; i++) {
  armed = (await page.evaluate(`(${INSTRUMENT})()`)) as boolean
  if (!armed) await page.waitForTimeout(500)
}
if (!armed) {
  console.error('never found [data-feed-scroller] — check auth and the pane id')
  await page.screenshot({ path: 'apps/web/e2e/pod1158-live-fail.png' })
  await browser.close()
  process.exit(2)
}
console.log(`armed on ${url}`)
console.log(`watching for ${RUN_MS / 1000}s — drive the session now\n`)

await page.waitForTimeout(RUN_MS)
const r = (await page.evaluate(`(${COLLECT})()`)) as Report
await page.screenshot({ path: 'apps/web/e2e/pod1158-live-webkit.png' })
await browser.close()

console.log(`arrivals seen        ${r.unrolls.length}`)
console.log(`deck pushes seen     ${r.pushes}`)
console.log(`scrollTop writes     ${r.writesTotal} total, ${r.writesWhileUnrolling} during an unroll`)
console.log(
  `writes per frame     ${
    r.framesWhileUnrolling > 0
      ? (r.writesWhileUnrolling / r.framesWhileUnrolling).toFixed(2)
      : 'n/a'
  } while unrolling  (contract: <= 1.0 — one writer)\n`,
)
for (const [i, u] of r.unrolls.entries()) {
  const grew = u.heights.length > 1 && u.heights[0]! < u.heights[u.heights.length - 1]!
  console.log(
    `  #${i + 1} --arrive-h=${u.arriveH || '(unset)'} anim=${u.animName}/${u.animDur} display=${u.display}\n` +
      `     heights ${u.heights.slice(0, 8).join(' → ')}${u.heights.length > 8 ? ' …' : ''}` +
      `  released=${u.released} gapAtEnd=${u.gapAtEnd}px writes=${u.writesDuring}` +
      `  ${grew ? 'GREW ✓' : 'DID NOT GROW ✗'}`,
  )
}
