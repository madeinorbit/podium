/**
 * DOES THE PHONE FEED OPEN AT THE NEWEST MESSAGE? (POD-1251)
 *
 * TranscriptList claims it does: "until a real gesture moves the feed, every
 * content-size change goes back to the end". This samples scrollTop, scrollHeight
 * and every scrollTop WRITE (with a stack fragment) from first paint, so a feed
 * that lands at the top can be told apart from one that lands at the tail and is
 * pulled back.
 *
 *   bun run apps/mobile/e2e/pod1251-open-pin.ts <sessionId> <label>
 */
import { chromium } from 'playwright'

const [sessionId = '', label = 'session'] = process.argv.slice(2)
const ORIGIN = process.env.P1251_ORIGIN ?? 'http://127.0.0.1:18787'
const COOKIE = process.env.PODIUM_SESSION_COOKIE ?? ''

const INSTRUMENT = `() => {
  if (window.__p1251) return
  const t0 = performance.now()
  const S = (window.__p1251 = { log: [], armed: false })
  const arm = () => {
    if (S.armed) return
    const el = [...document.querySelectorAll('div')]
      .filter((n) => { const oy = getComputedStyle(n).overflowY; return oy === 'auto' || oy === 'scroll' })
      .sort((a, b) => b.clientHeight - a.clientHeight)[0]
    if (!el) return
    S.armed = true
    S.el = el
    let p = Object.getPrototypeOf(el), d = null
    while (p && !(d = Object.getOwnPropertyDescriptor(p, 'scrollTop'))) p = Object.getPrototypeOf(p)
    Object.defineProperty(el, 'scrollTop', {
      configurable: true,
      get() { return d.get.call(this) },
      set(v) {
        const stack = (new Error().stack || '').split('\\n').slice(1, 4).join('|').slice(0, 200)
        S.log.push({ t: Math.round(performance.now() - t0), k: 'write', v: Math.round(v), from: Math.round(d.get.call(el)), sh: el.scrollHeight, stack })
        d.set.call(this, v)
      },
    })
    el.addEventListener('scroll', () => {
      S.log.push({ t: Math.round(performance.now() - t0), k: 'scroll', top: Math.round(d.get.call(el)), sh: el.scrollHeight, ch: el.clientHeight })
    }, { passive: true })
    S.log.push({ t: Math.round(performance.now() - t0), k: 'armed', sh: el.scrollHeight, ch: el.clientHeight })
  }
  setInterval(arm, 100)
  let lastSh = -1
  setInterval(() => {
    if (!S.el) return
    const sh = S.el.scrollHeight
    if (sh !== lastSh) {
      lastSh = sh
      S.log.push({ t: Math.round(performance.now() - t0), k: 'grow', sh, top: Math.round(S.el.scrollTop), ch: S.el.clientHeight })
    }
  }, 100)
}`

async function main(): Promise<void> {
  const browser = await chromium.launch()
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true,
  })
  if (COOKIE) {
    await context.addCookies([
      { name: 'podium_session', value: COOKIE, domain: '127.0.0.1', path: '/' },
    ])
  }
  const page = await context.newPage()
  await page.addInitScript(`(${INSTRUMENT})()`)
  await page.goto(`${ORIGIN}/mobile/session/${sessionId}`, { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(30000)
  const log = (await page.evaluate(() => window.__p1251.log)) as Array<Record<string, unknown>>
  console.log(`\n=== ${label} — ${log.length} events ===`)
  for (const e of log) console.log(JSON.stringify(e))
  await browser.close()
}

void main()
