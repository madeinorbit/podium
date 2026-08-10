/**
 * Runtime capture for the POD-634 board polish.
 *
 * Drives a dev server built from THIS worktree against the live backend, so the
 * board carries the operator's real tasks — the only content that shows what a
 * column of 40 cards actually reads like.
 *
 * Usage: bun .artifacts/POD-634/capture-board.mjs <label>
 * Requires: PODIUM_WEB_PORT=4318 bun run dev  (in apps/web)
 */
import { chromium } from '@playwright/test'

const label = process.argv[2] ?? 'before'
const ORIGIN = 'http://127.0.0.1:4318'
const OUT = '.artifacts/POD-634'

const auth = Bun.spawnSync(['podium', 'auth', 'mint-session', '--print-only', '--ttl', '15m'])
if (auth.exitCode !== 0) throw new Error(new TextDecoder().decode(auth.stderr))
const token = new TextDecoder().decode(auth.stdout).trim()

const browser = await chromium.launch({ headless: true })

async function open(width, height) {
  const context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 2 })
  await context.addCookies([{ name: 'podium_session', value: token, url: ORIGIN }])
  const page = await context.newPage()
  await page.goto(`${ORIGIN}/issues?e2e=1`, { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('[data-testid="issues-board"], [data-testid="issue-column"]', {
    timeout: 60_000,
  })
  await page.waitForTimeout(2500)
  return { context, page }
}

/** Computed geometry, so a spacing claim is measured rather than eyeballed. */
async function metrics(page) {
  return page.evaluate(() => {
    const px = (v) => Math.round(Number.parseFloat(v) * 100) / 100
    const columns = [...document.querySelectorAll('[data-testid="issue-column"]')]
    const busiest = columns
      .map((c) => ({ c, n: c.querySelectorAll('[data-issue-id]').length }))
      .sort((a, b) => b.n - a.n)[0]
    if (!busiest) return null
    const column = busiest.c
    const cards = [...column.querySelectorAll('[data-issue-id]')]
    const [first, second] = cards
    const cs = (el) => getComputedStyle(el)
    const header = column.querySelector('h3')?.parentElement
    const body = column.querySelector('[data-issue-id]')?.closest('div[class*="overflow-y-auto"]')
    const title = first?.querySelector('[class*="line-clamp"]')
    return {
      columns: columns.length,
      columnWidth: px(cs(column).width),
      headerHeight: header ? px(cs(header).height) : null,
      headerPadX: header ? [cs(header).paddingLeft, cs(header).paddingRight] : null,
      bodyPad: body
        ? [cs(body).paddingTop, cs(body).paddingRight, cs(body).paddingBottom, cs(body).paddingLeft]
        : null,
      cardGap:
        first && second
          ? px(second.getBoundingClientRect().top - first.getBoundingClientRect().bottom)
          : null,
      cardPad: first
        ? [cs(first).paddingTop, cs(first).paddingRight, cs(first).paddingBottom, cs(first).paddingLeft]
        : null,
      cardRadius: first ? cs(first).borderRadius : null,
      cardHeight: first ? px(first.getBoundingClientRect().height) : null,
      cardInnerGap: first ? cs(first).rowGap : null,
      titleFont: title ? [cs(title).fontSize, cs(title).lineHeight, cs(title).fontWeight] : null,
      titleColor: title ? cs(title).color : null,
    }
  })
}

const shots = []
{
  const { context, page } = await open(1728, 1000)
  console.log(`metrics@1728 ${JSON.stringify(await metrics(page), null, 1)}`)
  await page.screenshot({ path: `${OUT}/board-${label}-wide.png` })
  shots.push('wide')

  // Hover + focus states on one card, so the resting/active delta is visible.
  const card = page.locator('[data-issue-id]').nth(1)
  await card.hover()
  await page.waitForTimeout(400)
  await page.screenshot({ path: `${OUT}/board-${label}-hover.png` })
  shots.push('hover')
  await context.close()
}
{
  const { context, page } = await open(1180, 900)
  await page.screenshot({ path: `${OUT}/board-${label}-narrow.png` })
  shots.push('narrow')
  await context.close()
}
await browser.close()
console.log(`captured ${shots.join(', ')} as ${label}`)
