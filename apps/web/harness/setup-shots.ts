/** Capture the shipping onboarding agent step against an isolated model-backed fixture. */
import { mkdirSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { chromium, expect } from '@playwright/test'

const out = process.env.ONBOARDING_SHOTS_DIR ?? '/tmp/podium-onboarding-shots'
const base = process.env.ONBOARDING_SHOTS_URL ?? 'http://127.0.0.1:55685'
mkdirSync(out, { recursive: true })
const cache = join(process.env.HOME ?? '', '.cache/ms-playwright')
const shell = readdirSync(cache)
  .filter((name) => name.startsWith('chromium_headless_shell-'))
  .sort()
  .at(-1)
const browser = await chromium.launch({
  executablePath: shell
    ? join(cache, shell, 'chrome-headless-shell-linux64/chrome-headless-shell')
    : undefined,
})
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } })
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  const capture = async (name: string) => {
    await page.evaluate(() => document.fonts.ready)
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    await page.screenshot({ path: join(out, `${name}.png`), fullPage: true })
  }

  await page.goto(`${base}/setup-harness.html#agent`)
  await expect(page.getByRole('heading', { name: 'Set up your agents.' })).toBeVisible()
  await expect(page.getByText(/^Podium runs coding agents on/)).toHaveText(
    'Podium runs coding agents on project-server.example.com. Pick the ones you want and Podium installs its own copy of each; your own installs stay as they are. Sign in now or later.',
  )
  await expect(page.locator('[data-setup-agents="onboarding"]')).toBeVisible()
  await expect(page.getByRole('region', { name: 'Not installed' })).toBeVisible()
  await expect(page.getByRole('checkbox', { name: 'Install Claude Code' })).toBeChecked()
  await expect(page.getByRole('checkbox', { name: 'Install Codex' })).toBeChecked()
  await expect(page.getByRole('checkbox', { name: 'Install OpenCode' })).toBeChecked()
  await expect(page.getByRole('checkbox', { checked: true })).toHaveCount(3)
  await expect(page.getByRole('button', { name: 'Install', exact: true })).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Install 3 and continue' })).toBeEnabled()
  await capture('suggested-desktop')
  await page.setViewportSize({ width: 390, height: 844 })
  await capture('suggested-narrow')

  await page.getByRole('button', { name: 'Install 3 and continue' }).click()
  await expect(page.getByRole('heading', { name: 'Podium is good to go.' })).toBeVisible()
  await capture('continuing-narrow')
  await page.getByRole('button', { name: 'Back to agents' }).click()
  await expect(page.getByRole('region', { name: 'Installing' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Continue', exact: true })).toBeEnabled()
  await capture('installing-narrow')
  await expect(page.getByRole('region', { name: 'Needs sign-in' })).toBeVisible()

  await page.goto(`${base}/setup-harness.html?scene=mixed#agent`)
  for (const name of ['Ready', 'Needs sign-in', 'Not installed', 'Can’t install here'])
    await expect(page.getByRole('region', { name })).toBeVisible()
  await page.getByRole('checkbox', { name: 'Install OpenCode' }).check()
  await expect(page.getByRole('button', { name: 'Continue without installing' })).toBeEnabled()
  await expect(page.getByRole('button', { name: 'Install 1 and continue' })).toBeEnabled()
  await capture('mixed-narrow')
  await page.setViewportSize({ width: 1280, height: 1000 })
  await capture('mixed-desktop')
  await page.getByRole('button', { name: 'Continue without installing' }).click()
  await expect(page.getByRole('heading', { name: 'Podium is good to go.' })).toBeVisible()
  expect(errors).toEqual([])
  console.log(`Onboarding panel captures: ${out}`)
} finally {
  await browser.close()
}
