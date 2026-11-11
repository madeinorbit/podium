import { type ChildProcess, spawn } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, type Page, test } from '@playwright/test'

const root = fileURLToPath(new URL('../../../', import.meta.url))
const evidence = resolve(root, '.tmp/capability-screens')
let fixture: ChildProcess
let origin: string
let fixtureLog = ''
test.setTimeout(150_000)
test.use({ actionTimeout: 15_000 })
test.beforeAll(async () => {
  mkdirSync(evidence, { recursive: true })
  fixture = spawn('bun', ['--conditions=@podium/source', 'tests/e2e/serve-people-fixture.ts'], {
    cwd: root,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: process.env,
  })
  origin = await new Promise<string>((resolveReady, reject) => {
    const timeout = setTimeout(
      () => reject(new Error(`Fixture did not start: ${fixtureLog}`)),
      45_000,
    )
    fixture.stdout!.on('data', (chunk) => {
      fixtureLog += String(chunk)
      const ready = fixtureLog.match(/PEOPLE_FIXTURE (\{[^\n]+\})/)
      if (ready) {
        clearTimeout(timeout)
        resolveReady(JSON.parse(ready[1]!).origin)
      }
    })
    fixture.stderr!.on('data', (chunk) => {
      fixtureLog += String(chunk)
    })
    fixture.once('exit', (code) => {
      clearTimeout(timeout)
      reject(new Error(`Fixture exit ${code}: ${fixtureLog}`))
    })
  })
})
test.afterAll(async () => {
  if (!fixture || fixture.exitCode !== null) return
  const stopped = new Promise<void>((resolveStopped) =>
    fixture.once('exit', () => resolveStopped()),
  )
  fixture.kill('SIGTERM')
  await stopped
})
async function signIn(page: Page, email: string, password: string) {
  await page.goto(`${origin}/?desktop=1`)
  await page.getByLabel('Email', { exact: true }).fill(email)
  await page.getByLabel('Password', { exact: true }).fill(password)
  await page.getByRole('button', { name: 'Log in', exact: true }).click()
  await expect
    .poll(async () => (await (await page.request.get(`${origin}/auth/status`)).json()).authed)
    .toBe(true)
  await expect(page.getByLabel('Password', { exact: true })).toBeHidden({ timeout: 30_000 })
}
async function settings(page: Page, section: string) {
  await page.goto(`${origin}/settings/${section}`)
  await expect(page.getByRole('dialog', { name: 'Settings' })).toBeVisible({ timeout: 30_000 })
}

