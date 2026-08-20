import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { type APIRequestContext, expect, type Page, test } from '@playwright/test'
import { harnessEnv } from '../harness-env'
import { RELAY } from './_harness'
import { loginTestClient } from '../../../apps/server/src/test-support/client-auth'

/**
 * POD-2414 — THE BLOCKED-SESSION BAR, DRIVEN END TO END.
 *
 * Spec §4's claim is that a blocked session is enumerable and answerable
 * WITHOUT attaching a terminal. Two halves of that claim had never met a
 * browser: a needs-human failure that is not auth-shaped never became an
 * interaction at all, and no shell rendered the aggregate even when it did.
 *
 * This walks the whole path with nothing faked between the ends: a real agent
 * session, its REAL Claude hook endpoint (the same URL the harness writes into
 * the session's settings file, which is how the product learns an agent's
 * state), the real daemon → server → interaction aggregate → durable feed →
 * replica, and the real card in the real chat surface. Then it answers from the
 * card and watches the row leave.
 *
 * `StopFailure` with a non-retryable, non-auth class is the case POD-2414 is
 * about. Before it, this produced a session sitting in `errored` with NOTHING
 * on any surface saying so.
 */

const HTTP = RELAY.replace(/^ws/, 'http')
const HOOKS_DIR = join(harnessEnv(Number(process.env.PORT ?? 8799)).stateDir, 'hooks')

test.skip(({ isMobile }) => isMobile, 'the chat-surface bar is verified on desktop here')

/**
 * FIXME, AND NOT BECAUSE OF THIS SPEC — see POD-2468.
 *
 * The web shell's private replica does not boot on this branch: the app paints
 * "Podium's app did not start" before any of the assertions below are reached,
 * and the repository's OWN boot spec (`kernel-replica.browser.e2e.ts`) fails
 * 4/5 for the same reason, as do long-standing specs like `input.browser`.
 * Every step here was written against the real surfaces and is expected to pass
 * the moment the shell boots again — deleting this one line is the whole
 * re-enable, and re-driving this journey is the visual acceptance POD-2414 owes.
 */
test.fixme()

async function rpc<T>(
  request: APIRequestContext,
  proc: string,
  input?: unknown,
  method: 'post' | 'get' = 'post',
): Promise<T> {
  const res =
    method === 'post'
      ? await request.post(`${HTTP}/trpc/${proc}`, { data: input ?? {} })
      : await request.get(`${HTTP}/trpc/${proc}`)
  if (!res.ok()) throw new Error(`${proc} → ${res.status()}: ${await res.text()}`)
  const body = (await res.json()) as { result?: { data?: T } }
  return body.result?.data as T
}

async function hookSettingsFiles(): Promise<Set<string>> {
  return new Set(await readdir(HOOKS_DIR).catch(() => []))
}

/** The hook endpoint the harness wrote for the session it just spawned. */
async function newHookUrl(existing: Set<string>): Promise<string | undefined> {
  const files = await hookSettingsFiles()
  const settingsFile = [...files].find((file) => !existing.has(file))
  if (!settingsFile) return undefined
  const settings = await readFile(join(HOOKS_DIR, settingsFile), 'utf8')
  return settings.match(/"url":\s*"([^"]+\/hooks\/[^"]+)"/)?.[1]
}

async function openChat(page: Page): Promise<void> {
  // NOTHING IS PINNED HERE. Chat is the default presentation for a session that
  // can chat, and this bar lives in that surface — so the spec takes the same
  // path a person does rather than writing a preference key the app also has to
  // migrate. (`_harness.openHome` pins `native` because those specs drive the
  // xterm substrate; this one does not.)
  const password = process.env.PODIUM_PASSWORD?.trim()
  if (password) {
    const login = await loginTestClient({ origin: HTTP, password })
    await page
      .context()
      .addCookies([
        { name: login.cookieName, value: login.cookieValue, url: HTTP, httpOnly: true, sameSite: 'Lax' },
      ])
  }
  await page.goto(`/?server=${RELAY}&e2e=1`)
  await page.waitForFunction(() => !document.querySelector('.app-loading'), undefined, {
    timeout: 60_000,
  })
  await page.locator('aside').first().waitFor({ state: 'visible', timeout: 60_000 })
  // The harness box routinely has an edge build available, and the update
  // dialog is modal — it covers the sidebar this spec navigates from. Hide it
  // (never "Update Podium": that would restart the thing under test).
  const update = page.getByRole('dialog', { name: 'Podium update' })
  if (await update.isVisible().catch(() => false)) {
    await update.getByRole('button', { name: 'Hide' }).click()
    await update.waitFor({ state: 'hidden', timeout: 15_000 }).catch(() => {})
  }
  const repoDialog = page.getByRole('dialog', { name: 'Find repositories' })
  if (await repoDialog.isVisible().catch(() => false)) {
    await repoDialog.getByRole('button', { name: 'Close' }).click()
  }
}

test('a needs-human failure becomes a card in chat, and answering it clears the card', async ({
  page,
  request,
}) => {
  test.setTimeout(150_000)
  await page.setViewportSize({ width: 1280, height: 900 })

  const repos = await rpc<string[]>(request, 'repos.list', undefined, 'get')
  const repoPath = repos[0]
  if (!repoPath) throw new Error('harness registered no repo')
  const stamp = Date.now().toString(36)
  const title = `Blocked session ${stamp}`

  const preexistingHooks = await hookSettingsFiles()
  await rpc(request, 'issues.create', { repoPath, title, startNow: true })
  let hookUrl: string | undefined
  await expect
    .poll(async () => {
      hookUrl = await newHookUrl(preexistingHooks)
      return hookUrl
    })
    .toMatch(/^http:\/\/127\.0\.0\.1:\d+\/hooks\//)

  await openChat(page)
  const row = page
    .locator('aside')
    .first()
    .getByTestId('unified-issue-row')
    .filter({ hasText: title })
    .first()
  await expect(row).toBeVisible({ timeout: 45_000 })
  await row.locator('button.flex-1').first().click()

  // ---- The failure the product used to swallow. ----
  // Non-retryable and NOT auth-shaped: before POD-2414 the synthesizer's only
  // failure arm was an auth regex, so this produced no interaction at all.
  await request.post(hookUrl as string, {
    headers: { 'content-type': 'application/json' },
    data: { hook_event_name: 'StopFailure', error_type: 'billing_error' },
  })

  const card = page.getByTestId('pending-interaction').first()
  await expect(card).toBeVisible({ timeout: 45_000 })
  await expect(card).toContainText('Session blocked')
  // The prompt names the cause rather than proposing a course of action.
  await expect(card).toContainText('billing_error')

  // Both offered choices are ones the answer path can actually perform.
  await expect(card.getByTestId('pending-interaction-action-full-resume')).toBeVisible()
  await expect(card.getByTestId('pending-interaction-action-abandon')).toBeVisible()

  // ---- Answering from the card resolves it everywhere. ----
  // The feed carries the OPEN set only, so a resolved ask is removed from the
  // replica and the bar unmounts itself — the disappearance IS the assertion.
  await card.getByTestId('pending-interaction-action-abandon').click()
  await expect(page.getByTestId('pending-interaction')).toHaveCount(0, { timeout: 30_000 })

  // And the aggregate agrees: no open ask remains for this session.
  await expect
    .poll(
      async () => (await rpc<unknown[]>(request, 'interactions.list', undefined, 'get')).length,
      { timeout: 20_000 },
    )
    .toBe(0)
})
