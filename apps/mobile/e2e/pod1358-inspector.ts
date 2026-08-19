/**
 * TASK-INSPECTOR SCROLL PROBE (POD-1358).
 *
 * "The task inspector is unscrollable with long content" is a claim about a
 * FINGER on a sheet, so this drives one: Chromium + CDP `Input.dispatchTouchEvent`
 * at an iPhone viewport, against THIS branch's export served by pod1251-serve.
 *
 * THE RIG IS VALIDATED BEFORE IT IS BELIEVED (positive control): it first drags a
 * plain overflowing div on a data: page. A zero there means the instrument is
 * broken and nothing below is evidence.
 *
 * It then opens the inspector on a long issue and reports, at BOTH detents:
 *   - the sheet's own transform (did the drag promote it?)
 *   - the inner scroller's scrollHeight/clientHeight/scrollTop and touch-action
 *   - whether a finger dragged on the CONTENT moved either one
 *
 *   PODIUM_SESSION_COOKIE=… bun run apps/mobile/e2e/pod1358-inspector.ts <issueId>
 */
import { chromium, type Page } from 'playwright'

const issueId = process.argv[2] ?? ''
const ORIGIN = process.env.P1358_ORIGIN ?? 'http://127.0.0.1:8134'
const COOKIE = process.env.PODIUM_SESSION_COOKIE ?? ''
const OUT = 'apps/mobile/e2e/pod1358'

async function touchDrag(page: Page, x: number, y: number, dy: number, steps = 14): Promise<void> {
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

/** Everything the sheet's scroll state is decided from, read from the DOM. */
function report() {
  const sheet = document.querySelector('[data-testid="task-sheet"]')
  if (!sheet) return { sheet: null, scrollers: [] }
  const r = sheet.getBoundingClientRect()
  const scrollers = [...sheet.querySelectorAll('div')]
    .map((el) => ({ el, s: getComputedStyle(el) }))
    .filter(
      ({ s }) => s.overflowY === 'auto' || s.overflowY === 'scroll' || s.overflowY === 'hidden',
    )
    .map(({ el, s }) => ({
      overflowY: s.overflowY,
      touchAction: s.touchAction,
      sh: el.scrollHeight,
      ch: el.clientHeight,
      top: Math.round(el.scrollTop),
      rectTop: Math.round(el.getBoundingClientRect().top),
      rectBottom: Math.round(el.getBoundingClientRect().bottom),
    }))
    .filter((s) => s.sh > 120 && s.ch > 80)
  return {
    sheet: {
      transform: getComputedStyle(sheet).transform,
      top: Math.round(r.top),
      bottom: Math.round(r.bottom),
      height: Math.round(r.height),
    },
    viewport: { h: window.innerHeight },
    scrollers,
  }
}

async function shot(page: Page, name: string, label: string): Promise<void> {
  await page.screenshot({ path: `${OUT}-${name}.png` })
  console.log(`\n--- ${label} ---`)
  console.log(JSON.stringify(await page.evaluate(report), null, 2))
}

async function main(): Promise<void> {
  const browser = await chromium.launch()
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true,
  })

  // ---- positive control ------------------------------------------------------
  const control = await context.newPage()
  await control.setContent(
    `<div id="s" style="height:400px;overflow:auto">
       <div style="height:4000px;background:linear-gradient(#111,#999)"></div>
     </div>`,
  )
  await touchDrag(control, 195, 300, -200)
  await control.waitForTimeout(400)
  const controlTop = await control.evaluate(
    () => (document.getElementById('s') as HTMLElement).scrollTop,
  )
  console.log(`positive control scrollTop after an upward drag: ${controlTop}`)
  if (controlTop <= 0) {
    console.log('RIG INVALID — a plain div did not scroll; nothing below is evidence.')
    await browser.close()
    return
  }
  await control.close()

  // ---- the app ---------------------------------------------------------------
  if (COOKIE) {
    await context.addCookies([
      { name: 'podium_session', value: COOKIE, domain: '127.0.0.1', path: '/' },
    ])
  }
  const page = await context.newPage()
  page.on('console', (m) => {
    if (m.type() === 'error') console.log(`  [console] ${m.text().slice(0, 160)}`)
  })
  await page.goto(`${ORIGIN}/mobile/mission/${encodeURIComponent(issueId)}`, {
    waitUntil: 'domcontentloaded',
  })

  await page.waitForSelector('[aria-label="Mission actions"]', { timeout: 45_000 })
  await page.waitForTimeout(1200)
  await page.click('[aria-label="Mission actions"]')
  await page.waitForTimeout(900)
  await page.click('text=Inspect task', { force: true })
  await page.waitForTimeout(1200)
  await shot(page, '1-medium', 'inspector at MEDIUM (as opened)')

  // A finger dragged UP on the content, well below the head.
  await touchDrag(page, 195, 700, -260)
  await page.waitForTimeout(700)
  await shot(page, '2-content-drag-medium', 'after an upward finger on the CONTENT (medium)')

  // Promote deliberately by dragging the head, then try the content again.
  const headY = await page.evaluate(() => {
    const sheet = document.querySelector('[data-testid="task-sheet"]')
    return sheet ? Math.round(sheet.getBoundingClientRect().top) + 14 : 0
  })
  await touchDrag(page, 195, headY, -320)
  await page.waitForTimeout(900)
  await shot(page, '3-large', 'after dragging the HEAD upward (should be large)')

  await touchDrag(page, 195, 600, -320)
  await page.waitForTimeout(700)
  await shot(page, '4-content-drag-large', 'after an upward finger on the CONTENT (large)')

  // ---- the other directions, so the promote half did not cost anything ------
  // A tiny travel on the content is a ROW's press, never the sheet's toggle.
  await touchDrag(page, 195, 300, -3, 2)
  await page.waitForTimeout(500)
  await shot(page, '5-tap-content', 'after a tap-sized touch on the CONTENT (large)')

  // Reopen at medium and drag the content DOWN: the sheet should leave.
  await page.keyboard.press('Escape')
  await page.waitForTimeout(700)
  await page.click('[aria-label="Mission actions"]')
  await page.waitForTimeout(900)
  await page.click('text=Inspect task', { force: true })
  await page.waitForTimeout(1200)
  await shot(page, '6-reopened-medium', 'reopened at MEDIUM')
  await touchDrag(page, 195, 700, 260)
  await page.waitForTimeout(1000)
  await shot(page, '7-content-drag-down', 'after a DOWNWARD finger on the CONTENT (medium)')

  await browser.close()
}

void main()
