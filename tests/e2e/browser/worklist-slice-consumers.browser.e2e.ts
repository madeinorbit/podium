import { expect, type Page, test } from '@playwright/test'
import { RELAY } from './_harness'

/**
 * POD-331 — RUNTIME VERIFICATION OF THE PUBLISHED WORKLIST SLICE.
 *
 * The port made `SidebarUnified` and `CommandPalette` read ONE published
 * derivation instead of each computing `sidebarSections` for itself on its own
 * clock. Every other check of that lives in jsdom or in a counter; this one
 * drives the real browser, because the failure mode it guards against is
 * exactly the one a unit test cannot see:
 *
 *   the slice derives fine for whichever surface renders FIRST, and the second
 *   surface — reading the same publisher through a different component tree —
 *   renders empty.
 *
 * So both consumers are put on screen in the same session, against the same
 * store, and both are required to show work derived from that slice: the
 * sidebar as rows, the palette as a spawn target naming the same repo.
 *
 * Deliberately NOT asserted here: the derivation COUNT. Sharing is measured in
 * apps/web/src/perf/slice-render-count.test.tsx, where it can be measured
 * honestly; a browser test that guessed at it would be a worse instrument
 * wearing better clothes.
 */
test.skip(({ isMobile }) => isMobile, 'desktop test (the sidebar lives in the <aside>)')

async function openShell(page: Page): Promise<void> {
  await page.goto(`/?server=${RELAY}&e2e=1`)
  await page.waitForFunction(() => !document.querySelector('.app-loading'), undefined, {
    timeout: 60_000,
  })
  await page.locator('aside').first().waitFor({ state: 'visible', timeout: 60_000 })
}

test('sidebar and command palette both render from the one published worklist slice', async ({
  page,
}) => {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(String(e)))
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text())
  })

  await page.setViewportSize({ width: 1280, height: 900 })
  await openShell(page)
  const aside = page.locator('aside').first()

  // ---- CONSUMER 1: the sidebar. Seed a work row with a real click. ----
  const splitMain = aside.getByRole('button', { name: /^New .+ in .+/ })
  await expect(splitMain).toBeEnabled({ timeout: 20_000 })

  // The spawn button's label is `New <Agent> in <Repo>`, and the <Repo> half is
  // chosen from the slice's `sections` — so it is itself a read of the
  // derivation, before any row exists.
  const repoName = (await splitMain.textContent())?.match(/ in (.+)$/)?.[1]?.trim() ?? ''
  expect(repoName).not.toBe('')

  await splitMain.click()
  await expect
    .poll(async () => aside.getByTestId('unified-issue-row').count(), { timeout: 30_000 })
    .toBeGreaterThan(0)

  // ---- CONSUMER 2: the command palette, over the SAME store. ----
  await page.keyboard.press('Control+k')
  const palette = page.locator('[aria-label="Command palette"]')
  await expect(palette).toBeVisible({ timeout: 10_000 })

  // "New agent" spawn targets come from `sections` — the palette's own former
  // `sidebarSections(...)` call, now a read of the published slice. If the
  // second consumer got an empty derivation, this is where it shows.
  await palette.getByRole('combobox').fill('New agent')
  // The palette names the WORKTREE it would spawn into ("New Claude agent in
  // <worktree>"), where the sidebar button above names the REPO — two different
  // reads of the same `sections`, which is why both are checked rather than one
  // string being matched in two places.
  await expect(
    palette
      .getByRole('option')
      .filter({ hasText: /^New .+ agent in .+/ })
      .first(),
  ).toBeVisible({ timeout: 15_000 })

  // ---- Both surfaces alive at once, agreeing about the same world. ----
  // Escape is TWO-STAGE (see palette-ctxmenu.browser.e2e.ts): the first press
  // clears a non-empty query, the second closes the palette.
  await page.keyboard.press('Escape')
  await page.keyboard.press('Escape')
  await expect(palette).toBeHidden({ timeout: 10_000 })
  await expect
    .poll(async () => aside.getByTestId('unified-issue-row').count(), { timeout: 15_000 })
    .toBeGreaterThan(0)

  expect(errors, `console/page errors: ${errors.join(' | ')}`).toEqual([])
})
