import { webkit } from 'playwright'

const ORIGIN = 'http://127.0.0.1:18787'
const COOKIE = process.env.PODIUM_SESSION_COOKIE ?? ''
const browser = await webkit.launch()
const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } })
await ctx.addCookies([
  { name: 'podium_session', value: COOKIE, domain: '127.0.0.1', path: '/', httpOnly: false, secure: false },
])
const page = await ctx.newPage()
await page.goto(`${ORIGIN}/workspace?wt=${encodeURIComponent('/home/podium/podium')}`, {
  waitUntil: 'domcontentloaded',
})
await page.waitForTimeout(3000)
await page.getByText(process.env.PODIUM_ROW_LABEL ?? 'Focused first-run').first().click({ timeout: 8000, force: true, noWaitAfter: true })
await page.waitForTimeout(4000)

const snap = await page.evaluate(`(() => {
  const feeds = Array.from(document.querySelectorAll('[data-feed-scroller]'))
  return {
    reduceMatches: matchMedia('(prefers-reduced-motion: reduce)').matches,
    noPrefMatches: matchMedia('(prefers-reduced-motion: no-preference)').matches,
    feedCount: feeds.length,
    feeds: feeds.map((f) => {
      const cs = getComputedStyle(f)
      let hiddenAncestor = null
      for (let el = f; el; el = el.parentElement) {
        if (getComputedStyle(el).display === 'none') { hiddenAncestor = el.className || el.tagName; break }
      }
      return {
        display: cs.display,
        rectH: Math.round(f.getBoundingClientRect().height),
        rows: f.querySelectorAll('.transcript-row').length,
        stamped: f.querySelectorAll('.transcript-row[data-unroll]').length,
        seen: f.querySelectorAll('.transcript-row[data-unroll-seen]').length,
        hiddenAncestor,
      }
    }),
  }
})()`)
console.log(JSON.stringify(snap, null, 2))
await browser.close()
