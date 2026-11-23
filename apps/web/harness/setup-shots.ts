/** Capture the shipping onboarding agent step against an isolated model-backed fixture. */
import { mkdirSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { chromium, expect } from '@playwright/test'

const before = process.argv.includes('--before')
const out = process.env.ONBOARDING_SHOTS_DIR ?? '/tmp/podium-onboarding-shots'
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
  await page.goto('http://127.0.0.1:55685/setup-harness.html#agent')
  await expect(page.getByRole('heading', { name: 'Set up your agents.' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Continue', exact: true })).toBeDisabled()
  await expect(page.getByRole('button', { name: 'Install', exact: true })).toHaveCount(
    before ? 0 : 6,
  )
  await page.evaluate(() => document.fonts.ready)
  await page.screenshot({
    path: join(out, `${before ? 'before' : 'after'}-desktop.png`),
    fullPage: true,
  })
  await page.setViewportSize({ width: 390, height: 844 })
  await page.screenshot({
    path: join(out, `${before ? 'before' : 'after'}-narrow.png`),
    fullPage: true,
  })
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  )
  if (!before) {
    await page
      .getByRole('group', { name: 'Codex actions' })
      .getByRole('button', { name: 'Install', exact: true })
      .click()
    await expect(page.getByText('Installing 1.0.0…')).toBeVisible()
    await expect(page.getByText('1.0.0 · managed by Podium')).toBeVisible()
    await expect(page.getByRole('button', { name: 'Continue', exact: true })).toBeEnabled()
    await expect(page.getByRole('button', { name: 'Sign in', exact: true })).toBeVisible()
    await page.screenshot({ path: join(out, 'installed-narrow.png'), fullPage: true })
    await page.setViewportSize({ width: 1280, height: 1000 })
    await page.screenshot({ path: join(out, 'installed-desktop.png'), fullPage: true })
  }
  expect(errors).toEqual([])
  console.log(`Onboarding ${before ? 'baseline' : 'first install'} captures: ${out}`)
} finally {
  await browser.close()
}
