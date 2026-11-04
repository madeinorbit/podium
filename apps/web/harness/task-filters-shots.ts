// Screenshot the Tasks filters harness (POD-6294). Start it first with
// `bunx vite --config vite.harness.config.ts` from apps/web.
// Usage: bun harness/task-filters-shots.ts <outDir>
import { chromium } from '@playwright/test'

const out = process.argv[2] ?? '.'
const browser = await chromium.launch({
  executablePath: `${process.env.HOME}/.cache/ms-playwright/chromium_headless_shell-1248/chrome-headless-shell-linux64/chrome-headless-shell`,
})
const page = await browser.newPage({ viewport: { width: 900, height: 560 }, deviceScaleFactor: 2 })
page.setDefaultTimeout(8000)
const errors: string[] = []
page.on('pageerror', (e) => errors.push(String(e.stack ?? e)))
page.on('console', (m) => m.type() === 'error' && errors.push(m.text()))
const closeMenus = async (): Promise<void> => {
  for (let i = 0; i < 3 && (await page.locator('[role="menu"]').count()) > 0; i++) {
    await page.keyboard.press('Escape')
    await page.waitForTimeout(250)
  }
}
await page.goto('http://localhost:55599/harness/task-filters.html')
await page.getByTestId('tasks-filter-trigger').waitFor()

// 1. The rows name their assignees; the Filter menu at its default.
await page.getByTestId('tasks-filter-trigger').click()
await page.getByRole('menuitem', { name: 'Assigned to' }).hover()
await page.getByRole('menuitemradio', { name: 'All users' }).waitFor()
await page.screenshot({ path: `${out}/task-filters-assigned-to.png` })

// 2. All users and Show agent tasks on: the trigger counts 2 and offers Reset.
await page.getByRole('menuitemradio', { name: 'All users' }).click()
await closeMenus()
await page.getByTestId('tasks-filter-trigger').click()
await page.getByRole('menuitemcheckbox', { name: 'Show agent tasks' }).click()
await closeMenus()
await page.getByTestId('tasks-filter-trigger').click()
await page.getByRole('menuitem', { name: 'Reset filters' }).waitFor()
await page.screenshot({ path: `${out}/task-filters-count-reset.png` })
await closeMenus()

// 3. Display no longer carries Show agent tasks.
await page.getByTitle('Display').click()
await page.getByRole('menuitemradio').first().waitFor()
await page.screenshot({ path: `${out}/task-filters-display.png` })

const facts = await page.evaluate(() => ({
  probe: window.probe,
  count: document.querySelector('[data-testid="tasks-filter-count"]')?.textContent,
  avatars: [...document.querySelectorAll('[aria-label^="Assignee:"]')].map((a) => [
    a.getAttribute('aria-label'),
    a.textContent,
  ]),
  displayHasAgentTasks: [...document.querySelectorAll('[role="menuitemcheckbox"]')].some((e) =>
    e.textContent?.includes('Show agent tasks'),
  ),
}))
console.log(JSON.stringify(facts))
console.log('errors', JSON.stringify(errors.slice(0, 8)))
await browser.close()
