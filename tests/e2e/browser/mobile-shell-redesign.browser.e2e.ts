/**
 * Mobile shell redesign (#45, .design/specs/mobile.md): the 44px header wears
 * the issue tint on the workspace and reverts to neutral on home/superagent;
 * the one context dropdown is the panel selector (ID square, active panel
 * name, +N count, ▾/▴ caret) whose menu rows carry the kind label and pin/kill;
 * the "+" and panel menus are mutually exclusive; the ✦ cell toggles the
 * full-screen Tray + Super agent overlay with a ⌄ minimize; and the terminal
 * key bar is the bordered-key strip pinned via --viewport-h / --kb-open.
 *
 * Driven against the real harness relay in the mobile device projects.
 */
import { expect, type Page, test } from '@playwright/test'
import { newSession, openApp, podium } from './_harness'

test.skip(({ isMobile }) => !isMobile, 'mobile layout only')
// Cold start (relay boot + first agent spawn) eats most of the default budget.
test.setTimeout(120_000)

/** Resolve a CSS colour expression INSIDE `selector`'s subtree, so var()
 *  chains (--issue → --flow, --card) resolve exactly as the element sees them. */
async function resolveColorIn(page: Page, selector: string, expr: string): Promise<string> {
  return page.evaluate(
    ({ sel, e }) => {
      const host = document.querySelector(sel)
      if (!host) throw new Error(`no ${sel}`)
      const el = document.createElement('div')
      el.style.backgroundColor = e
      host.appendChild(el)
      const out = getComputedStyle(el).backgroundColor
      el.remove()
      return out
    },
    { sel: selector, e: expr },
  )
}

async function headerBg(page: Page): Promise<string> {
  return page.getByTestId('mobile-header').evaluate((el) => getComputedStyle(el).backgroundColor)
}

test('header tint, panel dropdown, menu exclusivity, home, superagent overlay', async ({
  page,
}) => {
  await openApp(page) // lands in the workspace via the home work list

  // ── Workspace header: issue-tinted chrome (§2.1) ─────────────────────────
  // No colour assigned → the slate flow, but still the 16% mix over card.
  const tinted = await resolveColorIn(
    page,
    '[data-testid="mobile-header"]',
    'color-mix(in srgb, var(--issue) 16%, var(--card))',
  )
  // Poll: the click that entered the workspace commits the view change a frame
  // before styles settle on slower runs.
  await expect.poll(() => headerBg(page), { timeout: 10_000 }).toBe(tinted)

  // ── The context dropdown is the panel selector ───────────────────────────
  const trigger = page.getByLabel('Select panel')
  await expect(trigger).toBeVisible()
  await expect(trigger).toContainText('▾')
  await trigger.click()
  const menu = page.getByTestId('mobile-panel-menu')
  await expect(menu).toBeVisible()
  await expect(trigger).toContainText('▴')
  // Rows: kind label + pin + kill on session rows (§2.3).
  await expect(menu.getByRole('button', { name: 'Pin panel' }).first()).toBeVisible()
  expect(await menu.locator('button[title="Kill session"]').count()).toBeGreaterThanOrEqual(1)
  // The pane behind dims while the menu is open.
  await expect(page.locator('.mobile-shell .opacity-55').first()).toBeVisible()

  // ── #97 mutual exclusion: "+" closes the panel menu and vice versa ───────
  await page.locator('button[aria-label="New panel"]:visible').first().click()
  await expect(menu).toBeHidden()
  await expect(page.getByRole('menuitem', { name: 'New Claude' })).toBeVisible()
  await trigger.click()
  await expect(page.getByRole('menuitem', { name: 'New Claude' })).toBeHidden()
  await expect(page.getByTestId('mobile-panel-menu')).toBeVisible()
  // Selecting a row closes the menu and stays in the workspace.
  await page
    .getByTestId('mobile-panel-menu')
    .locator('button.flex-1, button.cursor-pointer')
    .first()
    .click()
  await expect(page.getByTestId('mobile-panel-menu')).toBeHidden()

  // ── Home: neutral header, lit Home cell, bottom utility row (§2.2) ───────
  await page.locator('button[title="Tasks"]').click()
  const neutral = await resolveColorIn(page, '[data-testid="mobile-header"]', 'var(--card)')
  await expect.poll(() => headerBg(page), { timeout: 10_000 }).toBe(neutral)
  await expect(page.locator('button[title="Tasks"]')).toHaveClass(/text-attention/)
  await expect(page.getByTestId('project-group-label').first()).toBeVisible()
  await expect(page.getByLabel('Add repo')).toBeVisible()

  // ── Superagent overlay (§2.4): ✦ toggles, Tray on top, ⌄ minimizes ──────
  await page.locator('button[title="Superagent"]').click()
  const overlay = page.getByTestId('mobile-super-overlay')
  await expect(overlay).toBeVisible()
  await expect(page.locator('button[title="Superagent"]')).toHaveClass(/text-attention/)
  await expect(overlay.getByTestId('tray-bar')).toHaveCount(0)
  await expect(overlay.getByTestId('super-bar')).toBeVisible()
  await expect(overlay.locator('[data-superagent-composer]')).toBeVisible()
  await overlay.locator('button[title="Minimize"]').click()
  await expect(overlay).toBeHidden()
  await expect(page.locator('button[title="Superagent"]')).not.toHaveClass(/text-attention/)
})

