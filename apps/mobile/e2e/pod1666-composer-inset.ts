/**
 * THE FEED'S BOTTOM INSET FOR THE FLOATING COMPOSER (POD-1666).
 *
 * Opens a session transcript in WebKit at an iPhone viewport, scrolls the feed
 * to its end, and reports the one number the bug is about: the gap between the
 * last painted content and the top of the composer. Negative means the message
 * is UNDERNEATH the prompt box, which is what the report showed.
 *
 * USAGE
 *   bunx expo export -p web --output-dir dist-1666      (from apps/mobile)
 *   bun run apps/mobile/e2e/pod1251-serve.ts 8166 dist-1666
 *   PODIUM_SESSION_COOKIE=$(podium auth mint-session | head -1) \
 *     bun run apps/mobile/e2e/pod1666-composer-inset.ts <sessionId> <label>
 */
import { webkit } from 'playwright'

const [sessionId = '', label = 'after'] = process.argv.slice(2)
const ORIGIN = process.env.P1666_ORIGIN ?? 'http://127.0.0.1:8166'
const COOKIE = process.env.PODIUM_SESSION_COOKIE ?? ''
const OUT = `apps/mobile/e2e/pod1666-${label}`

const REPORT = `() => {
  const feed = [...document.querySelectorAll('div')]
    .filter((el) => {
      const oy = getComputedStyle(el).overflowY
      return oy === 'auto' || oy === 'scroll'
    })
    .sort((a, b) => b.clientHeight - a.clientHeight)[0]
  const field = document.querySelector('textarea')
  // The dock is the composer's outermost box — the blurred capsule's ancestor
  // that reaches both screen edges.
  let dock = field
  while (dock && dock.getBoundingClientRect().width < window.innerWidth - 1) {
    dock = dock.parentElement
  }
  const dockRect = dock ? dock.getBoundingClientRect() : null
  const content = feed ? feed.firstElementChild : null
  // The last thing actually PAINTED in the feed, padding excluded.
  const rows = content ? [...content.children] : []
  const last = rows.length ? rows[rows.length - 1] : null
  const lastRect = last ? last.getBoundingClientRect() : null
  return {
    fieldHeight: field ? Math.round(field.getBoundingClientRect().height) : null,
    fieldLineHeight: field ? getComputedStyle(field).lineHeight : null,
    contentPaddingBottom: content ? getComputedStyle(content).paddingBottom : null,
    dockHeight: dockRect ? Math.round(dockRect.height) : null,
    dockTop: dockRect ? Math.round(dockRect.top) : null,
    lastRowBottom: lastRect ? Math.round(lastRect.bottom) : null,
    // > 0 clears the composer; < 0 is the reported bug.
    gap: dockRect && lastRect ? Math.round(dockRect.top - lastRect.bottom) : null,
    scrolledToEnd: feed
      ? Math.round(feed.scrollHeight - feed.scrollTop - feed.clientHeight)
      : null,
  }
}`

const browser = await webkit.launch()
const context = await browser.newContext({
  viewport: { width: 390, height: 844 },
  deviceScaleFactor: 2,
  isMobile: true,
  hasTouch: true,
  userAgent:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
})
if (COOKIE) {
  await context.addCookies([
    { name: 'podium_session', value: COOKIE, domain: '127.0.0.1', path: '/' },
  ])
}
const page = await context.newPage()
page.on('console', (m) => {
  if (m.type() === 'error') console.log('[console]', m.text().slice(0, 200))
})
await page.goto(`${ORIGIN}/mobile/session/${sessionId}`, { waitUntil: 'domcontentloaded' })

for (let i = 0; i < 60; i++) {
  const has = await page.evaluate(`(() => {
    const s = [...document.querySelectorAll('div')].filter((el) => {
      const oy = getComputedStyle(el).overflowY
      return oy === 'auto' || oy === 'scroll'
    })
    return s.some((el) => el.scrollHeight > el.clientHeight + 4)
  })()`)
  if (has) break
  await page.waitForTimeout(1000)
}
await page.waitForTimeout(2000)

// The feed pins itself to the tail on open, but a reader who has scrolled is
// the case the report came from — put it at the very end explicitly.
await page.evaluate(`(() => {
  const el = [...document.querySelectorAll('div')]
    .filter((n) => {
      const oy = getComputedStyle(n).overflowY
      return oy === 'auto' || oy === 'scroll'
    })
    .sort((a, b) => b.clientHeight - a.clientHeight)[0]
  if (el) el.scrollTop = el.scrollHeight
})()`)
await page.waitForTimeout(600)

const report = await page.evaluate(`(${REPORT})()`)
console.log(`=== ${label} (${sessionId}) ===`)
console.log(JSON.stringify(report, null, 1))
await page.screenshot({ path: `${OUT}.png` })
await browser.close()
