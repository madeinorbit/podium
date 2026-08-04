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
