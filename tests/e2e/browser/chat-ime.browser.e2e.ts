import { expect, test } from '@playwright/test'
import { newSession, openApp } from './_harness'

test.skip(({ isMobile }) => isMobile, 'desktop chat composer behavior')

test('chat composer waits for IME composition to end before sending', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 })
  await openApp(page)
  await newSession(page, 'Claude')

  await page.locator('[data-testid="mode-chat"]:visible').click()
  const composer = page.locator('textarea[placeholder="Message the agent…"]:visible')
  await expect(composer).toBeVisible({ timeout: 30_000 })

  const text = `IME draft 日本語 ${Date.now()}`
  await composer.fill(text)
  await composer.evaluate((node) => {
    node.dispatchEvent(
      new CompositionEvent('compositionstart', { bubbles: true, data: node.value }),
    )
    for (const modifiers of [{}, { ctrlKey: true }, { metaKey: true }]) {
      node.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'Enter',
          code: 'Enter',
          bubbles: true,
          cancelable: true,
          isComposing: true,
          ...modifiers,
        }),
      )
    }

    // Safari/WebKit can clear isComposing before the candidate-confirming
    // keydown reaches React, while retaining the conventional IME keyCode.
    const legacyEnter = new KeyboardEvent('keydown', {
      key: 'Enter',
      code: 'Enter',
      ctrlKey: true,
      bubbles: true,
      cancelable: true,
    })
    Object.defineProperty(legacyEnter, 'keyCode', { value: 229 })
    node.dispatchEvent(legacyEnter)
  })

  // Every composing Enter leaves the draft in place and produces no optimistic
  // transcript row, regardless of the desktop submit modifier.
  await expect(composer).toHaveValue(text)
  await expect(page.locator('.chat-md:visible').filter({ hasText: text })).toHaveCount(0)

  await composer.evaluate((node) => {
    node.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: node.value }))
    node.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'Enter',
        code: 'Enter',
        bubbles: true,
        cancelable: true,
      }),
    )
  })

  await expect(composer).toHaveValue('')
  await expect(page.locator('.chat-md:visible').filter({ hasText: text })).toBeVisible()
})
