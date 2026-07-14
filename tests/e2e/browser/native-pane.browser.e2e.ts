/**
 * Native agents pane redesign (#43, .design/specs/native-pane.md): the tab
 * strip, session header, model strip, terminal surface and prompt chrome are
 * tinted by the selected issue's colour (neutral slate flow when uncoloured),
 * and tabs carry the status grammar — braille spinner while working, still
 * amber dot when waiting on the human, nothing otherwise.
 *
 * Driven against the real harness relay: real sessions, real per-session hook
 * endpoints for agent phases, real Chromium pixels.
 */
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, type Page, test } from '@playwright/test'
import { harnessEnv } from '../harness-env'
import { newSession, RELAY } from './_harness'

test.skip(({ isMobile }) => isMobile, 'desktop native pane chrome')
// Cold-start discovery + real session spawns overrun the 30s default; siblings
// (engraved-column, reveal-refit) size the budget the same way.
test.setTimeout(120_000)

/**
 * Open the app WITHOUT the shared openApp's trailing gotoWorkspace step: both
 * tests here reach the workspace by creating their own issue and clicking its
 * row, so they don't need gotoWorkspace — and its internal 10s `aside` wait
 * loses the race on a cold-compiled bundle over an empty harness DB (the
 * app-shell paint can exceed 10s on the very first load after a rebuild),
 * which would drop it to the mobile 'Work' path and hang. app-loading itself
 * gets the full 45s window here. */
async function openAppBare(page: Page): Promise<void> {
  await page.addInitScript(() => localStorage.setItem('podium.panelMode', 'native'))
  await page.goto(`/?server=${RELAY}&e2e=1`)
  await page.waitForFunction(() => !document.querySelector('.app-loading'), undefined, {
    timeout: 45_000,
  })
  const repoDialog = page.getByRole('dialog', { name: 'Find repositories' })
  if (await repoDialog.isVisible().catch(() => false)) {
    await repoDialog.getByRole('button', { name: 'Close' }).click()
  }
}

const HOOKS_DIR = join(harnessEnv(Number(process.env.PORT ?? 8799)).stateDir, 'hooks')

async function hookSettingsFiles(): Promise<Set<string>> {
  return new Set(await readdir(HOOKS_DIR).catch(() => []))
}

async function newHookUrl(existing: Set<string>): Promise<string | undefined> {
  const files = await hookSettingsFiles()
  const settingsFile = [...files].find((f) => !existing.has(f))
  if (!settingsFile) return undefined
  const settings = await readFile(join(HOOKS_DIR, settingsFile), 'utf8')
  return settings.match(/"url":\s*"([^"]+\/hooks\/[^"]+)"/)?.[1]
}

/** Fire a Claude Code hook event at the session's real hook endpoint. */
async function fireHook(url: string, payload: Record<string, unknown>): Promise<void> {
  const res = await fetch(url, { method: 'POST', body: JSON.stringify(payload) })
  expect(res.ok).toBe(true)
}

/** The browser's own resolution of a color-mix() expression, so assertions
 *  track the engine's rounding instead of hand-computed channel math. */
async function resolveColor(page: Page, expr: string): Promise<string> {
  return page.evaluate((e) => {
    const el = document.createElement('div')
    el.style.color = e
    document.body.appendChild(el)
    const out = getComputedStyle(el).color
    el.remove()
    return out
  }, expr)
}

/** JS twin of the app's mixHex (appearance.ts): inline-style backgrounds come
 *  back from getComputedStyle as rgb(), so assert those against the same
 *  channel math the app runs — not against CSS color-mix (which Chromium
 *  reports in color(srgb …) syntax). */
function mixRgb(color: string, base: string, pct: number): string {
  const ch = (hex: string, i: number) => parseInt(hex.slice(1 + i * 2, 3 + i * 2), 16)
  const mix = (i: number) => Math.round((ch(color, i) * pct + ch(base, i) * (100 - pct)) / 100)
  return `rgb(${mix(0)}, ${mix(1)}, ${mix(2)})`
}

