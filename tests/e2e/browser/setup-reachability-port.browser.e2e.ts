/**
 * POD-1583: the first-run "Make this instance reachable" step must name the port this
 * instance is ACTUALLY served on, not the hardcoded default (18787). The harness serves the
 * web UI on :8799, so a real browser load of the wizard is the honest test — a unit test that
 * passes a port in proves nothing about the wiring at the setup.commandFor call site.
 */
import { expect, test } from '@playwright/test'
import { RELAY } from './_harness'

const HARNESS_PORT = Number(process.env.PORT ?? 8799)

test('reachability command names the port the instance is served on', async ({ page }) => {
  // The harness instance is already configured, so the setup gate would skip the wizard.
  // Force the first-run branch; everything past this point is the real app and real server.
  await page.route('**/setup/config**', async (route) => {
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ needsSetup: true }),
    })
  })

  await page.goto(`/?server=${RELAY}&e2e=1`)

  const setup = page.locator('.setup-view')
  await expect(setup.getByRole('heading', { name: 'Welcome to Podium' })).toBeVisible({
    timeout: 30_000,
  })
  await setup.getByRole('button', { name: 'Continue' }).click()

  await expect(setup.getByRole('heading', { name: 'Make this instance reachable' })).toBeVisible({
    timeout: 15_000,
  })

  // Tailscale Funnel is the default option; its command must carry the served port.
  const command = setup.locator('code').first()
  await expect(command).toBeVisible({ timeout: 15_000 })
  await expect(command).toHaveText(new RegExp(`(^|\\s)${HARNESS_PORT}(\\s|$)`))
  await expect(command).not.toHaveText(/18787/)

  // Every exposure option takes the same port, not just Funnel.
  await setup.locator('#net-tailscale-serve').click()
  await expect(command).toHaveText(new RegExp(`(^|\\s)${HARNESS_PORT}(\\s|$)`))
})
