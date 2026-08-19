/**
 * DOES THE DECK'S VIEW BAR FILTER ON THE PHONE? (POD-1356)
 *
 * Drives the LIVE instance's phone app (`/mobile`) in Playwright WebKit at an
 * iPhone viewport with touch, opens a mission, pulls the Flight Deck panel down
 * and taps `Needs you` — reporting the spine's rows and which segment reads as
 * selected at four moments: the deck as opened, straight after the tap, after
 * the panel is shut and pulled down again, and after a full reload.
 *
 * The reported defect is that the tap neither selects the segment nor narrows
 * the spine, so both halves are read at every step: a run where the rows change
 * while the segment stays unmarked (or the reverse) names which half is broken,
 * and a run where the tap holds but the reopen loses it names the third.
 *
 * USAGE
 *   podium auth mint-session   (pass the value via PODIUM_SESSION_COOKIE)
 *   bun run apps/mobile/e2e/pod1356-deck-filter.ts <missionIssueId>
 */
import { join } from 'node:path'
import { webkit } from 'playwright'

const [missionId = ''] = process.argv.slice(2)
const ORIGIN = process.env.P1356_ORIGIN ?? 'http://127.0.0.1:18787'
const COOKIE = process.env.PODIUM_SESSION_COOKIE ?? ''

/**
 * The deck's own content and the state of its view bar.
 *
 * Leaf text only, and only what follows the view bar: everything above it is the
 * conversation the panel is drawn over, which would bury the twenty lines this
 * is actually about.
 */
const REPORT = `() => {
  const texts = []
  for (const el of document.querySelectorAll('div,span')) {
    if (el.children.length === 0) {
      const t = (el.textContent ?? '').trim()
      if (t) texts.push(t)
    }
  }
  const segs = []
  for (const el of document.querySelectorAll('[role="button"]')) {
    const label = (el.getAttribute('aria-label') ?? '').trim()
    if (label === 'Full' || label === 'Active' || label === 'Needs you') {
      const inner = el.querySelector('div,span') ?? el
      segs.push({
        label,
        ground: getComputedStyle(el).backgroundColor,
        ink: getComputedStyle(inner).color,
      })
    }
  }
  const bar = texts.lastIndexOf('Needs you')
  const deck = bar === -1 ? texts : texts.slice(bar + 1)
  return { segs, deck: deck.slice(0, 40) }
}`

async function main(): Promise<void> {
  if (!missionId) throw new Error('usage: pod1356-deck-filter.ts <missionIssueId>')
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

  const openDeck = async (): Promise<void> => {
    const bar = page.locator('[aria-label="Flight deck"]').first()
    // A cold boot on this instance takes its time; a short wait here reads as
    // "the deck is missing" when the app is still painting the shell.
    await bar.waitFor({ timeout: 90_000 })
    await bar.tap()
    await page.waitForTimeout(1500)
  }
  /** A JS-driven RN animation can keep WebKit from ever reporting a settled
   *  frame, so a shot that times out must not take the run down with it. */
  const shoot = async (name: string): Promise<void> => {
    try {
      await page.screenshot({ path: join(import.meta.dir, `pod1356-${name}.png`), timeout: 8000 })
    } catch {
      console.log('screenshot skipped:', name)
    }
  }
  const report = async (label: string, shot: string): Promise<void> => {
    const value = (await page.evaluate(`(${REPORT})()`)) ?? null
    console.log(`\n=== ${label}\n${JSON.stringify(value, null, 1)}`)
    await shoot(shot)
  }

  await page.goto(`${ORIGIN}/mobile/mission/${encodeURIComponent(missionId)}`, {
    waitUntil: 'domcontentloaded',
  })
  await page.waitForTimeout(9000)
  await openDeck()
  await report('deck opened', 'full')

  await page.locator('[aria-label="Active"]').first().tap()
  await page.waitForTimeout(1500)
  await report('after tapping Active', 'active')

  await page.locator('[aria-label="Needs you"]').first().tap()
  await page.waitForTimeout(1500)
  await report('after tapping Needs you', 'needs-you')

  // Shut the panel and pull it down again — the first way back in.
  await page.locator('[aria-label="Flight deck"]').first().tap()
  await page.waitForTimeout(1000)
  await openDeck()
  await report('panel shut and reopened', 'reopened')

  // A cold start — the second way back in, and the one a persisted view has to
  // survive to be worth persisting.
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(8000)
  await openDeck()
  await report('after reload', 'reloaded')

  await browser.close()
}

await main()
