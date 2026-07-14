/**
 * Colour-flow propagation (#44, .design/specs/colour-flow.md): ONE reactive
 * source — the selected issue's flow colour scoped as --issue on the shell
 * root — drives every desktop surface: sidebar selected row + bridge notch,
 * engraved-column glow, tray cards (with ancestor inheritance), native tab
 * strip + pane chrome, right rail gradient/border, and the xterm terminal
 * background (live, no remount). The no-colour default runs the identical
 * mechanics quieter (handoff 1b percentages) under data-issue-colored='false',
 * and recolouring crossfades through the registered --issue transition.
 *
 * Real Chromium against the harness relay: real issues (seeded over HTTP
 * tRPC), a real live session for the terminal proof, real pixels.
 */
import { type APIRequestContext, expect, type Page, test } from '@playwright/test'
import { RELAY } from './_harness'

test.skip(({ isMobile }) => isMobile, 'desktop colour flow')
// Cold-start discovery + real session spawns overrun the 30s default; siblings
// (native-pane, engraved-column) size the budget the same way.
test.setTimeout(120_000)

const HTTP = (process.env.PODIUM_RELAY ?? 'ws://localhost:8799')
  .replace('ws://', 'http://')
  .replace('wss://', 'https://')

async function rpc<T>(
  request: APIRequestContext,
  proc: string,
  input?: unknown,
  method: 'post' | 'get' = 'post',
): Promise<T> {
  const res =
    method === 'post'
      ? await request.post(`${HTTP}/trpc/${proc}`, { data: input ?? {} })
      : await request.get(`${HTTP}/trpc/${proc}`)
  if (!res.ok()) throw new Error(`${proc} → ${res.status()}: ${await res.text()}`)
  const body = (await res.json()) as { result?: { data?: T } }
  return body.result?.data as T
}

interface SeededIssue {
  id: string
  seq: number
}

async function openShell(page: Page): Promise<void> {
  await page.addInitScript(() => localStorage.setItem('podium.panelMode', 'native'))
  await page.goto(`/?server=${RELAY}&e2e=1`)
  await page.waitForFunction(() => !document.querySelector('.app-loading'), undefined, {
    timeout: 60_000,
  })
  await page.locator('aside').first().waitFor({ state: 'visible', timeout: 60_000 })
}

/** The browser's own resolution of a color-mix() expression (as a <color>). */
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

/** The browser's serialization of a colour INSIDE a computed gradient — the
 *  same engine path the tinted gradients (rail fade, glow, notch) go through,
 *  so containment checks compare like with like. */
