import { mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { expect, test } from '@playwright/test'
import { podium, RELAY } from './_harness'

/**
 * A PTY THAT HAS PRINTED NOTHING, ON A PHONE (POD-393).
 *
 * The desktop panel got this affordance first (POD-385, after a measured
 * four-minute silent grok self-update); the Expo pane still ended its status
 * sentences at the attach, so the same wait dropped a phone straight onto an
 * empty grid — the one screen that is indistinguishable from a dead session,
 * and the hardest place to go looking for another explanation.
 *
 * The pane has no overlay and no counter: its idiom is one dim line above the
 * terminal, so this drives the line itself — it appears once attached over a
 * silent child, survives a reload (the fact is the SERVER's durable output
 * counter, not anything this client saw), and disappears on first output.
 *
 * FIXTURE: `PODIUM_E2E_SILENT_START=<ms>` on the harness server — every spawn is
 * a child that prints nothing for that long. Without it there is no silence to
 * observe, so this spec FAILS with a named reason rather than passing against a
 * session that behaved normally.
 */
test.skip(
  ({ isMobile, browserName }) => !isMobile || browserName !== 'chromium',
  'Pixel Chromium proof',
)

const ARTIFACTS = resolve(import.meta.dirname, '../../../.artifacts/POD-393')
const SILENT_MS = Number(process.env.PODIUM_E2E_SILENT_START ?? 0)

test('the Expo pane says a silent PTY has printed nothing, and stops when it does', async ({
  page,
}) => {
  test.setTimeout(180_000)
  test.fail(
    SILENT_MS < 10_000,
    'needs PODIUM_E2E_SILENT_START >= 10000 on the harness server — a fast child never holds the wait open',
  )
  mkdirSync(ARTIFACTS, { recursive: true })

  await page.goto(`/mobile?server=${RELAY}&e2e=1`)
  await page.getByRole('button', { name: 'New work' }).click()
  await page.getByRole('button', { name: 'Claude Code' }).click()
  await page.getByRole('button', { name: 'podium', exact: true }).click()
  await expect(page).toHaveURL(/\/mobile\/session\//, { timeout: 30_000 })

  // Expo Router drops the root query on a pushed route; reloading the session
  // route with the test flag exposes the terminal's test API — and re-runs the
  // attach, which is what makes the line below a statement about the SERVER's
  // record rather than about frames this tab happened to witness.
  const sessionUrl = new URL(page.url())
  sessionUrl.searchParams.set('e2e', '1')
  await page.goto(sessionUrl.href)
  await page.getByRole('button', { name: 'Native agent view' }).click()

  const silent = page.getByText(/no output yet/)
  await expect(silent).toBeVisible({ timeout: 30_000 })
  await page.screenshot({ path: resolve(ARTIFACTS, 'mobile-silent-startup.png'), fullPage: true })

  // FIRST OUTPUT ENDS IT — the child simply prints, which is the only thing the
  // pane was ever waiting for.
  await expect(silent).toHaveCount(0, { timeout: 90_000 })
  expect(await podium.screen(page)).toContain('booted')
  await page.screenshot({ path: resolve(ARTIFACTS, 'mobile-first-output.png'), fullPage: true })
})
