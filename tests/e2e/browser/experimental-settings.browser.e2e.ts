import { expect, type Locator, type Page, test } from '@playwright/test'
import { gotoWorkspace, RELAY } from './_harness'

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

async function saveSettings(page: Page): Promise<void> {
  const updateDialog = page.getByRole('dialog', { name: 'Podium update' })
  if (await updateDialog.isVisible().catch(() => false)) {
    await updateDialog.getByRole('button', { name: 'Later' }).click()
  }
  const save = page.getByRole('button', { name: /^Save changes$/ })
  await save.click()
  await expect(page.getByText('Saved ✓')).toBeVisible({ timeout: 15_000 })
  await expect(save).toBeHidden({ timeout: 15_000 })
}

async function setQueuesEnabled(page: Page, enabled: boolean): Promise<void> {
  const flagSwitch = flagRow(page, 'Queues').getByRole('switch').first()
  if ((await flagSwitch.getAttribute('aria-checked')) !== String(enabled)) {
    await flagSwitch.click()
    await saveSettings(page)
  }
}

async function openWorkspace(page: Page): Promise<void> {
  await page.evaluate(() => {
    history.pushState(null, '', `/${location.search}`)
    dispatchEvent(new PopStateEvent('popstate'))
  })
  await gotoWorkspace(page)
  const emptyPanel = page.getByText('No panel — use + to start one.')
  if (await emptyPanel.isVisible().catch(() => false)) {
    await page
      .getByRole('button', { name: /^New .+ in .+/ })
      .first()
      .click({ timeout: 15_000 })
    await expect(emptyPanel).toBeHidden({ timeout: 20_000 })
  }
}

test('experimental page persists and opens the separate queue groups', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 })
  await openExperimental(page)

  const row = flagRow(page, 'Queues')
  await expect(row.locator('.settings-label')).toContainText('Queues', {
    timeout: 20_000,
  })
  await expect(
    row.getByText('Show merge and heavy-test queues in the right sidebar.'),
  ).toBeVisible()
  // The hint names the update channel.
  await expect(page.getByText(/update channel: (stable|edge)/)).toBeVisible()

  // Toggle → Save → reload → flipped state survived (persisted via settings.experimental).
  const flagSwitch = row.getByRole('switch').first()
  await expect(flagSwitch).toBeEnabled()
  const before = await flagSwitch.getAttribute('aria-checked')
  const expected = before === 'true' ? 'false' : 'true'
  await flagSwitch.click()
  await expect(flagSwitch).toHaveAttribute('aria-checked', expected)
  await saveSettings(page)

  await openExperimental(page)
  await expect(flagRow(page, 'Queues').getByRole('switch').first()).toHaveAttribute(
    'aria-checked',
    expected,
  )

  // Exercise the real feature boundary and right-rail interaction, then leave
  // the persisted setting exactly as the harness found it.
  await setQueuesEnabled(page, true)
  await openWorkspace(page)

  const railButton = page.getByRole('button', { name: 'Queues' })
  await expect(railButton).toBeVisible({ timeout: 30_000 })
  await railButton.click()

  const queue = page.locator('[data-right-dock-panel="merge-queue"]')
  await expect(queue).toBeVisible()
  const mergeGroup = queue
    .getByRole('heading', { name: 'Merge queue' })
    .locator('xpath=ancestor::section[1]')
  const heavyGroup = queue
    .getByRole('heading', { name: 'Heavy test queue' })
    .locator('xpath=ancestor::section[1]')
  await expect(mergeGroup.getByRole('heading')).toHaveText([
    'Merge queue',
    'MERGING NOW',
    'NEXT UP',
    'READY',
  ])
  await expect(heavyGroup.getByRole('heading')).toHaveText([
    'Heavy test queue',
    'TESTING NOW',
    'NEXT UP',
    'READY',
  ])
  await queue.getByRole('button', { name: 'Refresh queues' }).click()
  await expect(queue.getByRole('region', { name: 'Repository queues' })).toBeVisible()

  const screenshotPath = process.env.PODIUM_MERGE_QUEUE_SCREENSHOT
  if (screenshotPath) await queue.screenshot({ path: screenshotPath })

  await openExperimental(page)
  await setQueuesEnabled(page, before === 'true')
  if (before !== 'true') {
    await openWorkspace(page)
    await expect(page.getByRole('button', { name: 'Queues' })).toHaveCount(0)
    await expect(page.locator('[data-right-dock-panel="merge-queue"]')).toHaveCount(0)
  }
})
