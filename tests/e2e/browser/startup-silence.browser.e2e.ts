import { expect, test } from '@playwright/test'
import { newSession, openApp, podium } from './_harness'

/**
 * A PTY THAT HAS PRINTED NOTHING, IN A REAL BROWSER (POD-385).
 *
 * Measured once on a real host: grok self-updated during launch and its PTY
 * produced no bytes at all for about four minutes. The panel dropped its
 * "Starting…" overlay on the ATTACH — correct for a session idling at a prompt
 * (POD-379), fatal here — so the operator watched a blank terminal that looks
 * exactly like a dead session.
 *
 * This drives the affordance that replaced it: while the server says the PTY
 * has never produced output, the panel keeps a counting startup state and, once
 * the wait is long enough to read as broken, explains it. Then it gets out of
 * the way the instant real output lands.
 *
 * FIXTURE: `PODIUM_E2E_SILENT_START=<ms>` on the harness server — every spawn is
 * a child that prints nothing for that long. Without it there is no silence to
 * observe, so this spec FAILS with a named reason instead of passing on a
 * session that behaved normally.
 */
test.skip(({ isMobile }) => isMobile, 'desktop panel verification')

const SILENT_MS = Number(process.env.PODIUM_E2E_SILENT_START ?? 0)

test('a silent PTY keeps a counting startup affordance, and it clears on first output', async ({
  page,
}) => {
  test.setTimeout(240_000)
  test.fail(
    SILENT_MS < 25_000,
    'needs PODIUM_E2E_SILENT_START >= 25000 on the harness server — the hint only appears after 20s of silence',
  )
  await page.setViewportSize({ width: 1280, height: 900 })
  await openApp(page)
  await newSession(page, 'Claude')

  // ATTACHED, AND STILL SAYING SO. The old panel had already revealed a blank
  // terminal by this point. Warm panels for earlier sessions stay mounted in
  // this deck, so assert against the VISIBLE overlays and drive the newest one
  // — the session this test just spawned.
  const overlays = page.locator('[data-testid="terminal-startup-overlay"]:visible')
  const overlay = overlays.last()
  await expect(overlay).toBeVisible({ timeout: 30_000 })
  const elapsed = overlay.getByTestId('startup-silence')
  await expect(elapsed).toContainText('no output yet', { timeout: 20_000 })

  // The counter is the proof of life the blank screen could not give: it moves.
  const first = (await elapsed.textContent()) ?? ''
  await expect
    .poll(async () => (await elapsed.textContent()) ?? '', { timeout: 20_000 })
    .not.toBe(first)

  // Long enough to read as broken → the panel says why it might not be.
  await expect(overlay).toContainText('Still attached', { timeout: 40_000 })
  await page.screenshot({ path: 'test-results/pod-385-silent-startup.png' })

  // FIRST OUTPUT ENDS IT. Nothing here waits on a harness-specific cue — the
  // child simply prints, which is the only thing the panel was waiting for.
  await expect(overlays).toHaveCount(0, { timeout: 90_000 })
  expect(await podium.screen(page)).toContain('booted')
})