/** The shell's live context colour: the resolved rgb of var(--issue) (the
 *  selected issue's palette colour, or the slate flow). Read via a probe div
 *  so the var chain (--issue → --flow) fully resolves. */
async function shellIssueColor(page: Page): Promise<{ rgb: string; hex: string }> {
  const rgb = await page.evaluate(() => {
    const host = document.querySelector('.desktop-shell') ?? document.body
    const el = document.createElement('div')
    el.style.backgroundColor = 'var(--issue)'
    host.appendChild(el)
    const out = getComputedStyle(el).backgroundColor
    el.remove()
    return out
  })
  const m = rgb.match(/rgb\((\d+), (\d+), (\d+)\)/)
  if (!m) throw new Error(`unexpected --issue colour format: ${rgb}`)
  const hex = `#${[m[1], m[2], m[3]].map((n) => Number(n).toString(16).padStart(2, '0')).join('')}`
  return { rgb, hex }
}

const SLATE = '#94a3b8'

/** Enter a workspace with a genuinely LIVE session by spawning into the harness
 *  repo's own worktree (the sidebar's empty-state "New <Agent> in <repo>"
 *  button). Issue-spawned sessions ("Start work now") run in the issue's
 *  worktree, which the throwaway harness repo can't create — they exit
 *  immediately, so they can't drive the status grammar or mount a terminal. */
async function enterHarnessWorkspace(page: Page): Promise<void> {
  await page
    .getByRole('button', { name: /^New .+ in .+/ })
    .first()
    .click({ timeout: 20_000 })
  await expect(page.getByTestId('native-tab-strip')).toBeVisible({ timeout: 20_000 })
}

/** Create an issue with real work through the board composer ("Start work
 *  now" spawns its session) and return its sidebar row. Owning the workspace
 *  keeps the test deterministic — the sidebar's top row shifts with whatever
 *  else is active on the machine, so specs never navigate by "first row". */
async function createIssueWithWork(
  page: Page,
  title: string,
): Promise<ReturnType<Page['getByTestId']>> {
  await page.getByRole('button', { name: 'Issues', exact: true }).click({ timeout: 15_000 })
  await page.getByRole('button', { name: 'New Issue', exact: true }).click()
  const composer = page.getByRole('dialog')
  await expect(composer.getByRole('heading', { name: 'New Issue' })).toBeVisible({
    timeout: 10_000,
  })
  await composer.getByLabel('Title').fill(title)
  await expect(composer.getByRole('checkbox', { name: 'Start work now' })).toBeChecked()
  const create = composer.getByRole('button', { name: /^Create$/ })
  await expect(create).toBeEnabled({ timeout: 15_000 })
  await create.click()
  await expect(composer).toBeHidden({ timeout: 30_000 })
  const row = page.getByTestId('unified-issue-row').filter({ hasText: title }).first()
  await expect(row).toBeVisible({ timeout: 30_000 })
  return row
}