async function resolveGradientColor(page: Page, expr: string): Promise<string> {
  return page.evaluate((e) => {
    const el = document.createElement('div')
    el.style.backgroundImage = `linear-gradient(${e} 0%, ${e} 100%)`
    document.body.appendChild(el)
    const out = getComputedStyle(el).backgroundImage
    el.remove()
    const m = out.match(/linear-gradient\((.+?) 0%,/)
    return m?.[1] ?? out
  }, expr)
}

/** JS twin of the app's mixHex (appearance.ts) for inline-style backgrounds,
 *  which come back from getComputedStyle as rgb(). */
function mixRgb(color: string, base: string, pct: number): string {
  const ch = (hex: string, i: number) => parseInt(hex.slice(1 + i * 2, 3 + i * 2), 16)
  const mix = (i: number) => Math.round((ch(color, i) * pct + ch(base, i) * (100 - pct)) / 100)
  return `rgb(${mix(0)}, ${mix(1)}, ${mix(2)})`
}

const VIOLET = '#8b5cf6'
const SLATE = '#94a3b8'

test('one --issue source: slate runs quieter, recolour flows to every surface incl. tray inheritance', async ({
  page,
  request,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 })

  // Seed a parent with real work (its session exits in the throwaway repo but
  // still yields the tab strip + header chrome) and an UNCOLOURED child that
  // needs a human — its tray card must inherit the parent's flow colour (§2.5).
  const repos = await rpc<string[]>(request, 'repos.list', undefined, 'get')
  const repoPath = repos[0]
  if (!repoPath) throw new Error('harness registered no repo')
  const stamp = Date.now().toString(36)
  const parent = await rpc<SeededIssue>(request, 'issues.create', {
    repoPath,
    title: `Colour flow parent ${stamp}`,
    startNow: true,
  })
  const child = await rpc<SeededIssue>(request, 'issues.create', {
    repoPath,
    title: `Colour flow child ${stamp}`,
    startNow: false,
    parentId: parent.id,
  })
  await rpc(request, 'issues.setNeedsHuman', {
    id: child.id,
    question: `Inherit the flow? ${stamp}`,
  })

  await openShell(page)
  const row = page
    .getByTestId('unified-issue-row')
    .filter({ hasText: `Colour flow parent ${stamp}` })
    .first()
  await expect(row).toBeVisible({ timeout: 30_000 })
  await row.locator('button.flex-1').first().click()

  const shell = page.locator('.desktop-shell')
  const rowSurface = row.locator('[data-selected="true"]').first()
  await expect(rowSurface).toBeVisible({ timeout: 15_000 })

  // ── The scope: one root carries the channel, the coloured flag and the
  // crossfade. The .4s transition is on the VARIABLE (registered @property),
  // so gradients and shadows animate too.
  await expect(shell).toHaveAttribute('data-issue-colored', 'false')
  const transition = await shell.evaluate((el) => {
    const s = getComputedStyle(el)
    return { property: s.transitionProperty, duration: s.transitionDuration }
  })
  expect(transition.property).toContain('--issue')
  expect(transition.duration).toContain('0.4s')
  // The derived text ramp resolves at the scope (centralized, not pane-local).
  const rampText = await shell.evaluate((el) =>
    getComputedStyle(el).getPropertyValue('--issue-text'),
  )
  expect(rampText.trim()).not.toBe('')

  // ── Slate (no colour) values — handoff 1b, quieter than the coloured set.
  const strip = page.getByTestId('native-tab-strip')
  await expect(strip).toBeVisible({ timeout: 30_000 })
  await expect
    .poll(async () => strip.evaluate((el) => getComputedStyle(el).backgroundColor))
    .toBe(await resolveColor(page, `color-mix(in srgb, ${SLATE} 14%, #101016)`))
  const pane = page.locator('.native-agents-pane').first()
  expect(await pane.evaluate((el) => getComputedStyle(el).backgroundColor)).toBe(
    await resolveColor(page, `color-mix(in srgb, ${SLATE} 9%, #0e0e12)`),
  )
  const rail = page.getByTestId('right-rail')
  await expect(rail).toBeVisible()
  expect(await rail.evaluate((el) => getComputedStyle(el).borderLeftColor)).toBe(
    await resolveColor(page, `color-mix(in srgb, ${SLATE} 30%, transparent)`),
  )
  const railFadeSlate = await resolveGradientColor(
    page,
    `color-mix(in srgb, ${SLATE} 13%, #16161c)`,
  )
  expect(await rail.evaluate((el) => getComputedStyle(el).backgroundImage)).toContain(railFadeSlate)
  const glow = page.locator('.engraved-column').first()
  await expect(glow).toBeVisible()
  expect(await glow.evaluate((el) => getComputedStyle(el).backgroundImage)).toContain(
    await resolveGradientColor(page, `color-mix(in srgb, ${SLATE} 9%, transparent)`),
  )
  // Selected row: 20% (vs 28% coloured), notch at 75% (vs 85%).
  expect(await rowSurface.evaluate((el) => getComputedStyle(el).backgroundColor)).toBe(
    await resolveColor(page, `color-mix(in srgb, ${SLATE} 20%, #16161c)`),
  )
  const notch = row.getByTestId('bridge-notch')
  await expect(notch).toBeVisible()
  expect(await notch.evaluate((el) => getComputedStyle(el).backgroundImage)).toContain(
    await resolveGradientColor(page, `color-mix(in srgb, ${SLATE} 75%, transparent)`),
  )
  // Tray: the uncoloured child's question card under an uncoloured parent runs
  // the slate flow too.
  const childCard = page
    .getByTestId('tray-card-question')
    .filter({ hasText: `Colour flow child ${stamp}` })
    .first()
  await expect(childCard).toBeVisible({ timeout: 20_000 })
  await expect(childCard).toHaveAttribute('data-issue-colored', 'false')
  await page.screenshot({ path: 'test-results/colour-flow-slate.png', fullPage: true })

  // ── Recolour the PARENT server-side: the push must recolour every surface
  // live — shell flag, strip, pane, rail, glow, row, notch — and the child's
  // tray card must INHERIT violet (its own colour is unset).
  await rpc(request, 'issues.update', { id: parent.id, patch: { color: 'violet' } })
  await expect(shell).toHaveAttribute('data-issue-colored', 'true', { timeout: 15_000 })
  await expect
    .poll(async () => strip.evaluate((el) => getComputedStyle(el).backgroundColor))
    .toBe(await resolveColor(page, `color-mix(in srgb, ${VIOLET} 18%, #101016)`))
  expect(await pane.evaluate((el) => getComputedStyle(el).backgroundColor)).toBe(
    await resolveColor(page, `color-mix(in srgb, ${VIOLET} 12%, #0e0e12)`),
  )
  const header = page.getByTestId('agent-panel-header').first()
  await expect(header).toBeVisible({ timeout: 20_000 })
  expect(await header.evaluate((el) => getComputedStyle(el).backgroundColor)).toBe(
    await resolveColor(page, `color-mix(in srgb, ${VIOLET} 24%, #0e0e12)`),
  )
  expect(await rail.evaluate((el) => getComputedStyle(el).borderLeftColor)).toBe(
    await resolveColor(page, `color-mix(in srgb, ${VIOLET} 35%, transparent)`),
  )
  expect(await rail.evaluate((el) => getComputedStyle(el).backgroundImage)).toContain(
    await resolveGradientColor(page, `color-mix(in srgb, ${VIOLET} 16%, #16161c)`),
  )
  expect(await glow.evaluate((el) => getComputedStyle(el).backgroundImage)).toContain(
    await resolveGradientColor(page, `color-mix(in srgb, ${VIOLET} 10%, transparent)`),
  )
  expect(await rowSurface.evaluate((el) => getComputedStyle(el).backgroundColor)).toBe(
    await resolveColor(page, `color-mix(in srgb, ${VIOLET} 28%, #16161c)`),
  )
  expect(await notch.evaluate((el) => getComputedStyle(el).backgroundImage)).toContain(
    await resolveGradientColor(page, `color-mix(in srgb, ${VIOLET} 85%, transparent)`),
  )
  // Inheritance: the child card flows the parent's violet — coloured card
  // percentages (question: 10% fill, 40% hairline) and the flat violet chip.
  await expect(childCard).toHaveAttribute('data-issue-colored', 'true', { timeout: 15_000 })
  expect(await childCard.evaluate((el) => getComputedStyle(el).backgroundColor)).toBe(
    await resolveColor(page, `color-mix(in srgb, ${VIOLET} 10%, #0e0e12)`),
  )
  expect(
    await childCard
      .locator('span[aria-hidden="true"]')
      .first()
      .evaluate((el) => getComputedStyle(el).backgroundColor),
  ).toBe(await resolveColor(page, VIOLET))
  await page.screenshot({ path: 'test-results/colour-flow-violet.png', fullPage: true })
})

