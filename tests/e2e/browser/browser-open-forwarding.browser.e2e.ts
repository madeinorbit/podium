import { createServer, type Server } from 'node:http'
import { expect, test } from '@playwright/test'
import { openApp } from './_harness'

test.skip(({ isMobile }) => isMobile, 'desktop popup and overlay interaction')

test('remote browser-open: user opens login and pastes callback back to daemon localhost', async ({
  page,
  context,
}) => {
  let callbackPath = ''
  let resolveCallback!: () => void
  const callbackSeen = new Promise<void>((resolve) => {
    resolveCallback = resolve
  })
  const callbackServer: Server = createServer((request, response) => {
    callbackPath = request.url ?? ''
    response.writeHead(200, { 'content-type': 'text/plain' })
    response.end('Login complete')
    resolveCallback()
  })
  await new Promise<void>((resolve, reject) => {
    callbackServer.once('error', reject)
    callbackServer.listen(0, '127.0.0.1', resolve)
  })
  const address = callbackServer.address()
  if (!address || typeof address === 'string') throw new Error('callback server has no port')

  try {
    await context.route('https://auth.example/**', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'text/html',
        body: '<title>Test login</title><h1>Test login</h1>',
      }),
    )
    await page.setViewportSize({ width: 1280, height: 820 })
    await openApp(page)
    await page
      .getByRole('navigation', { name: 'Panels' })
      .getByRole('button', { name: 'Shell' })
      .click({ timeout: 15_000 })
    const shellInput = page.getByRole('textbox', { name: 'Terminal input' }).last()
    await shellInput.waitFor({ state: 'visible', timeout: 30_000 })
    await shellInput.focus()
    await page.waitForTimeout(800)

    const redirect = encodeURIComponent(`http://localhost:${address.port}/auth/callback`)
    const authUrl = `https://auth.example/authorize?client_id=podium-e2e&redirect_uri=${redirect}`
    // biome-ignore lint/style/useTemplate: concatenation keeps the nested shell quoting legible.
    await page.keyboard.type('"$BROWSER" \'' + authUrl + "'", { delay: 2 })
    await page.keyboard.press('Enter')

    const overlay = page.getByRole('complementary', {
      name: 'Pending agent browser requests',
    })
    await expect(overlay).toBeVisible({ timeout: 15_000 })
    await expect(page.getByText('Agent login pending')).toBeVisible()
    await expect(page.getByLabel('Paste the localhost callback URL')).toBeVisible()

    const popupPromise = context.waitForEvent('page')
    await page.getByRole('button', { name: 'Open login page' }).click()
    const popup = await popupPromise
    await popup.waitForLoadState('domcontentloaded')
    await expect(popup.getByRole('heading', { name: 'Test login' })).toBeVisible()

    const callbackUrl = `http://localhost:${address.port}/auth/callback?code=e2e-code&state=e2e-state`
    await page.getByLabel('Paste the localhost callback URL').fill(callbackUrl)
    await page.getByRole('button', { name: 'Forward callback' }).click()
    await callbackSeen

    expect(callbackPath).toBe('/auth/callback?code=e2e-code&state=e2e-state')
    await expect(overlay).toBeHidden({ timeout: 15_000 })
    await expect(page.getByText('Login callback forwarded')).toBeVisible()
    await popup.close()
  } finally {
    await new Promise<void>((resolve) => callbackServer.close(() => resolve()))
  }
})
