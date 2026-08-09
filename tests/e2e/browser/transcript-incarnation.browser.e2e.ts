import { mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'
import { expect, test } from '@playwright/test'
import { RELAY } from './_harness'

test.skip(({ isMobile }) => isMobile, 'desktop completed-issue panel verification')

test('a completed issue keeps its hibernated transcript chain and wake action', async ({
  page,
}) => {
  test.setTimeout(180_000)
  test.fail(
    process.env.PODIUM_E2E_TRANSCRIPT_INCARNATION !== '1',
    'needs PODIUM_E2E_TRANSCRIPT_INCARNATION=1 on the harness server',
  )
  await page.setViewportSize({ width: 1280, height: 900 })
  await page.goto(`/?server=${RELAY}&e2e=1`)
  await page.waitForFunction(() => !document.querySelector('.app-loading'), undefined, {
    timeout: 60_000,
  })

  const aside = page.locator('aside').first()
  await aside.waitFor({ state: 'visible', timeout: 60_000 })
  const issueRow = aside
    .getByTestId('unified-issue-row')
    .filter({ hasText: 'Completed transcript incarnation' })
    .first()
  await expect(issueRow).toBeVisible({ timeout: 30_000 })
  await issueRow.locator('button.flex-1').first().click()

  await expect(page.getByTestId('agent-panel-header')).toContainText('Incarnation chain subject', {
    timeout: 60_000,
  })
  await expect(page.getByTestId('lifecycle-resume')).toBeVisible({ timeout: 30_000 })
  await expect(page.locator('.transcript-row')).toContainText([
    'Earlier transcript incarnation is still readable.',
    'Replacement inode continues the same session.',
  ])

  const artifactPath = process.env.PODIUM_E2E_ARTIFACT_PATH
  if (artifactPath) {
    await mkdir(dirname(artifactPath), { recursive: true })
    await page.screenshot({ path: artifactPath, fullPage: true })
  }
})
