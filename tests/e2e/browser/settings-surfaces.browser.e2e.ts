/**
 * SETTINGS → THE THREE SURFACES, AGAINST A RUNNING APP (POD-421, 3.7d).
 *
 * The brief is explicit that unit assertions are not enough here: *"drive the
 * real screens (real clicks against a running app), because a settings surface
 * that type-checks and still renders a value is exactly the failure this issue
 * exists to catch."*
 *
 * That is not a general preference for e2e — it is specific to this defect. The
 * component tests render `SecretsSection` with props. They cannot see a value
 * arriving through a different route: `settings.get` still returns the whole
 * blob, and a build where the material came back in it would leak into the DOM
 * of a page these specs load and those tests never construct. Here the server is
 * real, the read is real, and the assertion is against the rendered document.
 *
 * ---------------------------------------------------------------------------
 * TWO PRINCIPALS, AND HOW THE SECOND ONE IS PRODUCED
 * ---------------------------------------------------------------------------
 *
 * `PODIUM_E2E_ACCOUNT_ROLE=member` demotes the harness's one account through the
 * single method the gate consults (see `serve-harness.ts` for the full reasoning
 * and its limits). Everything else is the product. A member cannot LOG IN on
 * this build — `CLIENT_PRINCIPAL_GRADE` is still `device` — so what a green
 * member run shows is that the screens behave correctly when the server answers
 * as it does for a member, which is the half this issue owns.
 *
 * The admin project runs by default; the member project needs the env var, so
 * `bun run e2e:settings-member` is a separate invocation and both are recorded
 * in the gate evidence.
 */

import { expect, type Page, test } from '@playwright/test'
import { makeTrpc } from '../../../apps/web/src/app/trpc'
import { RELAY } from './_harness'

test.skip(
  ({ isMobile }) => isMobile,
  'desktop test — the Settings nav lives in the top bar (POD-318)',
)
test.describe.configure({ timeout: 90_000 })

/** Material planted through the REAL contracted command, so the leak assertions
 *  below have something to find. A suite that asserts "no secret in the DOM"
 *  against an instance with no secrets configured is the purest form of this
 *  run's dominant defect. */
const PLANTED = 'sk-e2e-planted-material-9f3a1c'

const IS_MEMBER = process.env.PODIUM_E2E_ACCOUNT_ROLE === 'member'

async function seedSecret(): Promise<boolean> {
  const trpc = makeTrpc('http://localhost:8799')
  try {
    await trpc.settings.setSecret.mutate({ key: 'apiKeys.openai', value: PLANTED })
    return true
  } catch {
    // A member is refused, which is itself the point — but then the leak
    // assertions would be vacuous, so the caller is told and skips them.
    return false
  }
}

async function openSettings(page: Page, tab: string): Promise<void> {
  await page.addInitScript(() => {
    ;(window as Window & { __PODIUM_SKIP_SETUP__?: boolean }).__PODIUM_SKIP_SETUP__ = true
  })
  await page.goto(`/?server=${RELAY}&e2e=1`)
  await page.waitForFunction(() => !document.querySelector('.app-loading'), undefined, {
    timeout: 45_000,
  })
  await page.locator('aside').first().waitFor({ state: 'visible', timeout: 15_000 })
  await page.goto(`/settings/${tab}?server=${RELAY}&e2e=1`)
  await page.getByRole('region', { name: 'Settings' }).waitFor({ state: 'visible', timeout: 20_000 })
}

const settings = (page: Page) => page.getByRole('region', { name: 'Settings' })

test.describe('the three surfaces are legible on screen', () => {
  test('the nav groups tabs by visibility class, not by topic', async ({ page }) => {
    await openSettings(page, 'sessions')
    const nav = settings(page).getByRole('navigation', { name: 'Settings sections' })
    // The headings a user actually reads. If these were still Agents /
    // Connections / Workspace / Instance, the class would be invisible on the
    // one screen where it decides what a change does.
    await expect(nav.getByText('Your preferences', { exact: true })).toBeVisible()
    await expect(nav.getByText('Instance settings', { exact: true })).toBeVisible()
    await expect(nav.getByText('Secrets', { exact: true }).first()).toBeVisible()
  })

  test('each tab states its class, and the preferences caveat is on screen', async ({ page }) => {
    await openSettings(page, 'sessions')
    await expect(settings(page).getByTestId('surface-banner-your-preferences')).toBeVisible()
    // THE HONESTY CHECK. POD-1213 has not landed, so these values are still one
    // instance-wide blob and the screen must not claim otherwise. This asserts
    // the caveat is RENDERED, not merely present in a constants file.
    const caveat = settings(page).getByTestId('surface-caveat')
    await expect(caveat).toBeVisible()
    await expect(caveat).toContainText('POD-1213')
    await expect(caveat).toContainText('every member')
  })

  test('an instance tab reads as instance, not as personal', async ({ page }) => {
    await openSettings(page, 'hibernation')
    await expect(settings(page).getByTestId('surface-banner-instance')).toBeVisible()
    // The control: the preferences caveat must NOT appear here, or the banner
    // is a constant rather than a classification.
    await expect(settings(page).getByTestId('surface-caveat')).toHaveCount(0)
  })
})

