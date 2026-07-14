import { expect, type Page, test } from '@playwright/test'

async function animationNames(page: Page): Promise<string[]> {
  return page
    .getByTestId('motion-row')
    .evaluate((element) =>
      element
        .getAnimations({ subtree: true })
        .map((animation) =>
          animation instanceof CSSAnimation ? animation.animationName : animation.constructor.name,
        ),
    )
}

test('real app: spinner persists while one-shot morphs settle and timer flips to ago', async ({
  page,
}, testInfo) => {
  await page.goto('/?e2e=1&motion-demo=1')
  await expect(page.getByRole('heading', { name: 'Motion primitives' })).toBeVisible()
  await expect(page.getByTestId('phase-label')).toHaveText('QUEUED')
  await expect.poll(() => animationNames(page)).toEqual([])

  await page.getByRole('button', { name: 'Start work' }).click()
  await expect(page.getByTestId('phase-label')).toHaveText('WORKING')
  await expect(page.locator('.motion-demo-timer .spb')).toBeVisible()
  await expect
    .poll(() => animationNames(page))
    .toEqual(expect.arrayContaining(['podium-spb', 'podium-ignite', 'podium-tick-in']))

  const timer = page.locator('.motion-demo-timer')
  const firstClock = await timer.textContent()
  await expect.poll(() => timer.textContent(), { timeout: 3_000 }).not.toBe(firstClock)

  await page.waitForTimeout(1_100)
  await expect.poll(() => animationNames(page)).toEqual(['podium-spb', 'podium-spb'])

  await page.getByRole('button', { name: 'Unrelated rerender' }).click()
  await expect(page.getByTestId('revision')).toHaveText('1')
  await expect.poll(() => animationNames(page)).toEqual(['podium-spb', 'podium-spb'])

  await page.getByRole('button', { name: 'Needs input' }).click()
  await expect(page.getByTestId('phase-label')).toHaveText('WAITING ON YOU')
  await expect(page.locator('.spb')).toHaveCount(0)
  await expect(timer).toHaveText('just now')
  await expect
    .poll(() => animationNames(page))
    .toEqual(expect.arrayContaining(['podium-row-flash', 'podium-pop-in', 'podium-flip-ago']))

  await page.waitForTimeout(1_100)
  await expect.poll(() => animationNames(page)).toEqual([])
  await page.getByRole('button', { name: 'Unrelated rerender' }).click()
  await expect(page.getByTestId('revision')).toHaveText('2')
  await expect.poll(() => animationNames(page)).toEqual([])

  await page.screenshot({ path: testInfo.outputPath('motion-waiting.png'), fullPage: true })

  await page.getByRole('button', { name: 'Complete' }).click()
  await expect(page.getByTestId('phase-label')).toHaveText('DONE')
  await expect(timer).toHaveText('∑ 0:12')
  await expect.poll(() => animationNames(page)).toContain('podium-pop-in')
  await page.waitForTimeout(600)
  await expect.poll(() => animationNames(page)).toEqual([])
})

test('real app: reduced motion freezes the spinner and removes morphs', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.goto('/?e2e=1&motion-demo=1')
  await page.getByRole('button', { name: 'Start work' }).click()
  await expect(page.locator('.motion-demo-timer .spb')).toBeVisible()
  await expect.poll(() => animationNames(page)).toEqual([])
  await page.getByRole('button', { name: 'Needs input' }).click()
  await expect(page.locator('.spb')).toHaveCount(0)
  await expect(page.locator('.motion-demo-timer')).toHaveText('just now')
  await expect.poll(() => animationNames(page)).toEqual([])
})
