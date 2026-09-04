import { expect, type Locator, type Page, test } from '@playwright/test'

test.skip(
  ({ isMobile, browserName }) => !isMobile || browserName !== 'chromium',
  'real touch-drag injection is available through Chromium CDP only',
)
test.setTimeout(120_000)

type MotionSample = { translateY: number; backdropOpacity: number }

async function motionSample(panel: Locator, backdrop: Locator): Promise<MotionSample> {
  const [translateY, backdropOpacity] = await Promise.all([
    panel.evaluate((element) => {
      const transform = getComputedStyle(element).transform
      return transform === 'none' ? 0 : new DOMMatrixReadOnly(transform).m42
    }),
    backdrop.evaluate((element) => Number.parseFloat(getComputedStyle(element).opacity)),
  ])
  return { translateY, backdropOpacity }
}

async function drag(
  page: Page,
  target: Locator,
  distanceY: number,
  sample?: () => Promise<MotionSample>,
): Promise<MotionSample[]> {
  const box = await target.boundingBox()
  if (!box) throw new Error('drag target has no box')

  const samples: MotionSample[] = []
  const x = Math.round(box.x + box.width / 2)
  const startY = Math.round(box.y + box.height / 2)
  const cdp = await page.context().newCDPSession(page)
  await cdp.send('Input.dispatchTouchEvent', {
    type: 'touchStart',
    touchPoints: [{ x, y: startY }],
  })
  for (let step = 1; step <= 12; step += 1) {
    await cdp.send('Input.dispatchTouchEvent', {
      type: 'touchMove',
      touchPoints: [{ x, y: Math.round(startY + (distanceY * step) / 12) }],
    })
    await page.waitForTimeout(16)
    if (sample) samples.push(await sample())
  }
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
  return samples
}

// Expo web runs these worklets on the browser main thread, so blocking JS here
// cannot prove native UI-runtime independence. This suite instead proves the
// real touch route and samples transform/backdrop progress before touchEnd.
test('Expo sheets and the mission deck follow a real finger and settle', async ({ page }) => {
  await page.goto('/mobile/mission/demo-mission-root?demo=1')

  const missionActions = page.getByRole('button', { name: 'Mission actions' })
  await expect(missionActions).toBeVisible({ timeout: 30_000 })
  await missionActions.click()

  const cancel = page.getByRole('button', { name: 'Cancel' })
  await expect(cancel).toBeVisible()
  const sheet = page.getByTestId('mission-actions-sheet')
  const sheetBackdrop = page.getByTestId('mission-actions-sheet-backdrop')
  await expect
    .poll(async () => {
      const sample = await motionSample(sheet, sheetBackdrop)
      return Math.abs(sample.translateY) < 5 && sample.backdropOpacity > 0.5
    })
    .toBe(true)
  const sheetStart = await motionSample(sheet, sheetBackdrop)
  const sheetSamples = await drag(
    page,
    page.getByText('POD-554 Host resource lifecycle policy'),
    360,
    () => motionSample(sheet, sheetBackdrop),
  )
  expect(Math.max(...sheetSamples.map((sample) => sample.translateY))).toBeGreaterThan(
    sheetStart.translateY + 80,
  )
  expect(Math.min(...sheetSamples.map((sample) => sample.backdropOpacity))).toBeLessThan(
    sheetStart.backdropOpacity - 0.05,
  )
  await expect(cancel).toBeHidden()

  const deck = page.getByRole('button', { name: 'Flight deck' })
  const panel = page.getByTestId('mission-deck-panel')
  const panelBackdrop = page.getByTestId('mission-deck-backdrop')
  const panelStart = await motionSample(panel, panelBackdrop)
  expect(panelStart.translateY).toBeLessThan(-80)
  const panelSamples = await drag(page, deck, 360, () => motionSample(panel, panelBackdrop))
  expect(Math.max(...panelSamples.map((sample) => sample.translateY))).toBeGreaterThan(
    panelStart.translateY + 80,
  )
  expect(Math.max(...panelSamples.map((sample) => sample.backdropOpacity))).toBeGreaterThan(
    panelStart.backdropOpacity + 0.05,
  )
  await expect
    .poll(async () => (await motionSample(panel, panelBackdrop)).translateY)
    .toBeGreaterThan(-5)
  await expect(panel.getByText('Worktree GC janitor sweep')).toBeVisible()
})
