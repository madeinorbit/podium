import { fileURLToPath } from 'node:url'
import { expect, test } from '@playwright/test'
import { RELAY } from './_harness'

declare global {
  interface Window {
    __offerAnimationStarts?: string[]
  }
}

test('native offer keeps terminal contained and expands feedback fluidly', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('podium.panelMode', 'native'))
  await page.goto(`/?server=${RELAY}&e2e=1`)
  await page.waitForFunction(() => !document.querySelector('.app-loading'), undefined, {
    timeout: 45_000,
  })

  const repoDialog = page.getByRole('dialog', { name: 'Find repositories' })
  if (await repoDialog.isVisible().catch(() => false)) {
    await repoDialog.getByRole('button', { name: 'Close' }).click()
  }

  const sidebar = page.getByRole('complementary').first()
  await sidebar.waitFor({ state: 'visible', timeout: 30_000 })
  const issueRow = sidebar
    .locator('[data-testid="unified-worktree-row"], [data-testid="unified-issue-row"]')
    .first()
  await issueRow.waitFor({ state: 'visible', timeout: 30_000 })
  const lifecycle = issueRow.getByTestId('row-lifecycle-status')
  await expect(lifecycle).toHaveAttribute('data-phase', 'waiting', { timeout: 20_000 })
  await expect(lifecycle).toContainText('waiting on decision')
  await expect(issueRow.getByLabel('1 waiting on you')).toBeVisible()

  await issueRow.locator('button.flex-1').first().click()
  await page.locator('button[aria-label="New panel"]:visible').waitFor({ state: 'visible' })

  const dock = page.getByTestId('native-offer-dock')
  await expect(dock).toBeVisible({ timeout: 20_000 })
  const requestChanges = dock.getByRole('button', { name: /^Request changes/ })
  await expect(requestChanges).toBeVisible()

  const containment = await page.evaluate(() => {
    const surface = document.querySelector<HTMLElement>('[data-testid="terminal-surface"]')
    const term = surface?.querySelector<HTMLElement>('.term')
    const screen = term?.querySelector<HTMLElement>('.xterm-screen')
    if (!surface || !term || !screen) return null
    const surfaceBox = surface.getBoundingClientRect()
    const screenBox = screen.getBoundingClientRect()
    return {
      paddingBottom: getComputedStyle(term).paddingBottom,
      screenBottom: screenBox.bottom,
      surfaceBottom: surfaceBox.bottom,
    }
  })
  expect(containment).not.toBeNull()
  expect(containment?.paddingBottom).toBe('20px')
  expect(containment?.screenBottom).toBeLessThanOrEqual((containment?.surfaceBottom ?? 0) + 0.5)

  const dockHeightBefore = await dock.evaluate((el) => el.getBoundingClientRect().height)
  await page.evaluate(() => {
    window.__offerAnimationStarts = []
    document.addEventListener(
      'animationstart',
      (event) => {
        const target = event.target
        if (target instanceof HTMLElement && target.classList.contains('offer-feedback')) {
          window.__offerAnimationStarts?.push(event.animationName)
        }
      },
      { once: false },
    )
  })
  await requestChanges.click()

  const feedback = page.getByTestId('offer-feedback')
  await expect(feedback).toBeVisible()
  await expect(feedback.locator('textarea')).toHaveAttribute('rows', '4')
  await expect
    .poll(() => page.evaluate(() => window.__offerAnimationStarts ?? []))
    .toContain('offer-feedback-reveal')

  await page.waitForTimeout(350)
  const dockHeightAfter = await dock.evaluate((el) => el.getBoundingClientRect().height)
  expect(dockHeightAfter).toBeGreaterThan(dockHeightBefore + 70)

  if (process.env.PODIUM_E2E_CAPTURE === '1') {
    await page.screenshot({
      path: fileURLToPath(
        new URL('../../../docs/design/pod218-offer-feedback-runtime.png', import.meta.url),
      ),
      fullPage: true,
    })
  }
})
