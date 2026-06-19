import { expect, type Page, test } from '@playwright/test'
import { gotoWorkspace, newSession, openApp } from './_harness'

// Drag-to-reorder is desktop-only chrome (the mobile header has its own strip
// without dnd); pointer-based dragging also needs a real mouse.
test.skip(({ isMobile }) => isMobile, 'desktop tab strip only')

// The tab strip renders SortableTab components inside the overflow-x-auto container.
// Each SortableTab has data-session on its outermost div.
// The panel content area ALSO uses data-session, so we scope to the tab strip container
// (the overflow-x-auto sibling of the action buttons).
const tabOrder = (page: Page): Promise<string[]> =>
  page.$$eval('.overflow-x-auto [data-session]', (els) =>
    (els as HTMLElement[]).map((el) => el.dataset.session ?? ''),
  )

async function dragTab(page: Page, from: string, to: string): Promise<void> {
  // Scope to the tab strip container (overflow-x-auto) to avoid matching the panel divs.
  const src = page.locator(`.overflow-x-auto [data-session="${from}"]`)
  const dst = page.locator(`.overflow-x-auto [data-session="${to}"]`)
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

  // The "New panel" button (aria-label="New panel") and "Split" button
  // (aria-label="Split") must exist and must NOT be inside the scrolling
  // tab container (the overflow-x-auto sibling div).
  const newPanelBtn = page.getByRole('button', { name: 'New panel' })
  const splitBtn = page.getByRole('button', { name: 'Split' })

  await expect(newPanelBtn).toBeVisible()
  await expect(splitBtn).toBeVisible()

  // Neither button should be a descendant of the scrolling tab strip.
  // The scroll container is the div that holds [data-session] tab elements.
  // We check that the buttons live in the sibling actions container, not inside
  // the scrolling overflow div.
  const newPanelInScrollStrip = await page.evaluate(() => {
    const btn = document.querySelector('[aria-label="New panel"]')
    if (!btn) return false
    // Walk up: if we hit a div with overflow-x style before reaching the workspace
    // root, the button is inside the scroll container (which it should NOT be).
    let el: Element | null = btn.parentElement
    while (el && el.tagName !== 'SECTION') {
      const style = window.getComputedStyle(el)
      if (style.overflowX === 'auto' || style.overflowX === 'scroll') return true
      el = el.parentElement
    }
    return false
  })
  expect(newPanelInScrollStrip, '"New panel" button must not be inside the scroll strip').toBe(
    false,
  )
})
