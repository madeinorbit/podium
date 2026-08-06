import { mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { expect, type Page, test } from '@playwright/test'

test.skip(
  ({ isMobile, browserName }) => !isMobile || browserName !== 'chromium',
  'real touch-drag injection is available through Chromium CDP only',
)
test.setTimeout(120_000)

const ARTIFACTS = resolve(import.meta.dirname, '../../../.artifacts/POD-504')

async function realFingerPull(page: Page, screenshot?: string): Promise<void> {
  const boundary = page.locator('[data-pull-to-refresh]').first()
  await expect(boundary).toBeVisible({ timeout: 30_000 })
  await expect(boundary.getByRole('button', { name: 'Refresh list' })).toBeAttached()

  // Chat transcripts open at the tail. A person scrolls to the top before
  // pulling; do that setup directly so the gesture itself remains a genuine
  // compositor touch stream rather than a synthetic DOM PointerEvent.
  await boundary.evaluate((element) => {
    for (const candidate of element.querySelectorAll<HTMLElement>('*')) {
      if (['auto', 'scroll'].includes(getComputedStyle(candidate).overflowY)) {
        candidate.scrollTop = 0
      }
    }
  })

  const box = await boundary.boundingBox()
  if (!box) throw new Error('pull boundary has no box')
  const x = Math.round(box.x + box.width / 2)
  const startY = Math.round(box.y + Math.min(44, box.height * 0.2))
  const endY = Math.round(Math.min(box.y + box.height - 8, startY + 150))
  const cdp = await page.context().newCDPSession(page)
  await cdp.send('Input.dispatchTouchEvent', {
    type: 'touchStart',
    touchPoints: [{ x, y: startY }],
  })
  for (let step = 1; step <= 10; step++) {
    await cdp.send('Input.dispatchTouchEvent', {
      type: 'touchMove',
      touchPoints: [{ x, y: Math.round(startY + ((endY - startY) * step) / 10) }],
    })
  }

  const indicator = boundary.locator('[data-pull-to-refresh-indicator]')
  await expect(indicator).toContainText('Release to refresh')
  if (screenshot) await page.screenshot({ path: resolve(ARTIFACTS, screenshot) })
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
  await expect(indicator).toContainText('Checking for updates', { timeout: 500 })
  expect(await page.evaluate(() => ({ x: scrollX, y: scrollY }))).toEqual({ x: 0, y: 0 })
}

test('installed-mode PWA lists visibly answer a compositor finger pull', async ({ page }) => {
  mkdirSync(ARTIFACTS, { recursive: true })
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'standalone', { configurable: true, value: true })
  })

  const surfaces = [
    { route: '/mobile?demo=1', screenshot: 'tray-pull.png' },
    { route: '/mobile/work?demo=1', screenshot: 'work-pull.png' },
    { route: '/mobile/issues?demo=1', screenshot: 'tasks-pull.png' },
    { route: '/mobile/superagent?demo=1' },
    { route: '/mobile/session/demo-auth?demo=1', screenshot: 'session-pull.png' },
  ]

  for (const surface of surfaces) {
    await page.goto(surface.route)
    await realFingerPull(page, surface.screenshot)
  }
})
