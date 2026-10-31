// Screenshot the flight deck harness (POD-2027). Start it first with
// `bunx vite --config vite.deck-harness.config.ts` from apps/web.
// Usage: DECK_WIDTH=525 bun harness/deck-shots.ts <outDir> [mission...]
import { chromium } from '@playwright/test'

const out = process.argv[2] ?? '.'
const missions = process.argv.slice(3).length ? process.argv.slice(3) : ['filters', 'asking']
const browser = await chromium.launch({
  executablePath: `${process.env.HOME}/.cache/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-linux64/chrome-headless-shell`,
})
const page = await browser.newPage({ viewport: { width: 1200, height: 900 }, deviceScaleFactor: 2 })
const errors: string[] = []
await page.clock.setFixedTime(new Date('2026-01-01T00:30:00.000Z'))
const width = Number(process.env.DECK_WIDTH ?? 525)
const theme = process.env.DECK_THEME ?? 'dark'
page.on('pageerror', (e) => errors.push(String(e.stack ?? e)))
page.on('console', (m) => m.type() === 'error' && errors.push(m.text()))
await page.goto('http://localhost:55601/harness/deck.html')
await page.waitForFunction(() => 'deck' in window, null, { timeout: 30_000 }).catch(() => {})
// DECK_CSS tries a style variant without editing styles.css.
if (process.env.DECK_CSS) await page.addStyleTag({ content: process.env.DECK_CSS })
const variant = process.env.DECK_VARIANT ? `-${process.env.DECK_VARIANT}` : ''
for (const mission of missions) {
  await page.evaluate((m) => (window as never as { deck: { setMission: (m: string) => void } }).deck.setMission(m), mission)
  await page.evaluate((w) => (window as never as { deck: { setWidth: (w: number) => void } }).deck.setWidth(w), width)
  await page.evaluate((t) => (window as never as { deck: { setTheme: (t: string) => void } }).deck.setTheme(t), theme)
  await page.waitForTimeout(1500)
  const shell = page.locator('[data-flight-deck-shell]')
  await shell.screenshot({ path: `${out}/deck-${mission}-${width}-${theme}${variant}.png` }).catch((e) => errors.push(String(e)))
  const facts = await page.evaluate(() => ({
    viewGroup: !!document.querySelector('[role="group"][aria-label="Deck view"]'),
    foldAll: !!document.querySelector('[aria-label="Fold every branch"],[aria-label="Expand every branch"]'),
    filters: [...document.querySelectorAll('[aria-label="Task filters"] button')].map((b) => b.textContent),
    eyebrowButtons: [...document.querySelectorAll('.deck-eyebrow-chevron')].map((b) => [...b.parentElement!.querySelectorAll('button')].map((x) => x.getAttribute('aria-label'))),
  }))
  console.log(mission, JSON.stringify(facts))
}
console.log('errors', JSON.stringify(errors.slice(0, 8)))
await browser.close()
