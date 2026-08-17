/**
 * PHONE TRANSCRIPT WATCH (POD-1251) — does the feed ever resolve?
 *
 * Opens a session in the phone app and samples the transcript scroller for 40s:
 * row count, scrollHeight vs clientHeight, the page's own text. Also logs every
 * transcript-shaped HTTP call and websocket frame, so a feed that stays empty
 * can be blamed on the request rather than on the render (or the other way).
 *
 *   bun run apps/mobile/e2e/pod1251-watch.ts <sessionId> <label>
 */
import { webkit } from 'playwright'

const [sessionId = '', label = 'session'] = process.argv.slice(2)
const ORIGIN = process.env.P1251_ORIGIN ?? 'http://127.0.0.1:18787'
const COOKIE = process.env.PODIUM_SESSION_COOKIE ?? ''

const SAMPLE = `() => {
  const scrollers = [...document.querySelectorAll('div')].filter((el) => {
    const oy = getComputedStyle(el).overflowY
    return oy === 'auto' || oy === 'scroll'
  })
  const feed = scrollers.sort((a, b) => b.clientHeight - a.clientHeight)[0]
  const text = document.body.innerText
  return {
    scrollers: scrollers.length,
    sh: feed ? feed.scrollHeight : null,
    ch: feed ? feed.clientHeight : null,
    kids: feed ? feed.querySelectorAll('div').length : null,
    chars: text.length,
    tail: text.slice(-90).replace(/\\n/g, ' | '),
  }
}`

async function main(): Promise<void> {
  const browser = await webkit.launch()
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
  page.on('console', (m) => {
    if (m.type() === 'error' || m.type() === 'warning')
      console.log(`[console:${m.type()}]`, m.text().slice(0, 240))
  })
  page.on('pageerror', (e) => console.log('[pageerror]', String(e).slice(0, 240)))
  page.on('response', (r) => {
    const u = r.url()
    if (/transcript|sessions\./i.test(u)) console.log('[http]', r.status(), u.slice(0, 200))
  })
  page.on('websocket', (ws) => {
    console.log('[ws]', ws.url().slice(0, 120))
    ws.on('framereceived', (f) => {
      const s = typeof f.payload === 'string' ? f.payload : f.payload.toString('utf8')
      if (/transcript/i.test(s)) console.log('[ws<-]', s.slice(0, 220))
    })
    ws.on('framesent', (f) => {
      const s = typeof f.payload === 'string' ? f.payload : f.payload.toString('utf8')
      if (/transcript/i.test(s)) console.log('[ws->]', s.slice(0, 220))
    })
  })
  await page.goto(`${ORIGIN}/mobile/session/${sessionId}`, { waitUntil: 'domcontentloaded' })
  for (let i = 1; i <= 13; i++) {
    await page.waitForTimeout(3000)
    const s = await page.evaluate(`(${SAMPLE})()`)
    console.log(`t=${i * 3}s`, JSON.stringify(s))
  }
  await page.screenshot({ path: `apps/mobile/e2e/pod1251-watch-${label}.png` })
  await browser.close()
}

void main()
