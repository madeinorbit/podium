import { expect, type Page, test } from '@playwright/test'
import { newSession, openApp } from './_harness'

test.skip(({ isMobile }) => isMobile, 'desktop workspace layout only')
test.setTimeout(300_000)

const tabOrder = (page: Page): Promise<string[]> =>
  page.$$eval('.overflow-x-auto [data-session]', (els) =>
    (els as HTMLElement[]).map((el) => el.dataset.session ?? ''),
  )

async function dragTab(page: Page, from: string, to: string): Promise<void> {
  const src = page.locator(`.overflow-x-auto [data-session="${from}"]`)
  const dst = page.locator(`.overflow-x-auto [data-session="${to}"]`)
  const a = await src.boundingBox()
  const b = await dst.boundingBox()
  if (!a || !b) throw new Error('tab not visible')
  await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2)
  await page.mouse.down()
  await page.mouse.move(a.x + a.width / 2 + 10, a.y + a.height / 2, { steps: 4 })
  await page.mouse.move(b.x + b.width * 0.8, b.y + b.height / 2, { steps: 12 })
  await page.mouse.up()
}

test('pane, split, dock tab, and legacy migration survive a real reload', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 820 })
  await openApp(page)

  await page.waitForFunction(
    () => !!(window as unknown as { __podium?: unknown }).__podium,
    undefined,
    { timeout: 30_000 },
  )
  const first = (await tabOrder(page)).at(-1)
  if (!first) throw new Error('initial agent tab not found')
  const before = new Set(await tabOrder(page))
  await newSession(page, 'Claude')
  const second = (await tabOrder(page)).find((id) => !before.has(id))
  if (!second) throw new Error('second agent tab not found')

  const pairIds = new Set([first, second])
  const pair = (tabs: string[]): string[] => tabs.filter((id) => pairIds.has(id))
  for (let attempt = 0; attempt < 3; attempt++) {
    if ((await pair(await tabOrder(page))).join(',') === [second, first].join(',')) break
    await dragTab(page, first, second)
    await page.waitForTimeout(500)
  }
  await expect
    .poll(async () => pair(await tabOrder(page)), { timeout: 10_000 })
    .toEqual([second, first])

  const strip = page.getByTestId('native-tab-strip')
  await strip.locator(`[data-session="${first}"]`).locator('button').first().click()

  await page.getByRole('button', { name: 'Split', exact: true }).click()
  const picker = page.getByText('Pick a panel for this pane:', { exact: true }).locator('..')
  await expect(picker).toBeVisible()
  await picker
    .getByRole('button')
    .nth((await tabOrder(page)).indexOf(second))
    .click()

  const panels = page.getByRole('navigation', { name: 'Panels' })
  await panels.getByRole('button', { name: 'Git', exact: true }).click()
  await expect(page.locator('[data-right-dock-panel="git"]')).toBeVisible()

  const visiblePaneIds = (): Promise<string[]> =>
    page.$$eval('.flex.min-h-0 > [data-session]', (els) =>
      (els as HTMLElement[])
        .filter((el) => el.offsetParent !== null)
        .map((el) => el.dataset.session ?? ''),
    )
  const paneLayout = await visiblePaneIds()
  expect(new Set(paneLayout)).toEqual(new Set([first, second]))
  // Replicated layout writes are optimistic; cross the durable Outbox boundary
  // before simulating a process-losing reload.
  await page.waitForTimeout(1_000)
  expect(paneLayout).toHaveLength(2)

  // openApp planted this pre-replica spelling. The acting principal consumed it.
  expect(await page.evaluate(() => localStorage.getItem('podium.panelModeDefault'))).toBeNull()

  await page.reload()
  await page.waitForFunction(() => !document.querySelector('.app-loading'), undefined, {
    timeout: 45_000,
  })
  await expect(page.getByTestId('native-tab-strip')).toBeVisible({ timeout: 20_000 })
  await expect
    .poll(async () => pair(await tabOrder(page)), { timeout: 60_000 })
    .toEqual([second, first])
  await expect.poll(visiblePaneIds, { timeout: 30_000 }).toEqual(paneLayout)
  await expect(page.locator('[data-right-dock-panel="git"]')).toBeVisible({ timeout: 20_000 })
})

test('chat-versus-native mode switch persists across reload', async ({ page }) => {
  // POD-329: one modeled panelMode + one derivation; the real toggle must
  // survive a full reload and leave no raw legacy default key behind.
  await page.setViewportSize({ width: 1280, height: 820 })
  await openApp(page)

  await page.waitForFunction(
    () => !!(window as unknown as { __podium?: unknown }).__podium,
    undefined,
    { timeout: 30_000 },
  )

  // openApp seeds native default; the panel starts native.
  const nativeTab = page.getByTestId('mode-native')
  const chatTab = page.getByTestId('mode-chat')
  await expect(nativeTab).toBeVisible({ timeout: 30_000 })
  await expect(nativeTab).toHaveAttribute('aria-selected', 'true')

  await chatTab.click()
  await expect(chatTab).toHaveAttribute('aria-selected', 'true')
  await expect(nativeTab).toHaveAttribute('aria-selected', 'false')

  // Allow the replicated layout write to cross the durable Outbox boundary.
  await page.waitForTimeout(1_000)
  expect(await page.evaluate(() => localStorage.getItem('podium.panelModeDefault'))).toBeNull()

  await page.reload()
  await page.waitForFunction(() => !document.querySelector('.app-loading'), undefined, {
    timeout: 45_000,
  })
  await expect(page.getByTestId('mode-chat')).toBeVisible({ timeout: 30_000 })
  await expect
    .poll(async () => page.getByTestId('mode-chat').getAttribute('aria-selected'), {
      timeout: 30_000,
    })
    .toBe('true')
  await expect(page.getByTestId('mode-native')).toHaveAttribute('aria-selected', 'false')
})