test.describe('the secrets surface', () => {
  test.skip(IS_MEMBER, 'the admin arm — the member arm is the describe below')

  test('shows presence and a fingerprint, and NO value anywhere in the document', async ({
    page,
  }) => {
    expect(await seedSecret()).toBe(true)
    await openSettings(page, 'secrets')

    // POSITIVE FIRST: the surface really rendered. Without this the leak
    // assertion below passes against a blank page.
    await expect(settings(page).getByTestId('secret-presence-apiKeys.openai')).toHaveText(
      'Configured',
    )
    const fingerprint = settings(page).getByTestId('secret-fingerprint').first()
    await expect(fingerprint).toBeVisible()
    const tag = (await fingerprint.textContent())?.trim() ?? ''
    expect(tag.length).toBeGreaterThan(0)
    // The fingerprint is a truncated HMAC and must share nothing with the
    // material. A "fingerprint" that was a prefix of the key would pass every
    // presence assertion and be the leak itself.
    expect(PLANTED).not.toContain(tag)

    // THE ASSERTION THIS SPEC EXISTS FOR — the whole rendered document, not a
    // field we thought to look at.
    const html = await page.content()
    expect(html).not.toContain(PLANTED)

    // And the input is empty: not masked, EMPTY. A `type="password"` bound to
    // the value would satisfy a visual check and fail this one.
    const input = settings(page).getByLabel('OpenAI API key — new value')
    await expect(input).toHaveValue('')
  })

  test('the value never reaches the client on ANY settings response', async ({ page }) => {
    expect(await seedSecret()).toBe(true)
    // Capture every response body the page receives while the settings screen
    // loads. This is the route the component tests structurally cannot see:
    // `settings.get` still returns the whole blob, and a build that put the
    // material back into it would leak here without any component rendering it.
    const bodies: string[] = []
    page.on('response', (res) => {
      if (!res.url().includes('/trpc')) return
      void res
        .text()
        .then((t) => bodies.push(t))
        .catch(() => {})
    })
    await openSettings(page, 'secrets')
    await expect(settings(page).getByTestId('secret-presence-apiKeys.openai')).toBeVisible()

    // Non-vacuity: we must actually have captured traffic, or "no body contains
    // the secret" is true of the empty list.
    expect(bodies.length).toBeGreaterThan(0)
    expect(bodies.join('\n')).not.toContain(PLANTED)
  })

  test('replacing a secret works, and rotates the fingerprint', async ({ page }) => {
    expect(await seedSecret()).toBe(true)
    await openSettings(page, 'secrets')
    // The fingerprint of THIS key, addressed through its own row rather than by
    // position: five rows render five identical-looking tags.
    const fingerprintOf = (key: string) =>
      settings(page)
        .locator(`.settings-row:has([data-testid="secret-presence-${key}"])`)
        .getByTestId('secret-fingerprint')
    const before = (await fingerprintOf('apiKeys.openai').textContent())?.trim()

    const input = settings(page).getByLabel('OpenAI API key — new value')
    await input.fill('sk-e2e-rotated-value-2b7d')
    await settings(page).getByTestId('secret-save-apiKeys.openai').click()

    // The fingerprint answers exactly one question — "did the key change?" — so
    // this is the behaviour it exists for, driven by a real click.
    await expect
      .poll(async () => (await fingerprintOf('apiKeys.openai').textContent())?.trim())
      .not.toBe(before)
    // The typed material is cleared from the field and is not in the document.
    await expect(input).toHaveValue('')
    expect(await page.content()).not.toContain('sk-e2e-rotated-value-2b7d')
  })

  test('clearing a secret flips presence to Not configured', async ({ page }) => {
    expect(await seedSecret()).toBe(true)
    await openSettings(page, 'secrets')
    await settings(page).getByTestId('secret-clear-apiKeys.openai').click()
    await expect(settings(page).getByTestId('secret-presence-apiKeys.openai')).toHaveText(
      'Not configured',
    )
    // …and the fingerprint goes with it. An absent secret that kept a
    // fingerprint would still answer "is this the same key" about a key that is
    // gone.
    await expect(
      settings(page)
        .locator('.settings-row:has([data-testid="secret-presence-apiKeys.openai"])')
        .getByTestId('secret-fingerprint'),
    ).toHaveCount(0)
  })
})

