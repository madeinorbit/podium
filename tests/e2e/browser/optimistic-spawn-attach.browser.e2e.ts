import { expect, type Page, test } from '@playwright/test'
import { podium, RELAY } from './_harness'

/**
 * Regression guard for the optimistic-spawn attach bug (#119): when you click
 * "New <Agent> in <Repo>" and STAY on the session, the pane's terminal must
 * actually attach and show the agent — not sit black until you switch away and
 * back. The original optimistic change opened the pane against the not-yet-created
 * session, so the terminal's one-shot `hub.attach` was dropped and never re-sent.
 *
 * We prove attachment behaviorally: the keyecho far-end echoes input, so once the
 * terminal is bound, bytes we send appear on screen. If the terminal never
 * attaches (the bug), the echo never lands and this times out.
 *
 * Desktop, native mode (the terminal path the bug lives in).
 */
test.skip(({ isMobile }) => isMobile, 'desktop test (the unified switcher lives in the <aside> Sidebar)')

async function openUnified(page: Page): Promise<ReturnType<Page['locator']>> {
  await page.addInitScript(() => localStorage.setItem('podium.panelMode', 'native'))
  await page.goto(`/?server=${RELAY}&e2e=1`)
  await page.waitForFunction(() => !document.querySelector('.app-loading'), undefined, {
    timeout: 60_000,
  })
  const aside = page.locator('aside').first()
  await aside.waitFor({ state: 'visible', timeout: 60_000 })
  const unifiedToggle = aside.getByRole('button', { name: 'unified', exact: true })
  await expect(unifiedToggle).toBeVisible({ timeout: 15_000 })
  await unifiedToggle.click()
  await expect(unifiedToggle).toHaveAttribute('aria-pressed', 'true')
  return aside
}

test('optimistic spawn: the pane attaches on its own (no switch-away needed)', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 })
  const aside = await openUnified(page)

  // Fresh session's AgentPanel will set window.__podium; clear any stale one.
  await page.evaluate(() => {
    delete (window as unknown as { __podium?: unknown }).__podium
  })

  const splitMain = aside.getByRole('button', { name: /^New .+ in .+/ })
  await expect(splitMain).toBeEnabled({ timeout: 20_000 })
  await splitMain.click()

  // The pane mounts; wait for its test API. We do NOT switch panes.
  await page.waitForFunction(() => !!(window as unknown as { __podium?: unknown }).__podium, undefined, {
    timeout: 25_000,
  })

  // The terminal must bind on its own: bytes we send must echo back. Re-send each
  // poll tick so a byte sent before the bind isn't lost.
  const marker = 'attach_probe_119'
  await expect
    .poll(
      async () => {
        await podium.send(page, marker)
        return podium.screen(page)
      },
      { timeout: 15_000, intervals: [400, 800, 1200] },
    )
    .toContain(marker)
})
