/**
 * IS scrollToEnd EVEN WORKING? (POD-1251)
 *
 * The feed opens at scrollTop 0 with no scroll write at all, and the app still
 * believes it is at the tail (the jump-to-newest pill stays hidden, because
 * `atTail` only ever changes in onScroll). Two candidate causes: the growth pin
 * never fires, or `scrollToEnd` is a no-op on react-native-web.
 *
 * This separates them: drag once (which makes the pill appear), tap "Newest",
 * and see whether the feed lands at the bottom. If it does, `scrollToEnd` works
 * and the opening pin is what never ran.
 *
 *   bun run apps/mobile/e2e/pod1251-jump.ts <sessionId> <label>
 */
import { chromium, type Page } from 'playwright'

const [sessionId = '', label = 'session'] = process.argv.slice(2)
const ORIGIN = process.env.P1251_ORIGIN ?? 'http://127.0.0.1:18787'
const COOKIE = process.env.PODIUM_SESSION_COOKIE ?? ''

const FEED = `[...document.querySelectorAll('div')]
  .filter((n) => { const oy = getComputedStyle(n).overflowY; return oy === 'auto' || oy === 'scroll' })
  .sort((a, b) => b.clientHeight - a.clientHeight)[0]`

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
  await page.goto(`${ORIGIN}/mobile/session/${sessionId}`, { waitUntil: 'domcontentloaded' })

  for (let i = 0; i < 60; i++) {
    const has = await page.evaluate(
      `(() => { const el = ${FEED}; return !!el && el.scrollHeight > el.clientHeight + 4 })()`,
    )
    if (has) break
    await page.waitForTimeout(500)
  }
  await page.waitForTimeout(2500)

  const geom = () =>
    page.evaluate(
      `(() => { const el = ${FEED}; return el ? { top: Math.round(el.scrollTop), sh: el.scrollHeight, ch: el.clientHeight, gap: Math.round(el.scrollHeight - el.scrollTop - el.clientHeight) } : null })()`,
    )
  const pill = () =>
    page.evaluate(`(() => {
      const el = document.querySelector('[aria-label^="Jump to"]')
      if (!el) return null
      const r = el.getBoundingClientRect()
      return { text: el.innerText.trim().slice(0, 30), x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2), visible: r.width > 0 && r.height > 0 }
    })()`) as Promise<{ text: string; x: number; y: number; visible: boolean } | null>

  console.log(`\n=== ${label} ===`)
  console.log('on open        :', JSON.stringify(await geom()))
  console.log('pill on open   :', JSON.stringify(await pill()))

  await touchDrag(page, 195, 600, -260)
  await page.waitForTimeout(900)
  console.log('after one drag :', JSON.stringify(await geom()))
  const p = await pill()
  console.log('pill after drag:', JSON.stringify(p))
  await page.screenshot({ path: `apps/mobile/e2e/pod1251-jump-${label}-1-dragged.png` })

  if (p?.visible) {
    const cdp = await page.context().newCDPSession(page)
    const pt = [{ x: p.x, y: p.y, radiusX: 8, radiusY: 8, force: 1 }]
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: pt })
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
    await cdp.detach()
    await page.waitForTimeout(1500)
    console.log('after Newest   :', JSON.stringify(await geom()))
    await page.screenshot({ path: `apps/mobile/e2e/pod1251-jump-${label}-2-newest.png` })
  }

  await browser.close()
}

void main()
