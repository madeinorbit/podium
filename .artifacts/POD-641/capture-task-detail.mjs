/**
 * Runtime capture for the POD-641 polish pass.
 *
 * Navigates straight to the issue URL rather than hunting for a board card:
 * the card's title and board placement change as the task moves, and the
 * capture should not fail for a reason that has nothing to do with the pixels
 * it is checking.
 *
 * Usage: bun .artifacts/POD-641/capture-task-detail.mjs
 * Requires a dev server on 127.0.0.1:4318 built from THIS worktree.
 */
import { chromium } from '@playwright/test'

const ISSUE_URL =
  'http://127.0.0.1:4318/issues/iss_cac76cc0-afed-447f-8425-c1095c4c695f?e2e=1'

const auth = Bun.spawnSync(['podium', 'auth', 'mint-session', '--print-only', '--ttl', '10m'])
if (auth.exitCode !== 0) throw new Error(new TextDecoder().decode(auth.stderr))
const token = new TextDecoder().decode(auth.stdout).trim()

const browser = await chromium.launch({ headless: true })

/** One viewport's worth of evidence. */
async function shoot(label, width, height) {
  const context = await browser.newContext({
    viewport: { width, height },
    deviceScaleFactor: 1,
  })
  await context.addCookies([
    { name: 'podium_session', value: token, url: 'http://127.0.0.1:4318' },
  ])
  const page = await context.newPage()
  await page.goto(ISSUE_URL, { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('[data-testid="issue-page"]', { timeout: 60_000 })
  await page.waitForTimeout(1800)

  const metrics = await page.evaluate(() => {
    const measure = (element) => {
      if (!(element instanceof HTMLElement)) return null
      const style = getComputedStyle(element)
      const rect = element.getBoundingClientRect()
      return {
        width: Math.round(rect.width),
        fontSize: style.fontSize,
        lineHeight: style.lineHeight,
        letterSpacing: style.letterSpacing,
      }
    }
    const byText = (selector, text) =>
      [...document.querySelectorAll(selector)].find((el) => el.textContent?.trim() === text)

    // Every machine-voice label on the page must agree on one size — the
    // regression this pass is guarding against is them drifting apart.
    const labels = [...document.querySelectorAll('span, h3')]
      .filter((el) => getComputedStyle(el).textTransform === 'uppercase')
      .filter((el) => getComputedStyle(el).fontFamily.toLowerCase().includes('mono'))
      .map((el) => ({
        text: el.textContent?.trim().slice(0, 24),
        fontSize: getComputedStyle(el).fontSize,
      }))

    return {
      url: location.href,
      aside: measure(document.querySelector('[data-testid="issue-aside"]')),
      now: measure(document.querySelector('[data-testid="issue-now"]')),
      status: document.querySelector('[data-testid="status-strip"]')?.textContent?.trim(),
      nowRows: document.querySelector('[data-testid="issue-now"]')?.querySelectorAll('button')
        .length,
      relationsLabel: measure(byText('span', 'Blocks') ?? byText('span', 'Discovered from')),
      machineLabels: labels,
      docScrollWidth: document.documentElement.scrollWidth,
    }
  })

  const cdp = await context.newCDPSession(page)
  const capture = async (path) => {
    const shot = await cdp.send('Page.captureScreenshot', {
      format: 'png',
      captureBeyondViewport: false,
    })
    await Bun.write(path, Buffer.from(shot.data, 'base64'))
  }

  await capture(`.artifacts/POD-641/task-detail-${label}-top.png`)

  await page.evaluate(() => {
    const root = document.querySelector('[data-testid="issue-page"]')
    const scroller = [...(root?.querySelectorAll('div') ?? [])].find(
      (element) => getComputedStyle(element).overflowY === 'auto',
    )
    if (scroller instanceof HTMLElement) scroller.scrollTop = scroller.scrollHeight
  })
  await page.waitForTimeout(600)
  await capture(`.artifacts/POD-641/task-detail-${label}-activity.png`)

  await context.close()
  return metrics
}

const out = {
  wide: await shoot('after', 1976, 1232),
  narrow: await shoot('narrow', 900, 1000),
}
await Bun.write('.artifacts/POD-641/task-detail-after.json', JSON.stringify(out, null, 2))
console.log(JSON.stringify(out, null, 2))
await browser.close()
