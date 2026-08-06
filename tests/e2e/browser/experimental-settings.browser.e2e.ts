import { expect, type Locator, type Page, test } from '@playwright/test'
import { RELAY } from './_harness'

/**
 * Runtime verification of Settings → Experimental [spec:SP-f4b9] against the
 * real Live UI on the harness relay. The harness runs from source, so the
 * server is in dev mode (PODIUM_APP_VERSION unset ⇒ 'dev'): the edge-visible
 * `merge-queue` flag must be listed, toggleable, and persist through Save +
 * reload via settings.experimental.
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

/** A feature uses the standard Settings row shared by every experimental control. */
function flagRow(page: Page, name: string): Locator {
  return page.locator('.settings-row').filter({ hasText: name })
}

test('experimental page lists and persists the merge queue toggle', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 })
  await openExperimental(page)

  const row = flagRow(page, 'Merge queue')
  await expect(row.locator('.settings-label')).toContainText('Merge queue', {
    timeout: 20_000,
  })
  await expect(row.getByText('Show the merge queue tool in the right sidebar.')).toBeVisible()
  // The hint names the update channel.
  await expect(page.getByText(/update channel: (stable|edge)/)).toBeVisible()

  // Toggle → Save → reload → flipped state survived (persisted via settings.experimental).
  const flagSwitch = row.getByRole('switch').first()
  await expect(flagSwitch).toBeEnabled()
  const before = await flagSwitch.getAttribute('aria-checked')
  const expected = before === 'true' ? 'false' : 'true'
  await flagSwitch.click()
  await expect(flagSwitch).toHaveAttribute('aria-checked', expected)
  const save = page.getByRole('button', { name: /^Save changes$/ })
  await save.click()
  await expect(page.getByText('Saved ✓')).toBeVisible({ timeout: 15_000 })
  await expect(save).toBeHidden({ timeout: 15_000 })

  await openExperimental(page)
  await expect(flagRow(page, 'Merge queue').getByRole('switch').first()).toHaveAttribute(
    'aria-checked',
    expected,
  )
})
