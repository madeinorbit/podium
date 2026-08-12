import { expect, test } from '@playwright/test'
import { newSession, openApp, podium } from './_harness'

test.skip(({ isMobile }) => isMobile, 'desktop transcript-chat keyboard interaction')
test.setTimeout(90_000)

const PROMPT = 'Keep the interrupted prompt editable'

test('double Escape interrupts the native turn and recalls its prompt', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 })
  await openApp(page)
  await newSession(page, 'Claude')

  const activeTab = page.getByTestId('native-tab-strip').locator('[data-session].native-tab-active')
  await expect(activeTab).toBeVisible({ timeout: 30_000 })
  await expect.poll(() => podium.screen(page), { timeout: 30_000 }).toContain('keyecho')
  await page.getByTestId('mode-chat').locator('visible=true').click()

  const composer = page.locator('textarea[placeholder="Message the agent…"]:visible')
  await expect(composer).toBeVisible({ timeout: 30_000 })
  await composer.fill(PROMPT)
  await composer.press('Enter')
  await expect(composer).toHaveValue('')

  await page.keyboard.press('Escape')
  await page.keyboard.press('Escape')

  await expect(composer).toHaveValue(PROMPT)
  await page.getByTestId('mode-native').locator('visible=true').click()
  await expect.poll(() => podium.screen(page), { timeout: 15_000 }).toContain('[raw] 1b')
})
