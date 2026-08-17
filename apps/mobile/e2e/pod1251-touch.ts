/**
 * PHONE TOUCH-SCROLL PROBE (POD-1251).
 *
 * "A hibernated session blocks the transcript from scrolling" is a claim about a
 * FINGER, and neither Playwright's touchscreen API nor mobile WebKit can drag
 * one. Chromium + CDP `Input.dispatchTouchEvent` can, and it produces real
 * compositor scrolling, so this rig answers the question instead of approximating
 * it.
 *
 * THE RIG IS VALIDATED BEFORE IT IS BELIEVED (positive control): it first drags a
 * plain scrollable div on a data: page. If that does not move, nothing this
 * script reports about the app means anything, and it says so and exits.
 *
 *   bun run apps/mobile/e2e/pod1251-touch.ts <sessionId> <label>
 */
import { chromium, type Page } from 'playwright'

const [sessionId = '', label = 'session'] = process.argv.slice(2)
const ORIGIN = process.env.P1251_ORIGIN ?? 'http://127.0.0.1:18787'
const COOKIE = process.env.PODIUM_SESSION_COOKIE ?? ''

/** One finger, pressed at (x, y), dragged by `dy` in `steps`, then lifted. */
async function touchDrag(page: Page, x: number, y: number, dy: number, steps = 12): Promise<void> {
  const cdp = await page.context().newCDPSession(page)
  const at = (yy: number) => [{ x, y: yy, radiusX: 12, radiusY: 12, force: 1 }]
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: at(y) })
  for (let i = 1; i <= steps; i++) {
    await cdp.send('Input.dispatchTouchEvent', {
      type: 'touchMove',
      touchPoints: at(y + (dy * i) / steps),
    })
    await page.waitForTimeout(16)
  }
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
  await cdp.detach()
}

const FEED = `[...document.querySelectorAll('div')]
  .filter((n) => { const oy = getComputedStyle(n).overflowY; return oy === 'auto' || oy === 'scroll' })
  .sort((a, b) => b.clientHeight - a.clientHeight)[0]`

async function main(): Promise<void> {
  const browser = await chromium.launch()
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true,
  })

  // ---- positive control: the rig must be able to scroll a plain div ----------
  const control = await context.newPage()
  await control.setContent(
    `<div id="s" style="height:400px;overflow:auto;-webkit-overflow-scrolling:touch">
       <div style="height:4000px;background:linear-gradient(#111,#999)"></div>
     </div>`,
  )
  await touchDrag(control, 195, 300, -200)
  await control.waitForTimeout(500)
  const controlTop = await control.evaluate(
    () => (document.getElementById('s') as HTMLElement).scrollTop,
  )
  console.log(`positive control scrollTop after drag: ${controlTop}`)
  if (controlTop <= 0) {
    console.log('RIG INVALID — a plain div did not scroll; nothing below is evidence.')
    await browser.close()
    return
  }
  await control.close()

  // ---- the app --------------------------------------------------------------
  if (COOKIE) {
    await context.addCookies([
      { name: 'podium_session', value: COOKIE, domain: '127.0.0.1', path: '/' },
    ])
  }
  const page = await context.newPage()
  await page.goto(`${ORIGIN}/mobile/session/${sessionId}`, { waitUntil: 'domcontentloaded' })

  const t0 = Date.now()
  let overflowedAt: number | null = null
  for (let i = 0; i < 60; i++) {
    const has = await page.evaluate(
      `(() => { const el = ${FEED}; return !!el && el.scrollHeight > el.clientHeight + 4 })()`,
    )
    if (has) {
      overflowedAt = Date.now() - t0
      break
    }
    await page.waitForTimeout(500)
  }
  console.log(`\n=== ${label} (${sessionId}) ===`)
  console.log(
    `transcript overflowed after ${overflowedAt === null ? 'NEVER (30s)' : `${overflowedAt}ms`}`,
  )
  await page.waitForTimeout(2000)

  const geom = () =>
    page.evaluate(
      `(() => { const el = ${FEED}; return el ? { top: Math.round(el.scrollTop), sh: el.scrollHeight, ch: el.clientHeight } : null })()`,
    ) as Promise<{ top: number; sh: number; ch: number } | null>

  console.log('on open         :', JSON.stringify(await geom()))
  await page.screenshot({ path: `apps/mobile/e2e/pod1251-touch-${label}-1-open.png` })

  // Finger up = read forward (content scrolls up).
  await touchDrag(page, 195, 600, -300)
  await page.waitForTimeout(700)
  console.log('after finger-up :', JSON.stringify(await geom()))
  await page.screenshot({ path: `apps/mobile/e2e/pod1251-touch-${label}-2-up.png` })

  // Finger down = read back.
  await touchDrag(page, 195, 300, 250)
  await page.waitForTimeout(700)
  console.log('after finger-dn :', JSON.stringify(await geom()))

  // And the same scroller driven directly: proves the element itself is movable,
  // separating "the gesture is eaten" from "the box cannot scroll".
  const scripted = await page.evaluate(
    `(() => { const el = ${FEED}; if (!el) return null; el.scrollTop = 600; return Math.round(el.scrollTop) })()`,
  )
  console.log('scripted scrollTop = 600 ->', scripted)
  await page.screenshot({ path: `apps/mobile/e2e/pod1251-touch-${label}-3-scripted.png` })

  await browser.close()
}

void main()
