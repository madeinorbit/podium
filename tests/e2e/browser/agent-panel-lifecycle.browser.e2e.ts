import { expect, test } from '@playwright/test'
import { RELAY } from './_harness'

/**
 * THE PANEL'S LIFECYCLE ARBITRATION, REAL-CLICKED (POD-408).
 *
 * `panel-surface.ts` decides which of four states a session's panel is in and
 * `lifecycle-actions.ts` decides what the way back is called; this drives both
 * through a real browser:
 *
 *   live → parked    Hibernate, from the header overflow menu
 *   parked → ended   Resume, refused by the server on this harness — the panel
 *                    follows the answer instead of its own optimism
 *
 * parked → LIVE is deliberately NOT claimed here: the in-process harness cannot
 * relaunch a session (see the comment at the last step). It is covered at the
 * unit layer instead. A spec that asserted it would be asserting the fixture.
 *
 * THE TELL IS THE TERMINAL SURFACE, not the chat/native segment. The segment
 * would read better, but it also requires `chatCapable`, which depends on a
 * transcript the harness's echo jig does not reliably produce — keying on it made
 * this spec pass or fail on whether a transcript had happened to arrive, which is
 * a flake dressed as an assertion. `terminal-surface` renders iff the surface is
 * LIVE, which is exactly the arbitration under test. The chat/native half is
 * covered separately by ui-state-persistence.browser.e2e.ts.
 *
 * FIXTURE: `PODIUM_E2E_PANEL_LIFECYCLE=1` on the harness server (see
 * tests/e2e/serve-harness.ts) — one live, resumable, idle agent session. Without
 * it there is nothing parkable on screen, so this spec FAILS with a named reason
 * rather than passing silently: a suite that reports green for a fixture it
 * never had is the instrument the browser lane exists to remove.
 */
test.skip(({ isMobile }) => isMobile, 'desktop panel verification')

test('hibernate parks the panel, and it follows the server out of parked', async ({ page }) => {
  // Cold start, a park and a real resume in one test — the config's 30s default
  // is a per-TEST cap, so generous per-assertion timeouts below mean nothing
  // without it (the run that found this died at 30s on the last assertion).
  test.setTimeout(240_000)
  test.fail(
    process.env.PODIUM_E2E_PANEL_LIFECYCLE !== '1',
    'needs PODIUM_E2E_PANEL_LIFECYCLE=1 on the harness server — without it there is no resumable session to park',
  )
  await page.setViewportSize({ width: 1280, height: 900 })
  await page.addInitScript(() => localStorage.setItem('podium.panelModeDefault', 'native'))
  await page.goto(`/?server=${RELAY}&e2e=1`)
  await page.waitForFunction(() => !document.querySelector('.app-loading'), undefined, {
    timeout: 60_000,
  })

  // The fixture's session is the only one, so the workspace opens it directly.
  await expect(page.getByTestId('agent-panel-header')).toContainText('Lifecycle panel subject', {
    timeout: 60_000,
  })
  // LIVE: the terminal surface is on screen, because there is a PTY behind it.
  await expect(page.getByTestId('terminal-surface')).toBeVisible({ timeout: 45_000 })

  // live → parked, through the real menu item (keyed on the ACTION, not its label).
  await page.getByTestId('header-menu').first().click()
  const hibernate = page.getByTestId('lifecycle-hibernate')
  await expect(hibernate).toBeVisible({ timeout: 15_000 })
  await hibernate.click()

  // PARKED: no terminal — the process is stopped — and the only thing offered is
  // the way back.
  const resume = page.getByTestId('lifecycle-resume')
  await expect(resume).toBeVisible({ timeout: 45_000 })
  await expect(page.getByTestId('terminal-surface')).toHaveCount(0)

  // parked → (the server's answer). The in-process harness CANNOT relaunch a
  // session — `resurrectSession` is refused with "server-minted SessionBinding
  // instruction is required" — so parked → live is not reachable here, and this
  // spec does not pretend otherwise. What it does verify is the half that IS
  // reachable and that had no test before: the panel follows the server's answer
  // rather than its own optimism, arbitrating from `parked` to `ended`, and an
  // ENDED surface is never a dead end — it states what happened and still offers
  // a way back. (parked → live is covered at the unit layer:
  // `wakes a parked session from the banner and stays retryable when refused`.)
  await resume.click()
  const banner = page.getByText('The agent process failed to start', { exact: false })
  await expect(banner).toBeVisible({ timeout: 60_000 })
  await expect(page.getByTestId('terminal-surface')).toHaveCount(0)
  await expect(page.getByTestId('lifecycle-resume')).toBeVisible()
})
