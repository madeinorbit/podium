import { expect, type Page, test } from '@playwright/test'
import { gotoWorkspace, newSession, openApp } from './_harness'

// Drag-to-reorder is desktop-only chrome (the mobile header has its own strip
// without dnd); pointer-based dragging also needs a real mouse.
test.skip(({ isMobile }) => isMobile, 'desktop tab strip only')

const tabOrder = (page: Page): Promise<string[]> =>
  page.$$eval('.tabbar-tabs .tab-wrap', (els) =>
    els.map((el) => (el as HTMLElement).dataset.session ?? ''),
  )

async function dragTab(page: Page, from: string, to: string): Promise<void> {
  const src = page.locator(`.tab-wrap[data-session="${from}"]`)
  const dst = page.locator(`.tab-wrap[data-session="${to}"]`)
  const a = await src.boundingBox()
  const b = await dst.boundingBox()
  if (!a || !b) throw new Error('tab not visible')
  // PointerSensor arms after a 5px move; step through so dnd-kit sees the motion.
  await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2)
  await page.mouse.down()
  await page.mouse.move(a.x + a.width / 2 + 10, a.y + a.height / 2, { steps: 4 })
  await page.mouse.move(b.x + b.width * 0.8, b.y + b.height / 2, { steps: 12 })
  await page.mouse.up()
}

test('dragging a tab reorders the strip and the order survives a reload', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 820 })
  await openApp(page)
  // Earlier specs in the same suite run may have left sessions in this worktree
  // (the harness relay is shared) — assert on the two tabs THIS test creates.
  const preexisting = new Set(await tabOrder(page))
  await newSession(page, 'Shell')
  await newSession(page, 'Shell')
  await expect
    .poll(async () => (await tabOrder(page)).filter((id) => !preexisting.has(id)).length, {
      timeout: 15_000,
    })
    .toBe(2)

  const mine = (order: string[]): string[] => order.filter((id) => !preexisting.has(id))
  const [first, second] = mine(await tabOrder(page))
  await dragTab(page, first, second)
  await expect
    .poll(async () => mine(await tabOrder(page)), { timeout: 10_000 })
    .toEqual([second, first])

  // The order is persisted server-side, so a fresh page sees it.
  await page.reload()
  await gotoWorkspace(page) // a fresh page lands on home; the strip lives in the workspace
  await expect
    .poll(async () => mine(await tabOrder(page)), { timeout: 20_000 })
    .toEqual([second, first])
})

test('the +/split actions stay fixed outside the scrolling strip', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 820 })
  await openApp(page)
  await newSession(page, 'Shell')
  // Structural: actions are siblings of the scroll container, not inside it.
  expect(await page.locator('.tabbar > .tabbar-actions .tab-add').count()).toBe(1)
  expect(await page.locator('.tabbar > .tabbar-actions .tab-split').count()).toBe(1)
  expect(await page.locator('.tabbar-tabs .tab-add').count()).toBe(0)
})
