/**
 * POD-1224 — shoot the issue rail and the page header from the branch's own
 * source (vite dev on 55621, API proxied to the live instance) and MEASURE the
 * launch box rather than eyeballing it: a 232px column is where a segmented
 * well overflows, and an overflow is invisible in a screenshot until it clips.
 *
 *   PODIUM_SESSION_COOKIE=… bun apps/web/e2e/pod1224-rail.ts
 */
import { chromium } from 'playwright'

const ORIGIN = process.env.P1224_ORIGIN ?? 'http://127.0.0.1:55621'
const COOKIE = process.env.PODIUM_SESSION_COOKIE ?? ''
const OUT = process.env.P1224_OUT ?? 'apps/web/e2e'

const TARGETS = [
  { name: 'started', id: process.env.P1224_STARTED ?? '' },
  { name: 'unstarted', id: process.env.P1224_UNSTARTED ?? '' },
]

/** Anything inside the rail whose content is wider than its box, or whose box
 *  escapes the rail's own edges. Both are the failure a screenshot hides. */
const MEASURE = (): unknown => {
  const aside = document.querySelector('[data-testid="issue-aside"]')
  if (!aside) return { error: 'no aside' }
  const overflow: unknown[] = []
  for (const el of Array.from(aside.querySelectorAll('*'))) {
    if (el.scrollWidth > el.clientWidth + 1 && el.clientWidth > 0) {
      overflow.push({
        cls: String(el.className).slice(0, 70),
        scrollW: el.scrollWidth,
        clientW: el.clientWidth,
      })
    }
  }
  const box = aside.getBoundingClientRect()
  const outside: unknown[] = []
  for (const el of Array.from(aside.querySelectorAll('button'))) {
    const r = el.getBoundingClientRect()
    if (r.right > box.right + 0.5 || r.left < box.left - 0.5) {
      outside.push({
        cls: String(el.className).slice(0, 70),
        left: Math.round(r.left),
        right: Math.round(r.right),
      })
    }
  }
  return { asideW: box.width, overflow, outside }
}

/** Every leaf of text in the header, with its box top/bottom — the numbers that
 *  say whether the breadcrumb sits on one line or steps. */
const CRUMBS = (): unknown => {
  // The issue page's own bar, not the shell topbar above it.
  const header = document.querySelector('header.h-10')
  if (!header) return { error: 'no issue header' }
  const out: unknown[] = []
  for (const el of Array.from(header.querySelectorAll('span, button'))) {
    const text = (el.textContent ?? '').trim()
    if (!text || text.length > 24 || el.querySelector('span, button')) continue
    const r = el.getBoundingClientRect()
    out.push({ text, top: Math.round(r.top * 10) / 10, bottom: Math.round(r.bottom * 10) / 10 })
  }
  return out
}

async function main(): Promise<void> {
  const browser = await chromium.launch()
  const ctx = await browser.newContext({
    // 1500 gives the rail its xl 296px; 1100 gives the 272px it wears just
    // above the md breakpoint, which is where the launch box is tightest.
    viewport: { width: Number(process.env.P1224_W ?? 1500), height: 1000 },
    // 3× so the breadcrumb can be read the way the operator's own screenshot
    // read it — a 1× crop of an 11px line proves nothing about alignment.
    deviceScaleFactor: Number(process.env.P1224_SCALE ?? 1),
  })
  if (COOKIE) {
    await ctx.addCookies([
      {
        name: 'podium_session',
        value: COOKIE,
        domain: '127.0.0.1',
        path: '/',
        httpOnly: false,
        secure: false,
      },
    ])
  }
  const page = await ctx.newPage()
  page.on('console', (m) => {
    if (m.type() === 'error') console.log('  console.error:', m.text().slice(0, 160))
  })

  for (const target of TARGETS) {
    if (!target.id) continue
    await page.goto(`${ORIGIN}/issues/${encodeURIComponent(target.id)}`, {
      waitUntil: 'domcontentloaded',
    })
    // Poll rather than `waitForSelector`: the rail re-renders on every store
    // snapshot, so the locator resolves and is torn down again before the
    // stability check passes and the wait times out on an element that is
    // plainly there.
    for (let i = 0; i < 60; i++) {
      const seen = await page.evaluate(
        () => document.querySelector('[data-testid="issue-aside"]') !== null,
      )
      if (seen) break
      await page.waitForTimeout(500)
    }
    await page.waitForTimeout(2500)
    const aside = await page.$('[data-testid="issue-aside"]')
    await aside?.screenshot({ path: `${OUT}/pod1224-${target.name}-rail.png` })
    const header = await page.$('header.h-10')
    const hbox = await header?.boundingBox()
    if (hbox) {
      await page.screenshot({
        path: `${OUT}/pod1224-${target.name}-header.png`,
        clip: { x: hbox.x, y: hbox.y, width: Math.min(hbox.width, 420), height: hbox.height },
      })
    }
    console.log(`\n== ${target.name} (${target.id})`)
    console.log('  layout:', JSON.stringify(await page.evaluate(MEASURE), null, 1))
    console.log('  crumbs:', JSON.stringify(await page.evaluate(CRUMBS)))
    await page.screenshot({ path: `${OUT}/pod1224-${target.name}-page.png` })
  }

  await browser.close()
}

void main()