test.describe('the secrets surface, as a MEMBER', () => {
  test.skip(!IS_MEMBER, 'needs PODIUM_E2E_ACCOUNT_ROLE=member')

  test('reads as unavailable, with no presence, no fingerprint and no key names', async ({
    page,
  }) => {
    await openSettings(page, 'secrets')
    await expect(settings(page).getByTestId('secrets-unavailable')).toBeVisible()

    // THE EXISTENCE-ORACLE ASSERTIONS. A member must not be able to tell a
    // refusal from an instance with nothing configured — so nothing on this
    // page may name a key, a count, a presence word or a fingerprint.
    await expect(settings(page).getByTestId('secret-fingerprint')).toHaveCount(0)

    // SCOPED TO THE SECTION, not to the whole screen, and the distinction is
    // the definition of the leak rather than a convenience.
    //
    // The surface banner says "Podium shows whether one is configured…" — a
    // sentence about what this KIND of surface does. It is byte-identical on
    // every instance and for every account, so it discloses nothing about
    // whether THIS instance has a key. What must not vary with state is the
    // section body, so that is what is asserted here.
    //
    // The whole-region checks below stay, because a key name, a refusal word or
    // the material would be state- or principal-specific wherever they appeared.
    const section = settings(page).locator('section:has([data-testid="secrets-unavailable"])')
    expect((await section.textContent()) ?? '').not.toMatch(/\bconfigured\b/i)

    const text = (await settings(page).textContent()) ?? ''
    expect(text).not.toContain('apiKeys')
    expect(text).not.toContain('openai')
    // …and it must not read as an ERROR either. A red failure toast is
    // distinguishable from an empty state just as reliably as a status code is.
    expect(text.toLowerCase()).not.toContain('forbidden')
    expect(text.toLowerCase()).not.toContain('admin account')
  })

  test('the material is not in the document or in any response body', async ({ page }) => {
    const bodies: string[] = []
    page.on('response', (res) => {
      if (!res.url().includes('/trpc')) return
      void res
        .text()
        .then((t) => bodies.push(t))
        .catch(() => {})
    })
    await openSettings(page, 'secrets')
    await expect(settings(page).getByTestId('secrets-unavailable')).toBeVisible()
    expect(bodies.length).toBeGreaterThan(0)
    expect(await page.content()).not.toContain(PLANTED)
    expect(bodies.join('\n')).not.toContain(PLANTED)
  })

  test('a member CAN still reach and edit their own preferences', async ({ page }) => {
    // The control that stops the member run from being "everything is refused".
    // Without it, a build that broke the settings screen entirely for non-admins
    // would pass every assertion above.
    await openSettings(page, 'notifications')
    await expect(settings(page).getByTestId('surface-banner-your-preferences')).toBeVisible()
    await expect(settings(page).getByRole('heading', { name: 'Notifications' })).toBeVisible()
  })
})

test.describe('the Telegram surface offers no ambient routing affordance', () => {
  test('the chat id is displayed, not editable', async ({ page }) => {
    await openSettings(page, 'notifications')
    // It was a free-text input; typing an address into it configured delivery
    // with no ceremony behind it, which is the operator fallback ADR 3
    // Amendment 1 D22 removed. The only honest control is the one that STARTS
    // the ceremony.
    await expect(settings(page).getByTestId('telegram-chat-id')).toBeVisible()
    await expect(settings(page).getByLabel('Telegram chat ID')).toHaveCount(0)
    await expect(settings(page).getByRole('button', { name: /Connect Telegram/ })).toBeVisible()
  })

  test('the bot token is NOT on the notifications tab', async ({ page }) => {
    await openSettings(page, 'notifications')
    // It is `secret-value` on a different matrix row from `telegramChatId`, and
    // it sat beside it in one form. It lives on the Secrets surface now.
    const text = (await settings(page).textContent()) ?? ''
    expect(text).not.toContain('Telegram bot token')
  })
})
