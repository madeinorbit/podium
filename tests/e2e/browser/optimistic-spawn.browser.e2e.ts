import { expect, type Page, test } from '@playwright/test'
import { RELAY } from './_harness'

/**
 * Runtime verification of the optimistic "New <Agent> in <Repo>" spawn (#119)
 * against the REAL Live UI + server on the harness relay. The unit tests prove the
 * store overlay in isolation; this proves the end-to-end id handshake in a real
 * browser: one click paints exactly ONE draft-agent row, and it STAYS exactly one
 * after the real session lands — which only holds if the server honored the
 * client-minted id (otherwise the optimistic row and a differently-id'd real row
 * would both persist as a duplicate). Also asserts no uncaught page errors, so a
 * malformed optimistic row or a pane attaching to an as-yet-unknown session can't
 * crash the app.
 *
 * Desktop-only: the Classic|Unified switcher lives in the <aside> Sidebar.
 */
test.skip(({ isMobile }) => isMobile, 'desktop test (the switcher lives in the <aside> Sidebar)')

async function openUnified(page: Page): Promise<ReturnType<Page['locator']>> {
  await page.goto(`/?server=${RELAY}&e2e=1`)
  await page.waitForFunction(() => !document.querySelector('.app-loading'), undefined, {
    timeout: 60_000,
  })
  const aside = page.locator('aside').first()
  await aside.waitFor({ state: 'visible', timeout: 60_000 })
  // The unified layout is THE sidebar now — no switcher to flip.
  return aside
}

test('optimistic spawn paints one draft row and reconciles to a single live session', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 900 })
  const pageErrors: string[] = []
  page.on('pageerror', (e) => pageErrors.push(String(e)))

  const aside = await openUnified(page)
  const splitMain = aside.getByRole('button', { name: /^New .+ in .+/ })
  await expect(splitMain).toBeEnabled({ timeout: 20_000 })

  const rows = () => aside.getByTestId('unified-issue-row').count()
  const before = await rows()

  await splitMain.click()

  // The optimistic draft-agent row appears (fast — no round-trip gating it).
  await expect.poll(rows, { timeout: 5_000 }).toBe(before + 1)

  // Reconciliation: give the real create + broadcast (and the fake agent boot)
  // time to land. The client-minted id is reused by the server, so the optimistic
  // row is REPLACED, not duplicated — still exactly one new row.
  await page.waitForTimeout(5_000)
  expect(await rows()).toBe(before + 1)

  // Opening the pane for an optimistic (initially server-unknown) session, and
  // rendering a fully-synthetic starting SessionMeta, must not crash anything.
  expect(pageErrors, `uncaught page errors:\n${pageErrors.join('\n')}`).toEqual([])
})
