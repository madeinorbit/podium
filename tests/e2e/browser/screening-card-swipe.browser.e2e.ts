import { type CDPSession, expect, type Locator, type Page, test } from '@playwright/test'

test.skip(
  ({ isMobile, browserName }) => !isMobile || browserName !== 'chromium',
  'Pixel Chromium pointer proof',
)
test.setTimeout(120_000)

async function translateX(card: Locator) {
  return card.evaluate((element: Element) => {
    const transform = getComputedStyle(element).transform
    return transform === 'none' ? 0 : new DOMMatrixReadOnly(transform).m41
  })
}

async function detectorIsReady(card: Locator) {
  return card.evaluate((element) => {
    for (let current: Element | null = element; current; current = current.parentElement) {
      if (getComputedStyle(current).touchAction === 'none') return true
    }
    return false
  })
}

async function slowHorizontalDrag(
  cdp: CDPSession,
  page: Page,
  fromX: number,
  toX: number,
  y: number,
): Promise<void> {
  const steps = 8
  await cdp.send('Input.dispatchTouchEvent', {
    type: 'touchStart',
    touchPoints: [{ x: Math.round(fromX), y: Math.round(y) }],
  })
  for (let step = 1; step <= steps; step++) {
    await cdp.send('Input.dispatchTouchEvent', {
      type: 'touchMove',
      touchPoints: [
        { x: Math.round(fromX + ((toX - fromX) * step) / steps), y: Math.round(y) },
      ],
    })
    await page.waitForTimeout(40)
  }
}

test('screening card snap-back can be caught and reversed', async ({ page }) => {
  await page.goto('/mobile/screen-proposed?demo=1')

  const card = page.getByTestId('screening-card')
  await expect(card).toBeVisible({ timeout: 30_000 })
  await expect.poll(() => detectorIsReady(card), { timeout: 30_000 }).toBe(true)
  const firstProposal = await card.getAttribute('aria-label')
  const firstBox = await card.boundingBox()
  if (!firstBox || !firstProposal) throw new Error('screening card geometry is unavailable')

  const y = firstBox.y + firstBox.height / 2
  const firstStartX = firstBox.x + firstBox.width / 2
  const cdp = await page.context().newCDPSession(page)
  let draggedX = 0
  for (let attempt = 0; attempt < 5; attempt++) {
    await slowHorizontalDrag(cdp, page, firstStartX, firstStartX + 60, y)
    draggedX = await translateX(card)
    if (draggedX > 40) break
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
    await page.waitForTimeout(100)
  }
  expect(draggedX).toBeGreaterThan(40)
  expect(draggedX).toBeLessThan(96)
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })

  await page.waitForTimeout(50)
  const settlingX = await translateX(card)
  expect(Math.abs(settlingX)).toBeLessThan(Math.abs(draggedX) - 1)
  expect(await card.getAttribute('aria-label')).toBe(firstProposal)

  const settlingBox = await card.boundingBox()
  if (!settlingBox) throw new Error('settling card geometry is unavailable')
  const settlingY = settlingBox.y + settlingBox.height / 2
  const settlingStartX = settlingBox.x + settlingBox.width / 2
  await cdp.send('Input.dispatchTouchEvent', {
    type: 'touchStart',
    touchPoints: [{ x: Math.round(settlingStartX), y: Math.round(settlingY) }],
  })
  for (let step = 1; step <= 8; step++) {
    await cdp.send('Input.dispatchTouchEvent', {
      type: 'touchMove',
      touchPoints: [
        { x: Math.round(settlingStartX + (180 * step) / 8), y: Math.round(settlingY) },
      ],
    })
    await page.waitForTimeout(16)
  }
  // The final fast move points left, but the card remains beyond the positive
  // distance threshold. Displacement must own this decision.
  await cdp.send('Input.dispatchTouchEvent', {
    type: 'touchMove',
    touchPoints: [{ x: Math.round(settlingStartX + 120), y: Math.round(settlingY) }],
  })
  expect(await translateX(card)).toBeGreaterThan(96)
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })

  expect(await card.getAttribute('aria-label')).toBe(firstProposal)
  await expect(card).not.toHaveAttribute('aria-label', firstProposal, { timeout: 2_000 })

  const skip = page.getByRole('button', { name: 'Skip', exact: true })
  for (let remaining = 0; remaining < 10 && (await skip.isVisible()); remaining++) {
    await skip.click()
  }
  await expect(page.getByText('1 started', { exact: true })).toBeVisible()
  await expect(page.getByText('0 declined', { exact: true })).toBeVisible()
})
