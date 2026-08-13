import { expect, test } from '@playwright/test'
import { newSession, openApp } from './_harness'

test.setTimeout(90_000)

type ShortcutWindow = Window & {
  __PODIUM_FOCUS_SESSION_PROMPT__?: () => void
  __PODIUM_TOGGLE_SESSION_VIEW__?: () => void
}

test('native menu hooks focus session prompts and toggle views', async ({ page }) => {
  await openApp(page)
  await newSession(page, 'Codex')

  const nativeTab = page.locator('[data-testid="mode-native"]:visible')
  await expect(nativeTab).toHaveAttribute('aria-selected', 'true')
  await page.evaluate(() => (window as ShortcutWindow).__PODIUM_FOCUS_SESSION_PROMPT__?.())
  await expect(page.locator('.xterm-helper-textarea:visible')).toBeFocused()

  await page.evaluate(() => (window as ShortcutWindow).__PODIUM_TOGGLE_SESSION_VIEW__?.())
  const chatTab = page.locator('[data-testid="mode-chat"]:visible')
  await expect(chatTab).toHaveAttribute('aria-selected', 'true')
  await page.evaluate(() => (window as ShortcutWindow).__PODIUM_FOCUS_SESSION_PROMPT__?.())
  await expect(page.locator('.chat-composer-well textarea')).toBeFocused()

  await page.evaluate(() => (window as ShortcutWindow).__PODIUM_TOGGLE_SESSION_VIEW__?.())
  await expect(nativeTab).toHaveAttribute('aria-selected', 'true')
})