test('the 768px boundary splits the shells exactly; desktop stays desktop', async ({
  page,
  browserName,
}) => {
  test.skip(browserName !== 'chromium', 'viewport resizing is reliable on Chromium only')
  await openApp(page)
  await page.setViewportSize({ width: 768, height: 900 })
  await expect(page.locator('.mobile-shell')).toBeVisible()
  await expect(page.locator('.desktop-shell')).toHaveCount(0)
  await page.setViewportSize({ width: 769, height: 900 })
  await expect(page.locator('.desktop-shell')).toBeVisible()
  await expect(page.locator('.mobile-shell')).toHaveCount(0)
})

test('key bar: bordered keys, tinted submit, live input, viewport pinning', async ({ page }) => {
  await openApp(page)
  await newSession(page, 'Claude') // the harness keyecho fake
  await page.waitForFunction(
    () => {
      const w = window as unknown as { __podium?: { screenText(): string } }
      return /keyecho/.test(w.__podium?.screenText() ?? '')
    },
    undefined,
    { timeout: 15_000 },
  )

  // [spec:SP-7696] Click the explicit mobile affordance, then prove input still
  // reaches the real PTY below. An already-controlling client need not bump epoch.
  const takeControl = page.getByTestId('take-control')
  await expect(takeControl).toBeVisible()
  await takeControl.click()

  // The two key rows are visible in native mode, restyled to bordered keys.
  const actions = page.locator('.key-actions:visible')
  await expect(actions).toHaveCount(1)
  const submit = actions.locator('.key-act.key-submit')
  await expect(submit).toHaveText('⏎ Submit')
  // The design's tinted ⏎ (#e8c477).
  expect(await submit.evaluate((el) => getComputedStyle(el).color)).toBe('rgb(232, 196, 119)')
  const toolbar = page.locator('.toolbar:visible')
  await expect(toolbar).toHaveCount(1)
  for (const key of ['Esc', 'Tab', 'Ctrl']) {
    await expect(toolbar.locator(`button[data-key="${key}"]`)).toBeVisible()
  }

  // A tapped key reaches the PTY: Esc echoes as 0x1b in keyecho.
  await toolbar.locator('button[data-key="Esc"]').click()
  let seen = ''
  await expect
    .poll(
      async () => {
        seen += await podium.screen(page)
        return /\b1b\b|Esc/i.test(seen)
      },
      { timeout: 10_000 },
    )
    .toBe(true)

  // The shell is pinned to --viewport-h (the visualViewport keyboard mechanism,
  // #mnotes item 6 — kept byte-for-byte), and the key-bar padding carries the
  // --kb-open safe-area math.
  await page.evaluate(() => document.documentElement.style.setProperty('--viewport-h', '500px'))
  const shellH = await page
    .locator('.mobile-shell')
    .evaluate((el) => el.getBoundingClientRect().height)
  expect(Math.round(shellH)).toBe(500)
  await page.evaluate(() => document.documentElement.style.removeProperty('--viewport-h'))
  const kbRuleWired = await page.evaluate(() => {
    for (const sheet of Array.from(document.styleSheets)) {
      let rules: CSSRuleList
      try {
        rules = sheet.cssRules
      } catch {
        continue
      }
      for (const rule of Array.from(rules)) {
        if (rule.cssText.includes('.toolbar') && rule.cssText.includes('--kb-open')) return true
      }
    }
    return false
  })
  expect(kbRuleWired).toBe(true)
})
