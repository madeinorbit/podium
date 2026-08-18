/**
 * SHOOT THE CRASH SCREEN'S DISCLOSURE (POD-1298).
 *
 * Drives harness/errorpage-entry.tsx, which renders the SHIPPING AppErrorPage
 * against the SHIPPING stylesheet. Four shots: closed and open, each with the
 * chevron and without it (`?bare=1`, the pre-fix control).
 *
 * Each shot is an assertion as well as a picture — the run FAILS if the thing
 * it claims to show is not on screen, and it fails if the control is
 * indistinguishable from the real thing, because a harness that cannot see the
 * old bug cannot be trusted to have seen the fix.
 *
 *   bunx vite --config vite.errorpage.config.ts   # in apps/web
 *   bunx tsx e2e/pod1298-errorpage-shots.ts       # also in apps/web — OUT is
 *                                                # relative, and the shots live
 *                                                # beside this script.
 */
import { chromium, type Page } from 'playwright'

const URL_ = 'http://localhost:55597/errorpage-harness.html'
const OUT = 'e2e'

async function shootSummary(page: Page, name: string): Promise<void> {
  await page.locator('details').screenshot({ path: `${OUT}/${name}.png` })
}

async function main(): Promise<void> {
  const browser = await chromium.launch()
  const page = await browser.newPage({
    viewport: { width: 760, height: 620 },
    deviceScaleFactor: 2,
  })
  const errs: string[] = []
  page.on('pageerror', (e) => errs.push(e.message))

  // 1 + 2 — the shipping screen, shut and unfolded.
  await page.goto(URL_, { waitUntil: 'networkidle' })
  await page.waitForSelector('details')
  const chevron = page.locator('summary svg')
  if (!(await chevron.count())) throw new Error('no chevron in the shipping summary')
  await page.screenshot({ path: `${OUT}/pod1298-1-page-closed.png` })
  await shootSummary(page, 'pod1298-2-summary-closed')

  const closedBox = await chevron.boundingBox()
  await page.locator('summary').click()
  await page.waitForFunction(() => document.querySelector('details')?.open === true)
  await page.waitForTimeout(300) // let the rotation settle before the shot
  const openBox = await chevron.boundingBox()
  await shootSummary(page, 'pod1298-3-summary-open')
  await page.screenshot({ path: `${OUT}/pod1298-4-page-open.png` })

  // The chevron must actually TURN. Tailwind v4's `rotate-90` sets the `rotate`
  // property, not `transform` — reading `transform` here returns "none" even
  // when the chevron is visibly on its side, which is exactly the false failure
  // this rig reported on its first run.
  const turn = await chevron.evaluate((el) => getComputedStyle(el).rotate)
  if (turn === 'none') throw new Error('chevron does not rotate when the details open')
  if (!closedBox || !openBox) throw new Error('chevron has no box')

  // 3 — the control: the same page with the chevron pulled back out. This is
  // what the user photographed, and the proof this harness can see a difference.
  await page.goto(`${URL_}?bare=1`, { waitUntil: 'networkidle' })
  await page.waitForSelector('details')
  await page.waitForFunction(() => !document.querySelector('summary svg'))
  await shootSummary(page, 'pod1298-5-summary-bare-control')

  if (errs.length) throw new Error(`page errors: ${errs.join('; ')}`)
  console.log(`ok — chevron rotation when open: ${turn}`)
  await browser.close()
}

void main()
