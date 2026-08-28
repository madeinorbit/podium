import { expect, test } from '@playwright/test'

test.skip(
  ({ isMobile, browserName }) => !isMobile || browserName !== 'chromium',
  'Pixel Chromium touch proof',
)
test.setTimeout(60_000)

test('Expo pull to refresh coalesces touch travel without losing its status', async ({ page }) => {
  await page.goto('/mobile/session/demo-perf?demo=1')

  const boundary = page.locator('[data-pull-to-refresh]')
  const indicator = page.locator('[data-pull-to-refresh-indicator]')
  await expect(boundary).toBeVisible({ timeout: 30_000 })

  const result = await boundary.evaluate(async (element) => {
    const target = element as HTMLElement
    const originalRequestAnimationFrame = window.requestAnimationFrame.bind(window)
    let scheduledFrames = 0
    window.requestAnimationFrame = (callback) => {
      scheduledFrames += 1
      return originalRequestAnimationFrame(callback)
    }

    const touchAt = (clientY: number) =>
      new Touch({
        identifier: 14,
        target,
        clientX: 100,
        clientY,
      })
    const start = touchAt(20)
    target.dispatchEvent(
      new TouchEvent('touchstart', {
        bubbles: true,
        cancelable: true,
        touches: [start],
        targetTouches: [start],
        changedTouches: [start],
      }),
    )

    let movePrevented = false
    for (const clientY of [45, 70, 95, 120, 145, 170]) {
      const touch = touchAt(clientY)
      const move = new TouchEvent('touchmove', {
        bubbles: true,
        cancelable: true,
        touches: [touch],
        targetTouches: [touch],
        changedTouches: [touch],
      })
      target.dispatchEvent(move)
      movePrevented ||= move.defaultPrevented
    }

    window.requestAnimationFrame = originalRequestAnimationFrame
    await new Promise<void>((resolve) => originalRequestAnimationFrame(() => resolve()))

    return {
      movePrevented,
      scheduledFrames,
      opacity: (target.querySelector('[data-pull-to-refresh-indicator]') as HTMLElement).style
        .opacity,
      transform: (target.querySelector('[data-pull-to-refresh-indicator]') as HTMLElement).style
        .transform,
    }
  })

  expect(result).toEqual({
    movePrevented: true,
    scheduledFrames: 1,
    opacity: '1',
    transform: 'translate(-50%, 29.5px)',
  })
  await expect(indicator).toContainText('Release to refresh')
})
