/**
 * POD-1201 verification shots: the three spawn surfaces, against a real instance.
 *
 * Drives the branch's dev server (which proxies the API to the live daemon) and
 * captures each menu open, so the greying can be read rather than argued about.
 * The live host runs claude-code/codex/grok and has cursor NOT installed and
 * opencode signed out — every state this change draws, on one machine.
 *
 * Point it at a dev server for THIS branch (`cd apps/web && bunx vite --port
 * <free> --host 127.0.0.1`), which proxies the API to the live daemon:
 *
 *   P1201_ORIGIN=http://127.0.0.1:<port> \
 *   PODIUM_SESSION_COOKIE=$(podium auth mint-session) \
 *   bun apps/web/e2e/pod1201-shots.ts <outDir>
 *
 * It acts on the LIVE instance. See `closeMenus` below for the one way that
 * bites.
 */
import { chromium } from 'playwright'

const ORIGIN = process.env.P1201_ORIGIN ?? 'http://127.0.0.1:55731'
const COOKIE = process.env.PODIUM_SESSION_COOKIE ?? ''
const OUT = process.argv[2] ?? '/tmp/pod1201'

const browser = await chromium.launch()
const ctx = await browser.newContext({ viewport: { width: 1500, height: 950 } })
if (COOKIE) {
  await ctx.addCookies([
    {
      name: 'podium_session',
      value: COOKIE,
      domain: '127.0.0.1',
      path: '/',
      httpOnly: false,
      secure: false,
    },
  ])
}
const page = await ctx.newPage()
page.on('console', (m) => {
  if (m.type() === 'error') console.log(`[console] ${m.text().slice(0, 200)}`)
})
// Generous: the dev server transforms the module graph on first navigation, and
// this box is often also running the test suite.
page.setDefaultTimeout(120_000)
await page.goto(ORIGIN, { waitUntil: 'domcontentloaded', timeout: 180_000 })
await page.waitForTimeout(9000)
await page.screenshot({ path: `${OUT}/00-shell.png` })

/** Every menu row's label + the trailing hint + whether it refuses a click. */
const rows = async (): Promise<unknown> =>
  page.evaluate(() =>
    [...document.querySelectorAll('[role="menuitem"]')].map((el) => ({
      text: (el.textContent ?? '').trim(),
      disabled: el.getAttribute('data-disabled') !== null || el.getAttribute('aria-disabled'),
      refused: el.getAttribute('data-refused'),
      title: el.getAttribute('title'),
    })),
  )

async function shot(name: string): Promise<void> {
  await page.screenshot({ path: `${OUT}/${name}.png` })
  console.log(`\n=== ${name} ===`)
  console.log(JSON.stringify(await rows(), null, 1))
}

/**
 * EVERY MENU MUST BE CLOSED BEFORE THE NEXT CLICK.
 *
 * The sidebar menu's agent rows are sub-TRIGGERS that spawn on click as well as
 * opening their submenu, so a click aimed at the column while that menu is still
 * up starts a real agent on the real instance. This probe did exactly that and
 * left two empty draft issues behind. Escape, then WAIT for the menu to be gone
 * — never assume the keystroke landed.
 */
async function closeMenus(): Promise<void> {
  for (let i = 0; i < 6; i++) {
    if ((await page.locator('[role="menu"]').count()) === 0) return
    await page.keyboard.press('Escape')
    await page.waitForTimeout(400)
  }
  throw new Error('a menu is still open — refusing to click, that would spawn an agent')
}

//
// 1. The sidebar's `New <Agent> in <Repo>` chevron.
const chevron = page.getByRole('button', { name: 'Choose agent and repo' }).first()
if (await chevron.count()) {
  await chevron.click()
  await page.waitForTimeout(700)
  await shot('01-sidebar-new-agent')
  await closeMenus()
} else {
  console.log('sidebar chevron not found')
}

The
deck
;('s `Add agent` and the tab strip')
s
;('+')
only
exist
once
a
mission
is
// selected and a pane is open, so pick the first task in the sidebar first.
await closeMenus()
const row = page.locator('[data-issue-row]').first()
console.log('work rows:', await page.locator('[data-issue-row]').count())
if (await row.count()) {
  await row.click()
  await page.waitForTimeout(1200)
  // The deck's single-click action is deferred by the double-click window.
  await row.click()
  await page.waitForTimeout(3500)
  await page.screenshot({ path: `${OUT}/01b-after-task-click.png` })
}
console.log(
  'buttons:',
  JSON.stringify(
    await page.evaluate(() =>
      [...document.querySelectorAll('button[aria-label]')]
        .map((b) => b.getAttribute('aria-label'))
        .slice(0, 60),
    ),
  ),
)

// 2. The flight deck's `Add agent` (needs a mission selected).
const addAgent = page.getByRole('button', { name: 'Add agent to mission' }).first()
if (await addAgent.count()) {
  await addAgent.click()
  await page.waitForTimeout(700)
  await shot('02-deck-add-agent')
  await closeMenus()
  await page.waitForTimeout(400)
} else {
  console.log('Add agent not found — no mission selected')
}

// 3. The tab strip's "+" — the resume region should be gone.
const plus = page.getByRole('button', { name: 'New panel' }).first()
if (await plus.count()) {
  await plus.click()
  await page.waitForTimeout(700)
  await shot('03-tabstrip-plus')
  console.log('history field present:', await page.getByLabel('Search history').count())
  await page.keyboard.press('Escape')
} else {
  console.log('New panel + not found')
}

await browser.close()
