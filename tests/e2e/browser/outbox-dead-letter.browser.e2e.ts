/**
 * Phase-3 exit evidence: a durable queued write is rejected by the real
 * harness server, parked by the production web engine, and recovered through
 * the rendered dead-letter UI. This is deliberately not a component fixture:
 * the only planted state is the same legacy queue blob a browser can carry
 * across an upgrade; boot migrates it into the replica collection and the real
 * tRPC call supplies the BAD_REQUEST that parks it.
 */
import { expect, test } from '@playwright/test'
import { openApp } from './_harness'

const MUTATION_ID = 'pod-424-runtime-dead-letter'
const AUTHORED_TEXT = 'keep this exact offline edit'

test.skip(({ isMobile }) => isMobile, 'desktop host indicator verification')
test.setTimeout(180_000)

test('a refused durable write is recoverable and discard survives reload', async ({ page }) => {
  await page.addInitScript(
    ({ mutationId, authoredText }) => {
      if (sessionStorage.getItem('podium.pod-424-dead-letter-seeded') === '1') return
      // The missing sessionId is intentional. parseOutboxEntries accepts the
      // durable envelope, then the production sessions.rename input validator
      // rejects its payload. That refusal — not this setup code — must create
      // the dead-letter record and paint the recovery surface.
      localStorage.setItem(
        'podium.outbox.v1',
        JSON.stringify([
          {
            mutationId,
            kind: 'rename',
            input: { name: authoredText },
            queuedAt: Date.now(),
          },
        ]),
      )
      sessionStorage.setItem('podium.pod-424-dead-letter-seeded', '1')
    },
    { mutationId: MUTATION_ID, authoredText: AUTHORED_TEXT },
  )

  await openApp(page)

  const chip = page.getByTestId('outbox-recovery-chip')
  await expect(chip).toHaveAccessibleName('1 change needs your attention', { timeout: 30_000 })
  await chip.click()

  const dialog = page.getByRole('dialog', { name: 'Changes that need you' })
  await expect(dialog).toBeVisible()
  await expect(dialog).toContainText('The change was not valid')
  await expect(dialog).toContainText(AUTHORED_TEXT)
  // `invalid` can never succeed with the same bytes, so the production plan
  // must not offer a retry that would create a heal loop.
  await expect(dialog.getByTestId('outbox-retry')).toHaveCount(0)

  // Durability means visible recovery survives a browser reload, not merely
  // that an opaque row stays in localStorage.
  await page.reload()
  await page.waitForFunction(() => !document.querySelector('.app-loading'), undefined, {
    timeout: 45_000,
  })
  await expect(chip).toHaveAccessibleName('1 change needs your attention', { timeout: 30_000 })
  await chip.click()
  const restoredDialog = page.getByRole('dialog', { name: 'Changes that need you' })
  await expect(restoredDialog).toContainText(AUTHORED_TEXT)

  await restoredDialog.getByRole('button', { name: 'Discard' }).click()
  await expect(chip).toHaveCount(0)
  await expect
    .poll(
      () =>
        page.evaluate(
          (mutationId) =>
            Object.keys(localStorage).some((key) =>
              (localStorage.getItem(key) ?? '').includes(mutationId),
            ),
          MUTATION_ID,
        ),
      { timeout: 10_000 },
    )
    .toBe(false)

  await page.reload()
  await page.waitForFunction(() => !document.querySelector('.app-loading'), undefined, {
    timeout: 45_000,
  })
  await expect(page.getByTestId('outbox-recovery-chip')).toHaveCount(0)
  await expect(page.getByText('keep this exact offline edit', { exact: true })).toHaveCount(0)
})
