import { expect, type Page, test } from '@playwright/test'
import { RELAY } from './_harness'

/**
 * Runtime verification of the concierge + button (issue #65) against the REAL
 * Live UI on the harness relay: the filled + in the sidebar header opens the
 * superagent panel bound to the current repo's concierge thread, the panel is
 * labeled "Concierge — <repo basename>", the empty state shows the intake hint,
 * and typing a message fires the `superagent.concierge` mutation (which creates
 * + seeds the thread server-side).
 *
 * The harness has no LLM backend configured, so we do NOT require a model
 * reply — the assertions stop at: panel opens, thread bound, mutation fired,
 * optimistic user bubble rendered.
 *
 * Desktop-only: the + button lives in the <aside> Sidebar header, which the
 * mobile layout (MobileApp) does not render.
 */
test.skip(({ isMobile }) => isMobile, 'desktop test (the + button lives in the <aside> Sidebar)')

async function openShell(page: Page): Promise<void> {
  await page.goto(`/?server=${RELAY}&e2e=1`)
  await page.waitForFunction(() => !document.querySelector('.app-loading'), undefined, {
    timeout: 60_000,
  })
  await page.locator('aside').first().waitFor({ state: 'visible', timeout: 60_000 })
}

test('concierge +: opens the repo intake thread and the first message fires the concierge mutation', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 900 })
  await openShell(page)

  // ---- The + button renders in the sidebar header (accent circular +) ----
  const plus = page.getByRole('button', { name: 'Concierge' })
  await expect(plus).toBeVisible({ timeout: 15_000 })
  // Repos load async; the button is disabled until at least one repo is known.
  await expect(plus).toBeEnabled({ timeout: 30_000 })

  // ---- Click → superagent panel bound to the current repo's concierge thread ----
  await plus.click()
  // If the repo context is ambiguous the button opens a minimal picker; the
  // harness registers one repo, but be tolerant: pick the first entry if shown.
  const picker = page.locator('[data-slot="dropdown-menu-content"]')
  if (await picker.isVisible({ timeout: 1_000 }).catch(() => false)) {
    await picker.getByRole('menuitem').first().click()
  }

  // The panel header shows "Concierge — <repo basename>" (the harness repo is
  // this checkout, so just assert the prefix + a non-empty basename).
  const header = page.locator('h1', { hasText: 'Concierge —' })
  await expect(header, 'the panel is labeled as the repo concierge').toBeVisible({
    timeout: 15_000,
  })
  expect((await header.textContent())?.trim()).toMatch(/Concierge — \S+/)

  // ---- Empty/new state: the intake hint shows before the first message ----
  await expect(
    page.getByText('Tell the concierge what you want', { exact: false }),
    'the empty-state hint renders',
  ).toBeVisible({ timeout: 10_000 })

  // ---- Type a message → the superagent.concierge mutation fires ----
  const text = `E2E concierge intake ${Date.now()}`
  const input = page.getByPlaceholder(/Orchestrate/)
  await expect(input).toBeVisible({ timeout: 10_000 })

  const conciergeCall = page.waitForRequest(
    (req) => req.url().includes('superagent.concierge') && req.method() === 'POST',
    { timeout: 20_000 },
  )
  await input.fill(text)
  await input.press('Enter')

  // The mutation fired (thread creation + seed happen server-side inside it)...
  const req = await conciergeCall
  expect(req.postData(), 'the mutation carries the typed text').toContain(text)

  // ...and the optimistic user bubble rendered the message (no LLM backend in
  // the harness, so we do not await a model reply).
  await expect(page.getByText(text, { exact: false }).first()).toBeVisible({ timeout: 10_000 })
})
