import { expect, test } from '@playwright/test'
import { DEFAULT_SETTINGS } from '../../../packages/core/src/settings'
import { RELAY } from './_harness'

test.skip(
  ({ isMobile }) => isMobile,
  'desktop test (Settings nav button lives in the <aside> Sidebar)',
)

function trpcJson(data: unknown) {
  return [{ result: { data } }]
}

test('Telegram setup button shows code link and fills chat id after polling', async ({ page }) => {
  await page.route('**/trpc/settings.telegramSetupStart**', async (route) => {
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify(
        trpcJson({
          setupId: 'setup-1',
          code: 'PODIUM123',
          botUsername: 'mwpodium_bot',
          telegramUrl: 'https://t.me/mwpodium_bot?start=PODIUM123',
          expiresAt: new Date(Date.now() + 300_000).toISOString(),
        }),
      ),
    })
  })
  let pollCount = 0
  await page.route('**/trpc/settings.telegramSetupPoll**', async (route) => {
    pollCount += 1
    const data =
      pollCount === 1
        ? { status: 'pending', expiresAt: new Date(Date.now() + 300_000).toISOString() }
        : {
            status: 'connected',
            chatId: '129784115',
            chatType: 'private',
            chatLabel: '@mikewirth',
            settings: {
              ...DEFAULT_SETTINGS,
              notifications: {
                ...DEFAULT_SETTINGS.notifications,
                telegramBotToken: '123456:secret',
                telegramChatId: '129784115',
              },
            },
          }
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify(trpcJson(data)),
    })
  })

  await page.goto(`/?server=${RELAY}&e2e=1`)
  await page.waitForFunction(() => !document.querySelector('.app-loading'), undefined, {
    timeout: 20_000,
  })
  await page.locator('aside').first().waitFor({ state: 'visible', timeout: 15_000 })
  await page.locator('aside').getByRole('button', { name: 'Settings', exact: true }).click()

  const settings = page.getByRole('region', { name: 'Settings' })
  await expect(settings).toBeVisible({ timeout: 10_000 })
  await settings.getByRole('button', { name: 'Notifications' }).click()
  await settings.getByPlaceholder('empty = off', { exact: true }).fill('123456:secret')

  const popups: (typeof page)[] = []
  page.on('popup', (popup) => popups.push(popup))
  await settings.getByRole('button', { name: 'Connect Telegram' }).click()

  const link = settings.getByRole('link', { name: 'Open Telegram with this code' })
  await expect(link).toBeVisible({ timeout: 10_000 })
  await expect(link).toHaveAttribute('href', 'https://t.me/mwpodium_bot?start=PODIUM123')
  await page.waitForTimeout(250)
  expect(popups).toHaveLength(0)

  const popupPromise = page.waitForEvent('popup')
  await link.click()
  const popup = await popupPromise
  await expect(popup).toHaveURL('https://t.me/mwpodium_bot?start=PODIUM123', { timeout: 10_000 })
  await popup.close()

  await expect(settings.getByText('Connected to @mikewirth.')).toBeVisible({ timeout: 10_000 })
  await expect(settings.getByPlaceholder('filled by setup, or @channel')).toHaveValue('129784115')
})