test('real two-member invitations, reset links, and one-device sign-out', async ({
  page,
  browser,
}, info) => {
  const folder = resolve(evidence, info.project.name)
  mkdirSync(folder, { recursive: true })
  const shot = async (name: string, target = page) => {
    const path = resolve(folder, `${name}.png`)
    await expect(target.getByTestId('boot-splash')).toBeHidden({ timeout: 30_000 })
    await target.screenshot({ path, fullPage: true, animations: 'disabled' })
    await info.attach(name, { path, contentType: 'image/png' })
  }
  await page.goto(`${origin}/?desktop=1`)
  await expect(page.getByLabel('Email', { exact: true })).toBeVisible()
  await expect(page.getByText('Continue with Google')).toHaveCount(0)
  await expect(page.getByText('Continue with GitHub')).toHaveCount(0)
  await shot('01-sign-in')
  await signIn(page, 'alice@example.com', 'alice-fixture-password')
  await settings(page, 'members')
  await expect(page.getByText('Bob', { exact: true })).toBeVisible()
  await expect(page.getByText('Manage organisations')).toHaveCount(0)
  await page.getByLabel('Email (optional)').fill('dana@example.com')
  await page.getByRole('button', { name: 'Create invite', exact: true }).click()
  const invite = await page.getByLabel('Invite link').inputValue()
  expect(invite).toContain('#invite=')
  await expect(page.getByRole('button', { name: 'Copy link' })).toBeVisible()
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write'], { origin })
  await page.getByRole('button', { name: 'Copy link' }).click()
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(invite)
  await shot('02-invitation-link')

  // An existing Alice cookie must never hide an invitation for another person.
  await page.goto(invite)
  await expect(page.getByRole('heading', { name: 'Join this workspace' })).toBeVisible()
  await expect(page.getByLabel('Email', { exact: true })).toHaveValue('dana@example.com')
  await shot('03-invitation-signed-in')
  const contextOptions = {
    viewport: page.viewportSize() ?? undefined,
    userAgent: await page.evaluate(() => navigator.userAgent),
  }
  const invitedContext = await browser.newContext(contextOptions)
  const bobContext = await browser.newContext(contextOptions)
  const otherBobContext = await browser.newContext(contextOptions)
  try {
    const invited = await invitedContext.newPage()
    await invited.goto(invite)
    await expect(invited.getByRole('heading', { name: 'Join this workspace' })).toBeVisible()
    await invited.getByLabel('Name', { exact: true }).fill('Dana')
    await invited.getByLabel('Password', { exact: true }).fill('dana-fixture-password')
    await invited.getByLabel('Confirm password').fill('dana-fixture-password')
    await shot('04-accept-invitation', invited)
    await invited.getByRole('button', { name: 'Join workspace' }).click()
    await expect(invited.getByRole('heading', { name: 'You’re a member' })).toBeVisible()
    await invited.getByRole('button', { name: 'Continue to sign in' }).click()
    await invited.getByLabel('Email', { exact: true }).fill('dana@example.com')
    await invited.getByLabel('Password', { exact: true }).fill('dana-fixture-password')
    await invited.getByRole('button', { name: 'Log in', exact: true }).click()
    await expect
      .poll(async () => (await (await invited.request.get(`${origin}/auth/status`)).json()).authed)
      .toBe(true)
    await expect(invited.getByLabel('Password', { exact: true })).toBeHidden({ timeout: 30_000 })
    await shot('05-invited-member-signed-in', invited)

    const bob = await bobContext.newPage()
    const otherBob = await otherBobContext.newPage()
    await signIn(bob, 'bob@example.com', 'bob-fixture-password')
    await signIn(otherBob, 'bob@example.com', 'bob-fixture-password')
    await settings(page, 'members')
    const bobRow = page.locator('li').filter({ has: page.locator('strong', { hasText: /^Bob$/ }) })
    await bobRow.getByRole('button', { name: 'Recovery link', exact: true }).click()
    await bobRow.getByLabel('Your password').fill('alice-fixture-password')
    await bobRow.getByRole('button', { name: 'Create recovery link' }).click()
    const reset = await bobRow.getByLabel('Recovery link', { exact: true }).inputValue()
    await shot('06-admin-reset-link')
    await bob.goto(reset)
    await expect(bob.getByRole('heading', { name: 'Reset your password' })).toBeVisible()
    await expect(bob.getByLabel('Name', { exact: true })).toHaveCount(0)
    await expect(bob.getByLabel('Email', { exact: true })).toHaveCount(0)
    await bob.getByLabel('Password', { exact: true }).fill('bob-reset-password')
    await bob.getByLabel('Confirm password').fill('bob-reset-password')
    await shot('07-password-reset', bob)
    await bob.getByRole('button', { name: 'Save password' }).click()
    await expect(bob.getByRole('heading', { name: 'Password updated' })).toBeVisible()
    expect((await (await otherBob.request.get(`${origin}/auth/status`)).json()).authed).toBe(false)
    await bob.getByRole('button', { name: 'Continue to sign in' }).click()
    await signIn(bob, 'bob@example.com', 'bob-reset-password')
    await signIn(otherBob, 'bob@example.com', 'bob-reset-password')
    await settings(bob, 'devices')
    const devices = bob.getByRole('region', { name: 'Signed-in devices' })
    await expect(devices.getByRole('button', { name: 'Revoke', exact: true })).toHaveCount(2)
    await shot('08-device-list', bob)
    // Select the row without "This device", then observe revocation on that device.
    const otherRow = devices
      .locator('.py-3\\.5')
      .filter({ has: bob.getByRole('button', { name: 'Revoke', exact: true }) })
      .filter({ hasNotText: 'This device' })
    await otherRow.getByRole('button', { name: 'Revoke', exact: true }).click()
    await devices.getByRole('button', { name: 'Revoke device', exact: true }).click()
    await expect(devices.getByRole('button', { name: 'Revoke', exact: true })).toHaveCount(1)
    await expect
      .poll(async () => (await (await otherBob.request.get(`${origin}/auth/status`)).json()).authed)
      .toBe(false)
    expect((await (await bob.request.get(`${origin}/auth/status`)).json()).authed).toBe(true)
    await shot('09-one-device-signed-out', bob)
    await bob.goto(`${origin}/mobile/settings`)
    await expect(bob.getByText('Connected devices', { exact: true })).toBeVisible({
      timeout: 45_000,
    })
    await bob.getByText('Connected devices', { exact: true }).scrollIntoViewIfNeeded()
    await shot('11-phone-client-devices', bob)
    await settings(page, 'access')
    await expect(page.getByRole('heading', { name: 'Access', exact: true })).toBeVisible()
    await shot('10-access')
  } finally {
    await invitedContext.close()
    await bobContext.close()
    await otherBobContext.close()
  }
})

