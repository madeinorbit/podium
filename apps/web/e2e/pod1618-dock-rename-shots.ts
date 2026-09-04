/**
 * POD-1618 verification shots: the task panel naming a draft, and renaming it.
 *
 * Drives the harness (`harness/dock-rename-entry.tsx`), which mounts the
 * shipping `IssueExplorer` against the real stylesheet with a stubbed store, so
 * the frames are the dock column an operator actually reads.
 *
 *   cd apps/web && bunx vite --config vite.explorer-harness.config.ts
 *   bun apps/web/e2e/pod1618-dock-rename-shots.ts <outDir>
 */
import { chromium } from 'playwright'

const ORIGIN = process.env.P1618_ORIGIN ?? 'http://127.0.0.1:55604'
const OUT = process.argv[2] ?? '/tmp/pod1618'

const browser = await chromium.launch()
const ctx = await browser.newContext({
  viewport: { width: 360, height: 900 },
  deviceScaleFactor: 2,
  colorScheme: 'dark',
})
const page = await ctx.newPage()
page.on('console', (m) => {
  if (m.type() === 'error') console.log(`[console] ${m.text().slice(0, 300)}`)
})
page.on('pageerror', (e) => console.log(`[pageerror] ${String(e).slice(0, 300)}`))
page.setDefaultTimeout(60_000)

await page.goto(`${ORIGIN}/harness/dock-rename.html`, { waitUntil: 'networkidle' })
await page.waitForSelector('[data-right-dock-panel="issue"]')
await page.waitForTimeout(700)

const dock = page.locator('[data-right-dock-panel="issue"]')
const title = page.locator('[data-testid="dock-title"]')

// 1. THE NAME. The stored title is the placeholder "Draft"; the head says what
//    the sidebar row says.
console.log('title:', await title.textContent())
await dock.screenshot({ path: `${OUT}/1-draft-named.png` })

// 2. THE MENU. `Rename` exists here only because the head has an editor for it
//    to open — the entry is gated on an `onRename` this panel used to omit.
await page.getByLabel('More issue actions').click()
await page.waitForTimeout(350)
await page.screenshot({ path: `${OUT}/2-menu-rename.png` })
await page.keyboard.press('Escape')
await page.waitForTimeout(250)

// 3. THE EDITOR, opened by double-click, seeded with the name on screen and
//    standing exactly where that name was.
await title.dblclick()
await page.waitForTimeout(300)
console.log('editor value:', await dock.locator('input[type="text"]').inputValue())
await dock.screenshot({ path: `${OUT}/3-editor-open.png` })

// 4. THE WRITE. Enter commits; the head comes back wearing the new name (the
//    stub store applies the patch, as the replica does).
await dock.locator('input[type="text"]').fill('Artifact directive provenance, answered')
await page.keyboard.press('Enter')
await page.waitForTimeout(400)
console.log('after commit:', await title.textContent())
await dock.screenshot({ path: `${OUT}/4-renamed.png` })

await browser.close()