test('tab strip, chrome and terminal are context-tinted; tabs carry the status grammar', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 820 })
  await openAppBare(page)

  // A live session in the harness repo's own worktree → the workspace is the
  // neutral slate flow (no issue selected), and the session actually goes live
  // so it can drive the status grammar and mount a terminal.
  await enterHarnessWorkspace(page)
  const strip = page.getByTestId('native-tab-strip')
  // Wait for the live session's tab + panel. Poll until the visible panel's id
  // also exists as a strip tab: an optimistic spawn reconciles a beat after the
  // panel first paints.
  let activeId: string | null = null
  await expect
    .poll(
      async () => {
        activeId = await page
          .locator('.flex.min-h-0 > div[data-session]:visible')
          .first()
          .getAttribute('data-session')
          .catch(() => null)
        if (!activeId) return null
        return (await strip.locator(`[data-session="${activeId}"]`).count()) === 1 ? activeId : null
      },
      { timeout: 30_000 },
    )
    .not.toBeNull()
  // Hook endpoints are /hooks/<podiumSessionId> on the daemon's ingest port —
  // read the port from any registered hook settings file, target our session.
  let hookUrl: string | undefined
  await expect
    .poll(async () => {
      hookUrl = (await newHookUrl(new Set()))?.replace(/\/hooks\/[^"]*$/, `/hooks/${activeId}`)
      return hookUrl
    })
    .toMatch(/^http:\/\/127\.0\.0\.1:\d+\/hooks\//)

  // ── Strip geometry + tint (§2.2): 34px, colour-mixed over the tabstrip
  // surface — never flat. The context colour is whatever workspace we landed
  // in (slate flow, or a coloured issue left by an earlier spec on the shared
  // relay) — the invariant under test is the MIX FORMULA against it.
  const ctx = await shellIssueColor(page)
  const stripBox = await strip.boundingBox()
  expect(Math.round(stripBox?.height ?? 0)).toBe(34)
  const stripBg = await strip.evaluate((el) => getComputedStyle(el).backgroundColor)
  // #44: the slate (no-colour) flow runs the strip quieter — 14% vs 18% (1b).
  const wantStripBg = await resolveColor(
    page,
    `color-mix(in srgb, ${ctx.hex} ${ctx.hex === SLATE ? 14 : 18}%, #101016)`,
  )
  expect(stripBg).toBe(wantStripBg)
  // Never flat: 18% over #101016 can never equal the raw context colour.
  expect(stripBg).not.toBe(ctx.rgb)

  // ── Active tab (§2.2): tinted fill, hairline border, the 2px issue-colour
  // inset top line, issue-square leading dot, 10.5px semibold label. Poll:
  // right after creation the pane may still be settling on the new session.
  const activeTab = strip.locator(`[data-session="${activeId}"]`)
  await expect
    .poll(
      async () => {
        const state = await page.evaluate((id) => {
          const strip = document.querySelector('[data-testid="native-tab-strip"]')
          const tabs = [...(strip?.querySelectorAll('[data-session]') ?? [])].map((t) => ({
            id: t.getAttribute('data-session'),
            shadow: getComputedStyle(t).boxShadow,
            cls: t.className,
          }))
          const panels = [...document.querySelectorAll('.flex.min-h-0 > div[data-session]')].map(
            (p) => ({
              id: p.getAttribute('data-session'),
              display: getComputedStyle(p).display,
            }),
          )
          return { tabs, panels, id }
        }, activeId)
        const mine = state.tabs.find((t) => t.id === activeId)
        if (mine?.shadow.includes('inset')) return 'inset'
        console.log('active-tab debug:', JSON.stringify(state))
        return mine?.shadow ?? 'missing'
      },
      { timeout: 15_000 },
    )
    .toBe('inset')
  const tabShadow = await activeTab.evaluate((el) => getComputedStyle(el).boxShadow)
  expect(tabShadow).toContain(ctx.rgb)
  const dot = activeTab.locator('.tab-issue-dot').first()
  await expect(dot).toBeVisible()
  const dotStyle = await dot.evaluate((el) => {
    const s = getComputedStyle(el)
    return { r: s.borderRadius, bg: s.backgroundColor, w: s.width }
  })
  expect(dotStyle.r).toBe('2.5px')
  expect(dotStyle.w).toBe('7px')
  expect(dotStyle.bg).toBe(ctx.rgb)

  // ── Status grammar (§2.8) via the session's real hook endpoint:
  // working → braille spinner; AskUserQuestion → still amber dot; Stop → nothing.
  await fireHook(hookUrl as string, {
    hook_event_name: 'UserPromptSubmit',
    prompt: 'e2e working',
  })
  await expect(activeTab.locator('.spb')).toBeVisible({ timeout: 15_000 })
  await expect(activeTab.locator('[aria-label="waiting on you"]')).toHaveCount(0)

  await fireHook(hookUrl as string, {
    hook_event_name: 'PreToolUse',
    tool_name: 'AskUserQuestion',
    tool_input: { questions: [{ question: 'pick one?' }] },
  })
  await expect(activeTab.locator('[aria-label="waiting on you"]')).toBeVisible({
    timeout: 15_000,
  })
  await expect(activeTab.locator('.spb')).toHaveCount(0)
  const amber = await activeTab
    .locator('[aria-label="waiting on you"]')
    .evaluate((el) => getComputedStyle(el).backgroundColor)
  expect(amber).toBe(await resolveColor(page, '#f59e0b'))

  await fireHook(hookUrl as string, { hook_event_name: 'Stop' })
  await expect(activeTab.locator('[aria-label="waiting on you"]')).toHaveCount(0, {
    timeout: 15_000,
  })
  await expect(activeTab.locator('.spb')).toHaveCount(0)

  // ── Header (§2.3) and model strip (§2.4) heights + content. Warm-mounted
  // hidden panels keep their DOM, so scope to the currently VISIBLE panel's
  // subtree (the pane can re-key its session id across an optimistic
  // reconcile, so don't trust a captured id here).
  const activePanel = page.locator('.flex.min-h-0 > div[data-session]:visible').first()
  const header = activePanel.getByTestId('agent-panel-header')
  await expect(header).toBeVisible({ timeout: 15_000 })
  expect(Math.round((await header.boundingBox())?.height ?? 0)).toBe(42)
  const modelStrip = activePanel.getByTestId('agent-model-strip')
  await expect(modelStrip).toBeVisible()
  expect(Math.round((await modelStrip.boundingBox())?.height ?? 0)).toBe(32)
  await expect(modelStrip).toContainText('esc to interrupt')
  await expect(modelStrip).not.toContainText('/ for commands')

  // ── Terminal floats on the tinted pane surface (§2.5): 9% slate over the
  // terminal base, not the old flat #0e0e12. The background is an inline JS
  // mix (xterm can't evaluate color-mix), so assert the same channel math.
  const surface = activePanel.getByTestId('terminal-surface')
  const surfaceBg = await surface.evaluate((el) => getComputedStyle(el).backgroundColor)
  expect(surfaceBg).toBe(mixRgb(ctx.hex, '#0e0e12', ctx.hex === SLATE ? 9 : 12))
  expect(surfaceBg).not.toBe('rgb(14, 14, 18)')

  // ── Prompt chrome (§2.6): tinted rule + truthful CLI hints for claude-code.
  const promptChrome = activePanel.getByTestId('prompt-chrome')
  await expect(promptChrome).toBeVisible()
  await expect(promptChrome).toContainText('? for shortcuts')

  // Re-derive the tab from the visible panel (same re-key caveat as above).
  const firstId = await activePanel.getAttribute('data-session')
  const currentTab = strip.locator(`[data-session="${firstId}"]`)

  // ── Pin: hover-revealed on the tab, toggles pressed state and stays visible.
  await currentTab.hover()
  const pin = currentTab.getByRole('button', { name: 'Pin panel' })
  await expect(pin).toBeVisible()
  await pin.click()
  await expect(currentTab.getByRole('button', { name: 'Unpin panel' })).toBeVisible()
  await page.mouse.move(10, 500) // hover off — pinned control must stay
  await expect(currentTab.getByRole('button', { name: 'Unpin panel' })).toBeVisible()
  await currentTab.getByRole('button', { name: 'Unpin panel' }).click()

  // ── Kill affordance: the ✕ is present on the active tab (behaviour behind it
  // is the guarded kill; we only prove the affordance is wired and visible).
  await expect(currentTab.getByRole('button', { name: 'Kill session' })).toBeVisible()

  // ── Tab selection: open a second session, click back to the first tab, the
  // first panel shows again. (Shells are dock-owned since #23/#40 — the strip's
  // "+" only offers agents, so the second tab is another Claude.)
  const tabCount = await strip.locator('[data-session]').count()
  await newSession(page, 'Claude')
  await expect(strip.locator('[data-session]')).toHaveCount(tabCount + 1)
  await strip.locator(`[data-session="${firstId}"]`).locator('button').first().click()
  await expect(
    page.locator(`.flex.min-h-0 > [data-session="${firstId}"]:visible`).first(),
  ).toBeVisible()

  // ── Reload persistence: the selected tab and the tinted chrome survive. The
  // workspace route (incl. the pane) lives in the URL, so a plain reload must
  // land back on the same pane — no renavigation (gotoWorkspace would race the
  // boot screen and click a sidebar row, resetting the pane).
  await page.reload()
  await page.waitForFunction(() => !document.querySelector('.app-loading'), undefined, {
    timeout: 45_000,
  })
  await expect(page.getByTestId('native-tab-strip')).toBeVisible({ timeout: 20_000 })
  await expect
    .poll(
      async () =>
        page
          .locator(`.flex.min-h-0 > [data-session="${firstId}"]:visible`)
          .first()
          .isVisible()
          .catch(() => false),
      { timeout: 20_000 },
    )
    .toBe(true)
  expect(
    await page
      .getByTestId('native-tab-strip')
      .evaluate((el) => getComputedStyle(el).backgroundColor),
  ).toBe(wantStripBg)

  // ── Resize probe: the strip keeps its 34px height when the pane narrows.
  await page.setViewportSize({ width: 900, height: 700 })
  await expect
    .poll(async () =>
      Math.round((await page.getByTestId('native-tab-strip').boundingBox())?.height ?? 0),
    )
    .toBe(34)

  await page.screenshot({
    path: 'test-results/native-pane-slate.png',
    fullPage: true,
  })
})

test('a coloured issue tints the whole pane with its palette colour', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 820 })
  await openAppBare(page)

  // Create an issue with real work, then pick Violet through the actual
  // ID-square picker (#38's flow).
  const row = await createIssueWithWork(page, `E2E native pane tint ${Date.now()}`)
  const square = row.getByRole('button', { name: /Set colour for issue #/ })
  await expect(square).toBeVisible({ timeout: 30_000 })
  await expect(square).toHaveAttribute('data-color', 'none')
  await square.click()
  const picker = page.getByRole('dialog', { name: /Issue colour for #/ })
  // The popover can miss a click while the row re-renders (session feed
  // updates) — retry the trigger until the dialog is actually up.
  await expect
    .poll(async () => {
      if (await picker.isVisible().catch(() => false)) return true
      await square.click().catch(() => {})
      return picker.isVisible().catch(() => false)
    })
    .toBe(true)
  await picker.getByRole('button', { name: 'Violet' }).click()
  await expect(square).toHaveAttribute('data-color', 'violet')
  await expect(square).toHaveAttribute('aria-busy', 'false', { timeout: 15_000 })

  // Select the issue → the workspace's native pane must carry the violet.
  await row.locator('button.flex-1').first().click()
  const strip = page.getByTestId('native-tab-strip')
  await expect(strip).toBeVisible({ timeout: 20_000 })
  const violetStrip = await resolveColor(page, 'color-mix(in srgb, #8b5cf6 18%, #101016)')
  await expect
    .poll(async () => strip.evaluate((el) => getComputedStyle(el).backgroundColor))
    .toBe(violetStrip)

  // Wait for the issue's session tab, then check the violet flows through the
  // tab (inset line + leading dot) and the header. NOTE: an issue-spawned
  // session runs in the issue's worktree, which the throwaway harness repo
  // can't create, so it exits immediately — no live terminal to mount here.
  // The terminal-surface tint (same --issue-driven code path) is proven
  // against a LIVE session in the slate test above; here we prove the palette
  // colour reaches the pane chrome end-to-end.
  const tab = strip.locator('[data-session]').first()
  await expect(tab).toBeVisible({ timeout: 30_000 })
  const violet = await resolveColor(page, '#8b5cf6')
  expect(await tab.evaluate((el) => getComputedStyle(el).boxShadow)).toContain(violet)
  expect(
    await tab
      .locator('.tab-issue-dot')
      .first()
      .evaluate((el) => getComputedStyle(el).backgroundColor),
  ).toBe(violet)
  const header = page.getByTestId('agent-panel-header').first()
  await expect(header).toBeVisible({ timeout: 20_000 })
  expect(await header.evaluate((el) => getComputedStyle(el).backgroundColor)).toBe(
    await resolveColor(page, 'color-mix(in srgb, #8b5cf6 24%, #0e0e12)'),
  )

  await page.screenshot({
    path: 'test-results/native-pane-violet.png',
    fullPage: true,
  })
})
