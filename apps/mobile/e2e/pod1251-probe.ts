/**
 * PHONE HIBERNATION PROBE (POD-1251).
 *
 * Drives the LIVE instance's phone app (`/mobile`) in Playwright WebKit at an
 * iPhone viewport with touch, opens a session transcript, and reports:
 *
 *   - the lifecycle banner's computed ink and ground (the "why is it red" half)
 *   - the transcript scroller's geometry, and whether a real touch drag and a
 *     wheel move it (the "cannot scroll" half)
 *
 * A LIVE session is the control: whatever the hibernated one does, the live one
 * must do the opposite for the finding to be about hibernation at all.
 *
 * USAGE
 *   podium auth mint-session   (pass value via PODIUM_SESSION_COOKIE)
 *   bun run apps/mobile/e2e/pod1251-probe.ts <sessionId> <label>
 */
import { webkit } from 'playwright'

const [sessionId = '', label = 'session'] = process.argv.slice(2)
const ORIGIN = process.env.P1251_ORIGIN ?? 'http://127.0.0.1:18787'
const COOKIE = process.env.PODIUM_SESSION_COOKIE ?? ''
const OUT = `apps/mobile/e2e/pod1251-${label}`

const REPORT = `() => {
  const rgb = (el, prop) => getComputedStyle(el)[prop]
  const banner =
    document.querySelector('[data-testid="lifecycle-banner"]') ??
    document.querySelector('[data-testid="lifecycle-pane"]')
  const bannerInfo = banner
    ? {
        testid: banner.getAttribute('data-testid'),
        text: (banner.textContent || '').slice(0, 160),
        background: rgb(banner, 'backgroundColor'),
        color: rgb(banner, 'color'),
        borderBottomColor: rgb(banner, 'borderBottomColor'),
        height: Math.round(banner.getBoundingClientRect().height),
        spans: [...banner.querySelectorAll('div,span,p')]
          .slice(0, 8)
          .map((el) => ({ t: (el.textContent || '').slice(0, 40), c: rgb(el, 'color') })),
        svgStroke: [...banner.querySelectorAll('svg')].map((s) => rgb(s, 'color')),
      }
    : null
  // The feed scroller: react-native-web renders the FlatList as a div that
  // actually overflows. Find every scrollable div and take the tallest.
  const scrollers = [...document.querySelectorAll('div')]
    .filter((el) => {
      const oy = getComputedStyle(el).overflowY
      return oy === 'auto' || oy === 'scroll'
    })
    .map((el) => ({
      el,
      cls: (el.getAttribute('class') || '').slice(0, 40),
      sh: el.scrollHeight,
      ch: el.clientHeight,
      top: el.scrollTop,
      overflowY: getComputedStyle(el).overflowY,
      touchAction: getComputedStyle(el).touchAction,
    }))
  const feed = scrollers.filter((s) => s.sh > s.ch + 4).sort((a, b) => b.ch - a.ch)[0] ?? null
  window.__p1251feed = feed?.el ?? null
  return {
    banner: bannerInfo,
    scrollers: scrollers.map(({ el, ...rest }) => rest),
    feed: feed ? { cls: feed.cls, sh: feed.sh, ch: feed.ch, top: feed.top } : null,
    // Everything the pull-to-refresh boundary decides from.
    boundary: (() => {
      const b = document.querySelector('[data-pull-to-refresh]')
      if (!b) return null
      const r = b.getBoundingClientRect()
      return {
        touchAction: getComputedStyle(b).touchAction,
        height: Math.round(r.height),
        top: Math.round(r.top),
        containsFeed: window.__p1251feed ? b.contains(window.__p1251feed) : false,
      }
    })(),
    composerPresent: !!document.querySelector('textarea, input[type="text"]'),
    bodyText: document.body.innerText.slice(0, 300),
  }
}`

async function main(): Promise<void> {
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
  // The transcript arrives over the socket after the shell paints; a hibernated
  // one is a zero-overflow skeleton for seconds (see the POD-1160 note). WAIT
  // for real overflow rather than guessing, and report how long it took — the
  // wait itself is part of what "it does not scroll" means to a reader.
  const t0 = Date.now()
  let overflowedAt: number | null = null
  for (let i = 0; i < 60; i++) {
    const has = await page.evaluate(`(() => {
      const s = [...document.querySelectorAll('div')].filter((el) => {
        const oy = getComputedStyle(el).overflowY
        return oy === 'auto' || oy === 'scroll'
      })
      return s.some((el) => el.scrollHeight > el.clientHeight + 4)
    })()`)
    if (has) {
      overflowedAt = Date.now() - t0
      break
    }
    await page.waitForTimeout(1000)
  }
  console.log(`overflow after ${overflowedAt === null ? 'NEVER (60s)' : `${overflowedAt}ms`}`)
  await page.waitForTimeout(1500)

  const before = await page.evaluate(`(${REPORT})()`)
  console.log(`\n=== ${label} (${sessionId}) ===`)
  console.log(JSON.stringify(before, null, 1))
  await page.screenshot({ path: `${OUT}-1-open.png` })

  if (before.feed) {
    // Re-queried every time: a re-render replaces the scroller node, and a
    // stale handle would report the old one's numbers (or throw).
    const top = () =>
      page.evaluate(`(() => {
        const el = [...document.querySelectorAll('div')]
          .filter((n) => {
            const oy = getComputedStyle(n).overflowY
            return oy === 'auto' || oy === 'scroll'
          })
          .sort((a, b) => b.clientHeight - a.clientHeight)[0]
        return el
          ? { top: Math.round(el.scrollTop), sh: el.scrollHeight, ch: el.clientHeight }
          : null
      })()`) as Promise<{ top: number; sh: number; ch: number } | null>
    const start = await top()

    // 1. A pointer drag DOWNWARD from mid-feed. Playwright's touchscreen has no
    //    drag, but the pull-to-refresh boundary runs the same rule on the
    //    PointerEvent path, so this is the gesture its logic sees.
    await page.mouse.move(195, 300)
    await page.mouse.down()
    for (let i = 1; i <= 10; i++) await page.mouse.move(195, 300 + i * 30)
    await page.mouse.up()
    await page.waitForTimeout(400)
    const afterDragDown = await top()

    // 2. A pointer drag UPWARD — the gesture for reading forward in the feed.
    await page.mouse.move(195, 600)
    await page.mouse.down()
    for (let i = 1; i <= 10; i++) await page.mouse.move(195, 600 - i * 30)
    await page.mouse.up()
    await page.waitForTimeout(400)
    const afterWheel = await top()

    const pull = await page.evaluate(() => {
      const el = document.querySelector('[data-pull-to-refresh-indicator]') as HTMLElement | null
      return el ? { opacity: getComputedStyle(el).opacity, text: el.innerText } : null
    })
    console.log('start          :', JSON.stringify(start))
    console.log('after drag-down:', JSON.stringify(afterDragDown))
    console.log('after drag-up  :', JSON.stringify(afterWheel))
    console.log('pull indicator :', JSON.stringify(pull))
    await page.screenshot({ path: `${OUT}-2-after-scroll.png` })
  }

  await browser.close()
}

void main()
