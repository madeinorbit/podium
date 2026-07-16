import { expect, type Locator, type Page, test } from '@playwright/test'
import { RELAY } from './_harness'

/**
 * Runtime verification of Settings → Experimental [spec:SP-f4b9] against the
 * real Live UI on the harness relay. The harness runs from source, so the
 * server is in dev mode (PODIUM_APP_VERSION unset ⇒ 'dev'): the hidden
 * `sample-experiment` flag must be LISTED with a "Dev" badge, toggleable, and
 * the toggle must persist through Save + reload via settings.experimental.
 */
test.skip(({ isMobile }) => isMobile, 'desktop test (settings nav is desktop-oriented)')

// The harness box can run under heavy memory pressure (dev server + builds);
// first app boot then takes well over the 30s default test timeout.
test.setTimeout(300_000)

async function openExperimental(page: Page): Promise<void> {
  // Load the shell at the root and wait for it to be READY (the <aside> work
  // list, like the other desktop specs — the .app-loading check passes on the
  // blank pre-React document). Then deep-link client-side: the harness's
  // static serving has no SPA history fallback for /settings/* paths, and the
  // app router (client-core/router.ts) re-parses the URL on popstate. Keep
  // location.search so the ?server/?e2e params survive.
  await page.goto(`/?server=${RELAY}&e2e=1`)
  await page.locator('aside').first().waitFor({ state: 'visible', timeout: 120_000 })
  await page.evaluate(() => {
    history.pushState(null, '', `/settings/experimental${location.search}`)
    dispatchEvent(new PopStateEvent('popstate'))
  })
  await expect(page.getByRole('heading', { name: 'Experimental' })).toBeVisible({
    timeout: 30_000,
  })
}

/** The flag row = the deepest div containing both the flag name and its switch. */
function flagRow(page: Page): Locator {
  return page
    .locator('div')
    .filter({ hasText: 'Sample experiment' })
    .filter({ has: page.getByRole('switch') })
    .last()
}

test('experimental page lists dev-visible flags and persists a toggle', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 })
  await openExperimental(page)

  // Dev mode lists the hidden sample flag, with its name, description, and Dev badge.
  await expect(page.getByText('Sample experiment', { exact: true })).toBeVisible({
    timeout: 20_000,
  })
  await expect(page.getByText(/Demonstrates the experimental-features system/)).toBeVisible()
  await expect(page.getByText('Dev', { exact: true })).toBeVisible()
  // The hint names the update channel.
  await expect(page.getByText(/update channel: (stable|edge)/)).toBeVisible()

  // Toggle → Save → reload → flipped state survived (persisted via settings.experimental).
  const flagSwitch = flagRow(page).getByRole('switch').first()
  await expect(flagSwitch).toBeEnabled()
  const before = await flagSwitch.getAttribute('aria-checked')
  await flagSwitch.click()
  await expect(flagSwitch).toHaveAttribute('aria-checked', before === 'true' ? 'false' : 'true')
  await page.getByRole('button', { name: /^Save$/ }).click()
  await expect(page.getByText('Saved.', { exact: true })).toBeVisible({ timeout: 15_000 })

  await openExperimental(page)
  const after = await flagRow(page).getByRole('switch').first().getAttribute('aria-checked')
  expect(after).not.toBe(before)
})