test('a colour pick retints the LIVE terminal through setAppearance (no remount)', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 820 })
  await openShell(page)

  // A genuinely live session in the harness repo's own worktree (issue-spawned
  // sessions exit immediately there) — its draft issue becomes the selection.
  await page
    .getByRole('button', { name: /^New .+ in .+/ })
    .first()
    .click({ timeout: 20_000 })
  await expect(page.getByTestId('native-tab-strip')).toBeVisible({ timeout: 20_000 })
  const surface = page.getByTestId('terminal-surface').first()
  await expect(surface).toBeVisible({ timeout: 30_000 })
  await expect
    .poll(async () => surface.evaluate((el) => getComputedStyle(el).backgroundColor))
    .toBe(mixRgb(SLATE, '#0e0e12', 9))

  // Pick Teal on the selected (draft) row's ID square — the picker needs the
  // spawn to reconcile into a real issue, so retry the trigger until the
  // dialog is up.
  const selectedRow = page
    .getByTestId('unified-issue-row')
    .filter({ has: page.locator('[data-selected="true"]') })
    .first()
  await expect(selectedRow).toBeVisible({ timeout: 20_000 })
  const square = selectedRow.getByRole('button', { name: /Set colour for issue/ })
  const picker = page.getByRole('dialog', { name: /Issue colour for/ })
  await expect
    .poll(
      async () => {
        if (await picker.isVisible().catch(() => false)) return true
        await square.click().catch(() => {})
        return picker.isVisible().catch(() => false)
      },
      { timeout: 30_000 },
    )
    .toBe(true)
  await picker.getByRole('button', { name: 'Teal' }).click()

  // The mounted terminal (container + xterm ITheme share termBg) retints live:
  // 12% teal over the terminal base — same panel, no remount.
  await expect
    .poll(async () => surface.evaluate((el) => getComputedStyle(el).backgroundColor), {
      timeout: 20_000,
    })
    .toBe(mixRgb('#14b8a6', '#0e0e12', 12))
  await page.screenshot({ path: 'test-results/colour-flow-live-terminal-teal.png' })
})