test('native mode stays selected after a delayed layout feed', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 820 })
  await openApp(page)

  await page.waitForFunction(
    () => !!(window as unknown as { __podium?: unknown }).__podium,
    undefined,
    { timeout: 30_000 },
  )

  const nativeTab = page.getByTestId('mode-native')
  const chatTab = page.getByTestId('mode-chat')
  await expect(nativeTab).toHaveAttribute('aria-selected', 'true')

  // Reproduce the direction reported in the live session: select native and
  // leave enough time for a stale layout feed to arrive after the click.
  await chatTab.click()
  await expect(chatTab).toHaveAttribute('aria-selected', 'true')
  await nativeTab.click()
  await expect(nativeTab).toHaveAttribute('aria-selected', 'true')
  await page.waitForTimeout(5_000)
  await expect(nativeTab).toHaveAttribute('aria-selected', 'true')
})

test('a stored collapsed layout paints collapsed — the default branch never mounts', async ({
  page,
}) => {
  // POD-571. POD-540 made the stored value WIN; it still arrived late, so the
  // shell mounted its default branch — the 292px sidebar, the 360px Flight Deck —
  // and swapped when the network answered. Both are cheap to prove and expensive
  // to eyeball, so the oracle is a MutationObserver installed before app code:
  // it records every node the shell inserts, which means a subtree that mounts
  // for a single frame and unmounts is still caught. A screenshot cannot make
  // that claim — it samples, and this is precisely a thing that hides between
  // samples.
  await page.setViewportSize({ width: 1280, height: 820 })
  await openApp(page)
  await page.waitForFunction(
    () => !!(window as unknown as { __podium?: unknown }).__podium,
    undefined,
    { timeout: 30_000 },
  )

  const expandedSidebar = '[aria-label="Collapse sidebar"]'
  const expandedFlightDeck = 'aside[aria-label="Flight Deck"]'

  // Collapse both columns the way a user does, so the server rows are written
  // through the real command path rather than planted.
  await expect(page.locator(expandedFlightDeck)).toBeVisible({ timeout: 30_000 })
  await page.getByTitle('Collapse Flight Deck').click()
  await expect(page.locator('[data-flight-deck-mode="folded"]')).toBeVisible()
  await page.locator(expandedSidebar).click()
  await expect(page.locator('aside.collapsed-sidebar')).toBeVisible()

  // Replicated layout writes are optimistic; cross the durable Outbox boundary
  // before a process-losing reload, exactly as the specs above do.
  await page.waitForTimeout(1_000)

  // The probe records the COLLAPSED forms as well as the expanded ones, and the
  // assertion below requires both answers. A probe that only ever reports
  // `false` is indistinguishable from a probe that never ran — and this one is
  // asserting an absence, which is exactly the shape that passes for the wrong
  // reason. Seeing the folded bar and the rail appear is what proves it was
  // watching at all.
  await page.addInitScript(() => {
    const seen = { sidebar: false, flightDeck: false, rail: false, foldedBar: false }
    ;(window as unknown as { __firstPaintProbe: typeof seen }).__firstPaintProbe = seen
    const check = (): void => {
      if (document.querySelector('[aria-label="Collapse sidebar"]')) seen.sidebar = true
      if (document.querySelector('aside[aria-label="Flight Deck"]')) seen.flightDeck = true
      if (document.querySelector('aside.collapsed-sidebar')) seen.rail = true
      if (document.querySelector('[data-flight-deck-mode="folded"]')) seen.foldedBar = true
    }
    // Observe `document`, NOT `document.documentElement`: an init script runs at
    // document-start, where the element can still be null — and `observe(null)`
    // throws AFTER the probe object is already on `window`, which reads at the
    // assertion exactly like "watched everything, saw nothing". `document` is
    // always there and `subtree: true` covers the same nodes.
    new MutationObserver(check).observe(document, { childList: true, subtree: true })
    check()
  })

  await page.reload()
  await page.waitForFunction(() => !document.querySelector('.app-loading'), undefined, {
    timeout: 45_000,
  })
  // Settle first: the probe's claim is only worth making once the layout the
  // server holds has certainly had time to arrive and repaint.
  await expect(page.locator('aside.collapsed-sidebar')).toBeVisible({ timeout: 30_000 })
  await expect(page.locator('[data-flight-deck-mode="folded"]')).toBeVisible({ timeout: 30_000 })
  await page.waitForTimeout(2_000)

  const probe = await page.evaluate(
    () => (window as unknown as { __firstPaintProbe: unknown }).__firstPaintProbe,
  )

  // Put the columns back BEFORE asserting. Layout is per-USER state on a server
  // this file's tests share, so a collapsed shell is not this test's private
  // business — it is the width the other tests lay out inside. Restoring after
  // the assertion would skip exactly when it matters: a failure here would then
  // fail a neighbour too, and the second failure is the one that sends the
  // reader to the wrong file.
  //
  // Belt and braces, because this test is LAST for the same reason: the tests
  // above share that state with each other already and are order-sensitive about
  // it (POD-709), so a new test in the middle changes which of them loses.
  await page.locator('[aria-label="Expand Flight Deck"]').first().click()
  await expect(page.locator(expandedFlightDeck)).toBeVisible()
  await page.locator('[aria-label="Expand sidebar"]').click()
  await expect(page.locator(expandedSidebar)).toBeVisible()
  await page.waitForTimeout(1_000)

  expect(probe).toEqual({ sidebar: false, flightDeck: false, rail: true, foldedBar: true })
})
