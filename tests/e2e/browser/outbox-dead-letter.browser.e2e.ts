import { expect, test } from '@playwright/test'
import { RELAY } from './_harness'

const MUTATION_ID = 'browser-dead-letter-invalid-rename'
const AUTHORED_TEXT = 'Keep this browser recovery text'
const DEAD_LETTER_KEY = 'podium.replica.outbox-dead-letter.v1'

test.skip(({ isMobile }) => isMobile, 'the recovery chip lives in the desktop header')

test('a refused browser write stays visible and discard survives reload', async ({ page }) => {
  const pageErrors: string[] = []
  page.on('pageerror', (error) => pageErrors.push(error.message))
  const renameResponses: number[] = []
  page.on('response', (response) => {
    if (response.url().includes('/trpc/sessions.rename')) {
      renameResponses.push(response.status())
    }
  })

  // Seed the pre-replica queue exactly as an offline browser write would leave it.
  // Omitting sessionId makes the real rename input fail validation while retaining
  // the author's own text for the recovery dialog.
  await page.addInitScript(
    ({ mutationId, authoredText }) => {
      if (localStorage.getItem('podium.e2e.outbox-dead-letter-seeded') === '1') return
      localStorage.setItem('podium.e2e.outbox-dead-letter-seeded', '1')
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
    },
    { mutationId: MUTATION_ID, authoredText: AUTHORED_TEXT },
  )

  await page.goto(`/?server=${RELAY}&e2e=1`)
  const header = page.getByTestId('desktop-topbar')
  await expect(header).toBeVisible({ timeout: 60_000 })

  await expect.poll(() => renameResponses, { timeout: 15_000 }).toContain(400)
  await expect
    .poll(() => page.evaluate((key) => localStorage.getItem(key), DEAD_LETTER_KEY))
    .toContain('"invalid"')
  expect(pageErrors).toEqual([])

  const chip = page.getByTestId('outbox-recovery-chip')
  await expect(chip).toBeVisible()
  await chip.click()

  const dialog = page.getByRole('dialog', { name: 'Changes that need you' })
  await expect(dialog).toBeVisible()
  await expect(dialog).toContainText(AUTHORED_TEXT)
  await expect(dialog.getByTestId('outbox-retry')).toHaveCount(0)
  await expect(dialog.getByRole('button', { name: 'Edit' })).toBeVisible()
  await expect(dialog.getByRole('button', { name: 'Discard' })).toBeVisible()

  // BAD_REQUEST is definitive. Waiting through the five-second retry cadence
  // proves the unchanged invalid bytes are never sent a second time.
  await page.waitForTimeout(5_500)
  expect(renameResponses).toEqual([400])

  // The persisted park must hydrate into the first store snapshot after reload;
  // it is not enough for the localStorage record merely to survive.
  await page.reload()
  await expect(header).toBeVisible({ timeout: 30_000 })
  await expect(chip).toBeVisible()
  expect(renameResponses).toEqual([400])
  await chip.click()
  await expect(dialog).toContainText(AUTHORED_TEXT)

  await dialog.getByRole('button', { name: 'Discard' }).click()
  await expect(chip).toHaveCount(0)
  await expect
    .poll(() => page.evaluate((key) => localStorage.getItem(key), DEAD_LETTER_KEY))
    .not.toContain(MUTATION_ID)

  await page.reload()
  await expect(header).toBeVisible({ timeout: 30_000 })
  await expect(chip).toHaveCount(0)
  expect(renameResponses).toEqual([400])
})
