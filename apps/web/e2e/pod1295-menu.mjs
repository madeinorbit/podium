import { chromium } from '@playwright/test'

const base = process.env.BASE || 'http://127.0.0.1:19322'
const out = process.env.SHOT_DIR
const target = process.env.TARGET_DIR
const browser = await chromium.launch()
const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } })
const page = await ctx.newPage()
page.on('console', (m) => { if (m.type() === 'error') console.log('CONSOLE ERROR:', m.text().slice(0, 200)) })
const snap = async (n) => { await page.waitForTimeout(600); await page.screenshot({ path: `${out}/${n}.png` }) }

await page.goto(base, { waitUntil: 'networkidle' })
await page.waitForTimeout(1500)
// The instance already onboarded once; the picker may be behind "Pick a project".
const pick = page.getByRole('button', { name: 'Pick a project', exact: true })
if (await pick.count()) await pick.first().click()
await page.waitForTimeout(1200)

const pathField = page.getByLabel('Folder path')
await pathField.fill(target)
await pathField.press('Enter')
await page.waitForTimeout(1500)
console.log('AT:', await pathField.inputValue())

// No pencil anywhere.
console.log('PENCIL BUTTONS:', await page.getByRole('button', { name: /^Rename folder/ }).count())

// Right-click a plain folder row.
await page.getByRole('button', { name: 'Open folder existing' }).click({ button: 'right' })
await page.waitForTimeout(400)
await snap('40-menu-folder')
const items = await page.getByRole('menuitem').allTextContents()
console.log('FOLDER MENU:', JSON.stringify(items))
const menuBox = await page.getByRole('menu').boundingBox()
const rowBox = await page.getByRole('button', { name: 'Open folder existing' }).boundingBox()
console.log('MENU BOX:', JSON.stringify(menuBox), 'ROW y:', rowBox?.y)

// Right-click a repo row: it gets one more item.
await page.keyboard.press('Escape')
await page.waitForTimeout(300)
console.log('DIALOG STILL OPEN AFTER ESCAPE:', await page.getByRole('dialog').count())
await page.getByRole('button', { name: 'Open folder myrepo' }).click({ button: 'right' })
await page.waitForTimeout(400)
await snap('41-menu-repo')
console.log('REPO MENU:', JSON.stringify(await page.getByRole('menuitem').allTextContents()))

// Rename through the menu.
await page.getByRole('menuitem', { name: 'Rename…' }).click()
await page.waitForTimeout(400)
await snap('42-renaming')
const field = page.getByLabel('Rename folder myrepo')
await field.fill('weather-tiles')
await field.press('Enter')
await page.waitForTimeout(1500)
await snap('43-renamed')
console.log('LISTED:', (await page.evaluate(() => document.body.innerText)).includes('weather-tiles'))
await browser.close()
