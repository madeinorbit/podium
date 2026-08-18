import { chromium } from '@playwright/test'

const base = 'http://127.0.0.1:19321'
const out = process.env.SHOT_DIR
const target = process.env.TARGET_DIR
const browser = await chromium.launch()
const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } })
const page = await ctx.newPage()
page.on('console', (m) => { if (m.type() === 'error') console.log('CONSOLE ERROR:', m.text().slice(0, 300)) })
const snap = async (name) => {
  await page.waitForTimeout(700)
  await page.screenshot({ path: `${out}/${name}.png` })
}

await page.goto(base, { waitUntil: 'networkidle' })
await page.waitForTimeout(1500)
await page.getByRole('button', { name: 'Pick a project', exact: true }).first().click()
await page.waitForTimeout(900)

// Navigate to a scratch directory instead of writing into the real home.
const pathField = page.getByLabel('Folder path')
await pathField.fill(target)
await pathField.press('Enter')
await page.waitForTimeout(1200)
console.log('AT:', await pathField.inputValue())
await snap('30-at-target')

// --- rename an existing folder -------------------------------------------
await page.getByRole('button', { name: 'Rename folder existing' }).click()
const renameField = page.getByLabel('Rename folder existing')
await renameField.fill('renamed-folder')
await snap('31-renaming')
await renameField.press('Enter')
await page.waitForTimeout(1500)
console.log('AFTER RENAME:', (await page.evaluate(() => document.body.innerText)).match(/renamed-folder/) ? 'renamed-folder listed' : 'NOT FOUND')

// --- create a plain folder ------------------------------------------------
await page.getByRole('button', { name: 'New folder' }).click()
const folderField = page.getByLabel('New folder name')
await folderField.fill('workspace')
await folderField.press('Enter')
await page.waitForTimeout(1500)
await snap('32-folder-made')

// --- duplicate name is refused, in the row ---------------------------------
await page.getByRole('button', { name: 'New folder' }).click()
const dupField = page.getByLabel('New folder name')
await dupField.fill('workspace')
await dupField.press('Enter')
await page.waitForTimeout(1200)
const alert = await page.locator('[role="alert"]').first().textContent().catch(() => null)
console.log('DUPLICATE ERROR:', alert)
await snap('33-duplicate-refused')
await dupField.press('Escape')
await page.waitForTimeout(500)

// --- create the repository -------------------------------------------------
await page.getByRole('button', { name: 'New repository' }).click()
const repoField = page.getByLabel('New repository name')
await repoField.fill('flight-planner')
await snap('34-naming-repo')
await page.getByRole('button', { name: 'Create repository' }).click()
await page.waitForTimeout(6000)
await snap('35-after-create')
console.log('AFTER CREATE:', (await page.evaluate(() => document.body.innerText)).slice(0, 400))
await browser.close()
