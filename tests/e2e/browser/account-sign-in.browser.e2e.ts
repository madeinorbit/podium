/** The smallest real sign-in checks for both built apps. Run with PODIUM_PASSWORD set. */
import { mkdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import { devices, expect, test } from '@playwright/test'

const password = process.env.PODIUM_PASSWORD
test.skip(!password, 'This check needs a password-protected isolated harness (PODIUM_PASSWORD).')
test.setTimeout(90_000)
const evidence = fileURLToPath(new URL('../../../.tmp/accounts-check', import.meta.url))

test('web signs in through the form, reloads with its cookie, and erases on sign-out', async ({
  page,
}) => {
  mkdirSync(evidence, { recursive: true })
  await page.goto('/')
  await page.getByLabel('Email', { exact: true }).fill('user:sole')
  await page.getByLabel('Password', { exact: true }).fill('wrong-password')
  await page.getByRole('button', { name: 'Log in', exact: true }).click()
  await expect(page.getByRole('alert')).toContainText('incorrect email or password')
  await page.getByLabel('Password', { exact: true }).fill(password!)
  await page.getByRole('button', { name: 'Log in', exact: true }).click()
  await page.waitForFunction(() => (globalThis as any).__podiumReplicaPath === 'kernel')
  await expect(page.getByLabel('Password', { exact: true })).toBeHidden()
  const cookie = (await page.context().cookies()).find((row) => row.name === 'podium_session')
  expect(cookie?.httpOnly).toBe(true)
  expect(
    await page.evaluate(() =>
      fetch('/auth/status')
        .then((response) => response.json())
        .then((status) => status.authed),
    ),
  ).toBe(true)
  await page.screenshot({ path: resolve(evidence, 'web-signed-in.png'), fullPage: true })
  await page.reload()
  await page.waitForFunction(() => (globalThis as any).__podiumReplicaPath === 'kernel')
  await expect(page.getByLabel('Password', { exact: true })).toBeHidden()
  await page.goto('/settings/security')
  await expect(page.getByRole('button', { name: 'Sign out', exact: true })).toBeVisible()
  await page.screenshot({ path: resolve(evidence, 'web-account-removal.png'), fullPage: true })
  await page
    .getByRole('dialog', { name: 'Settings' })
    .getByRole('button', { name: 'Sign out', exact: true })
    .click()
  await expect(page.getByLabel('Password', { exact: true })).toBeVisible()
  expect(
    await page.evaluate(() =>
      Object.keys(localStorage).filter((key) => key.startsWith('podium.kernel-replica.principal.')),
    ),
  ).toEqual([])
  expect(
    await page.evaluate(() =>
      fetch('/auth/status')
        .then((response) => response.json())
        .then((status) => status.authed),
    ),
  ).toBe(false)
  await page.screenshot({ path: resolve(evidence, 'web-signed-out.png'), fullPage: true })
})

test.describe('phone Expo web', () => {
  const phone = devices['Pixel 7']
  test.use({
    viewport: phone.viewport,
    userAgent: phone.userAgent,
    deviceScaleFactor: phone.deviceScaleFactor,
    isMobile: phone.isMobile,
    hasTouch: phone.hasTouch,
  })

  test('signs in with the same cookie protocol and survives reload', async ({ page }) => {
    mkdirSync(evidence, { recursive: true })
    // Admit the fresh harness through its auth route before starting the phone.
    // The standard page fixture also preserves failures if teardown must time out.
    const anonymous = await page.request.get('/auth/status')
    expect(anonymous.ok()).toBe(true)
    expect((await anonymous.json()).authed).toBe(false)
    await page.goto('/mobile/', { waitUntil: 'domcontentloaded' })
    await page.getByLabel('Email', { exact: true }).fill('user:sole')
    await page.getByLabel('Password', { exact: true }).fill(password!)
    await page.getByRole('button', { name: 'Log in', exact: true }).click()
    await expect(page.getByRole('tab', { name: 'Work', exact: true })).toBeVisible({
      timeout: 45_000,
    })
    await expect(page.getByLabel('Password', { exact: true })).toBeHidden()
    expect(
      (await page.context().cookies()).find((row) => row.name === 'podium_session')?.httpOnly,
    ).toBe(true)
    const status = await page.request.get('/auth/status')
    expect((await status.json()).authed).toBe(true)
    await page.screenshot({
      path: resolve(evidence, 'phone-signed-in.png'),
      fullPage: true,
      animations: 'disabled',
      timeout: 10_000,
    })
    await page.reload({ waitUntil: 'domcontentloaded' })
    await expect(page.getByRole('tab', { name: 'Work', exact: true })).toBeVisible({
      timeout: 45_000,
    })
    await expect(page.getByLabel('Password', { exact: true })).toBeHidden()
  })
})