test('reported account capabilities show mail and providers without host-only controls', async ({
  page,
}, info) => {
  const capabilities = {
    version: 1,
    passwordSignIn: true,
    providers: ['google', 'github'],
    selfSignUp: true,
    invitationDelivery: 'mail',
    passwordReset: 'mail',
    emailVerification: true,
    organisations: true,
    sameMachineSignIn: false,
    adminSignOutEverywhere: false,
    adminEndDeviceSignIn: false,
    accountUrl: 'https://accounts.example/account',
  }
  await page.route('**/auth/status', async (route) => {
    const response = await route.fetch()
    const status = await response.json()
    await route.fulfill({ response, json: { ...status, capabilities } })
  })
  await page.goto(`${origin}/?desktop=1`)
  await expect(page.getByRole('button', { name: 'Continue with Google' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Continue with GitHub' })).toBeVisible()
  await expect(page.getByRole('link', { name: 'Forgot password?' })).toBeVisible()
  await expect(page.getByText(/podium setup|Ask an admin for a reset/)).toHaveCount(0)
  const path = resolve(evidence, `${info.project.name}-account-capabilities.png`)
  await page.screenshot({ path, fullPage: true, animations: 'disabled' })
  await info.attach('account-capabilities', { path, contentType: 'image/png' })
  await page.goto(`${origin}/mobile/`)
  await expect(page.getByRole('button', { name: 'Continue with Google' })).toBeVisible({
    timeout: 45_000,
  })
  await expect(page.getByTestId('boot-splash')).toBeHidden({ timeout: 30_000 })
  const phonePath = resolve(evidence, `${info.project.name}-phone-client-sign-in.png`)
  await page.screenshot({ path: phonePath, fullPage: true, animations: 'disabled' })
  await info.attach('phone-client-sign-in', { path: phonePath, contentType: 'image/png' })

  await signIn(page, 'alice@example.com', 'alice-fixture-password')
  await page.route('**/auth/members/invite', async (route) => {
    expect(route.request().postDataJSON()).toEqual({
      email: 'mailed@example.com',
      role: 'admin',
      current: 'alice-fixture-password',
    })
    await route.fulfill({ json: { mailSent: true } })
  })
  await settings(page, 'members')
  await expect(page.getByRole('button', { name: 'Recovery link', exact: true })).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Sign out everywhere', exact: true })).toHaveCount(
    0,
  )
  await page.getByLabel('Email', { exact: true }).fill('mailed@example.com')
  await page.getByLabel('Role', { exact: true }).selectOption('admin')
  await page.getByLabel('Your password', { exact: true }).fill('alice-fixture-password')
  await page.getByRole('button', { name: 'Send invitation' }).click()
  await expect(page.getByText('Invitation emailed.')).toBeVisible()
  await expect(page.getByLabel('Invite link')).toHaveCount(0)
  const mailPath = resolve(evidence, `${info.project.name}-mailed-invitation.png`)
  await page.screenshot({ path: mailPath, fullPage: true, animations: 'disabled' })
  await info.attach('mailed-invitation', { path: mailPath, contentType: 'image/png' })
  await settings(page, 'access')
  await expect(page.getByRole('link', { name: 'Manage organisations' })).toBeVisible()
  await expect(page.getByRole('button', { name: /^Sign out .+’s/ })).toHaveCount(0)
  const accessPath = resolve(evidence, `${info.project.name}-account-access.png`)
  await page.screenshot({ path: accessPath, fullPage: true, animations: 'disabled' })
  await info.attach('account-access', { path: accessPath, contentType: 'image/png' })
  await settings(page, 'security')
  await expect(page.getByRole('link', { name: 'Manage account' })).toBeVisible()
  await expect(page.getByRole('button', { name: /Disable login/ })).toHaveCount(0)
  const securityPath = resolve(evidence, `${info.project.name}-account-security.png`)
  await page.screenshot({ path: securityPath, fullPage: true, animations: 'disabled' })
  await info.attach('account-security', { path: securityPath, contentType: 'image/png' })
  await settings(page, 'devices')
  await expect(page.getByRole('link', { name: 'Manage all account devices' })).toBeVisible()
  const devicePath = resolve(evidence, `${info.project.name}-account-devices.png`)
  await page.screenshot({ path: devicePath, fullPage: true, animations: 'disabled' })
  await info.attach('account-devices', { path: devicePath, contentType: 'image/png' })
  await page.goto(`${origin}/mobile/settings`)
  const accountDevices = page.getByRole('link', { name: 'Manage all account devices' })
  await expect(accountDevices).toBeVisible({ timeout: 45_000 })
  await accountDevices.scrollIntoViewIfNeeded()
  const phoneDevicePath = resolve(evidence, `${info.project.name}-phone-client-account-devices.png`)
  await page.screenshot({ path: phoneDevicePath, fullPage: true, animations: 'disabled' })
  await info.attach('phone-client-account-devices', {
    path: phoneDevicePath,
    contentType: 'image/png',
  })
})
