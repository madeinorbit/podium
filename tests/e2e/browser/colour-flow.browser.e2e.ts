/**
 * Colour-flow propagation (#44, .design/specs/colour-flow.md): ONE reactive
 * source — the selected issue's flow colour scoped as --issue on the shell
 * root — drives every desktop surface: sidebar selected row,
 * engraved-column glow, native tab strip + pane chrome, right rail
 * gradient/border (with ancestor inheritance through the scope), and the
 * xterm terminal background (live, no remount). The no-colour default runs
 * the identical mechanics quieter (handoff 1b percentages) under
 * data-issue-colored='false', and recolouring crossfades through the
 * registered --issue transition.
 *
 * Real Chromium against the harness relay: real issues (seeded over HTTP
 * tRPC), a real live session for the terminal proof, real pixels.
 */
import { type APIRequestContext, expect, type Page, test } from '@playwright/test'
import type { SessionMeta } from '@podium/model'
import {
  expandFlightDeckIfFolded,
  expandSidebarIfFolded,
  newSession,
  openHome,
  RELAY,
} from './_harness'

test.skip(({ isMobile }) => isMobile, 'desktop colour flow')
// Cold-start discovery + real session spawns overrun the 30s default; siblings
// (native-pane, engraved-column) size the budget the same way.
test.setTimeout(120_000)

const HTTP = RELAY.replace(/^ws/, 'http')

async function rpc<T>(
  request: APIRequestContext,
  proc: string,
  input?: unknown,
  method: 'post' | 'get' = 'post',
): Promise<T> {
  const res =
    method === 'post'
      ? await request.post(`${HTTP}/trpc/${proc}`, { data: input ?? {} })
      : await request.get(
          `${HTTP}/trpc/${proc}${input ? `?input=${encodeURIComponent(JSON.stringify(input))}` : ''}`,
        )
  if (!res.ok()) throw new Error(`${proc} → ${res.status()}: ${await res.text()}`)
  const body = (await res.json()) as { result?: { data?: T } }
  return body.result?.data as T
}

interface SeededIssue {
  id: string
  seq: number
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
 *  same engine path the tinted gradients (rail fade, glow) go through,
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
// The neutral no-colour flow on the dark harness theme (--flow on Dark Ink;
// the terminal mixer still uses SLATE above).
const FLOW = '#949aa4'

test('one --issue source: slate runs quieter, recolour flows live, child keeps the mission flow', async ({
  page,
  request,
}) => {
  // 1680px keeps the work sidebar unfolded (it folds below 1600px), so the
  // seeded rows are reachable.
  await page.setViewportSize({ width: 1680, height: 900 })

  // Seed a parent with real work (its session exits in the throwaway repo but
  // still yields the tab strip + header chrome) and an UNCOLOURED child that
  // needs a human.
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

  await openHome(page)
  await expandSidebarIfFolded(page)
  const row = page
    .getByTestId('unified-issue-row')
    .filter({ hasText: `Colour flow parent ${stamp}` })
    .first()
  await expect(row).toBeVisible({ timeout: 30_000 })
  await row.locator('button.flex-1').first().click()
  // The deck mounts folded; unfold it once the workspace has settled so the
  // engraved glow surface is in the DOM.
  await expandFlightDeckIfFolded(page)

  const shell = page.locator('.desktop-shell')

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

  // ── Slate (no colour) values — the neutral flow over each surface's base.
  // The focused tab strip runs 2% over the tabstrip tier, the engraved glow
  // 13% over card; selection/rows/pane/rail/header are flat now (lift, spine
  // and tier do that work), so the scope and the strip carry the proof.
  const strip = page.getByTestId('native-tab-strip')
  await expect(strip).toBeVisible({ timeout: 30_000 })
  await expect
    .poll(async () => strip.evaluate((el) => getComputedStyle(el).backgroundColor))
    .toBe(await resolveColor(page, `color-mix(in srgb, ${FLOW} 2%, #202228)`))
  const glow = page.locator('.engraved-column').first()
  await expect(glow).toBeVisible()
  expect(await glow.evaluate((el) => getComputedStyle(el).backgroundImage)).toContain(
    await resolveGradientColor(page, `color-mix(in srgb, ${FLOW} 13%, #23262d)`),
  )
  // The scope carries the neutral flow (serializes as rgb()); the parent's
  // own row is uncoloured.
  expect(
    await shell.evaluate((el) => getComputedStyle(el).getPropertyValue('--issue').trim()),
  ).toBe(await resolveColor(page, FLOW))
  await expect(row).toHaveAttribute('data-issue-colored', 'false')
  await page.screenshot({ path: 'test-results/colour-flow-slate.png', fullPage: true })

  // ── Recolour the PARENT server-side: the push must recolour the live
  // scope — flag, channel, strip, glow — and the uncoloured child must
  // INHERIT violet through the shell scope (its own colour is unset).
  await rpc(request, 'issues.update', { id: parent.id, patch: { color: 'violet' } })
  await expect(shell).toHaveAttribute('data-issue-colored', 'true', { timeout: 15_000 })
  await expect
    .poll(async () => strip.evaluate((el) => getComputedStyle(el).backgroundColor))
    .toBe(await resolveColor(page, `color-mix(in srgb, ${VIOLET} 3%, #202228)`))
  expect(await glow.evaluate((el) => getComputedStyle(el).backgroundImage)).toContain(
    await resolveGradientColor(page, `color-mix(in srgb, ${VIOLET} 16%, #23262d)`),
  )
  await expect(row).toHaveAttribute('data-issue-colored', 'true', { timeout: 15_000 })
  // The child runs under the mission: its own colour slot is empty (server
  // truth), and working it in the mission deck focuses — never globally
  // selects — it (POD-1151 selects the mission root for a task pick, so the
  // ancestor walk in effectiveIssueColorHex, unit-covered, never faces a
  // nested global selection). The mission flow must survive that focus: the
  // parent stays selected and the scope stays violet.
  const fetchedChild = await rpc<{ color?: string | null }>(
    request,
    'issues.get',
    { id: child.id },
    'get',
  )
  expect(fetchedChild.color ?? null).toBeNull()
  await page
    .locator('.deck-task-content', { hasText: `Colour flow child ${stamp}` })
    .first()
    .click()
  await expect(row.locator('[data-selected="true"]')).toHaveCount(1, { timeout: 15_000 })
  await expect(shell).toHaveAttribute('data-issue-colored', 'true', { timeout: 15_000 })
  await expect
    .poll(
      async () =>
        shell.evaluate((el) => getComputedStyle(el).getPropertyValue('--issue').trim()),
      { timeout: 15_000 },
    )
    .toBe(await resolveColor(page, VIOLET))
  await page.screenshot({ path: 'test-results/colour-flow-violet.png', fullPage: true })
})

test('a colour pick retints the LIVE terminal through setAppearance (no remount)', async ({
  page,
  request,
}) => {
  // 1680px keeps the work sidebar unfolded (it folds below 1600px), so the
  // harness workspace entry reaches the launch composer on an empty state.
  await page.setViewportSize({ width: 1680, height: 900 })

  // A genuinely live session of our own: open the launch composer through New
  // task (always present) and Launch with no prompt — the path that replaced
  // the removed `New <Agent> in <Repo>` chip (f22417ba3). Spawning our own
  // draft keeps the test independent of other suites' issues; the new draft
  // becomes the selection. A fresh Shell panel then guarantees a live,
  // native terminal (newSession preserves the selection).
  await openHome(page)
  await expandSidebarIfFolded(page)
  await page.getByRole('button', { name: 'New task' }).first().click()
  await page.getByTestId('cold-start-launch').first().click()
  await page
    .locator('button[aria-label="New panel"]:visible')
    .first()
    .waitFor({ state: 'visible', timeout: 30_000 })
  await newSession(page, 'Shell')
  // The spawn never selects a sidebar row — join our live terminal to its
  // issue through the session list and select it by row id. Exact match on
  // our own active session, so it cannot drift onto another suite's issue.
  const activeSessionId = await page.evaluate(
    () =>
      (window as unknown as { __podium?: { state(): { sessionId?: string } } }).__podium?.state()
        .sessionId,
  )
  let ownIssueId: string | undefined
  await expect
    .poll(
      async () => {
        const all = await rpc<SessionMeta[]>(request, 'sessions.list', undefined, 'get')
        ownIssueId = all.find((s) => s.sessionId === activeSessionId)?.issueId ?? undefined
        return ownIssueId ?? null
      },
      { timeout: 30_000 },
    )
    .not.toBeNull()
  if (!ownIssueId) throw new Error('own spawned issue never resolved from sessions.list')
  const ownRow = page.locator(`[data-issue-row="${ownIssueId}"]`).first()
  await expect(ownRow).toBeVisible({ timeout: 20_000 })
  await ownRow.locator('button.flex-1').first().click()
  await expect(page.getByTestId('native-tab-strip')).toBeVisible({ timeout: 20_000 })
  // Inactive panels keep their mounted surface in the DOM, so first() can grab
  // a hidden one — the live terminal is the visible surface.
  const surface = page.getByTestId('terminal-surface').locator('visible=true').first()
  await expect(surface).toBeVisible({ timeout: 30_000 })
  await expect
    .poll(async () => surface.evaluate((el) => getComputedStyle(el).backgroundColor))
    .toBe(mixRgb(SLATE, '#0e0e12', 9))

  // Pick Teal on the selected (draft) row's context menu — the picker moved
  // off the ID square into the row menu, and needs the spawn to reconcile
  // into a real issue, so retry the trigger until the picker is up.
  const selectedRow = page
    .getByTestId('unified-issue-row')
    .filter({ has: page.locator('[data-selected="true"]') })
    .first()
  await expect(selectedRow).toBeVisible({ timeout: 20_000 })
  const teal = page.getByRole('button', { name: 'Teal' }).first()
  await expect
    .poll(
      async () => {
        if (await teal.isVisible().catch(() => false)) return true
        const setColour = page.getByRole('menuitem', { name: /Set colour/ }).first()
        if (await setColour.isVisible().catch(() => false)) {
          await setColour.click().catch(() => {})
        } else {
          await selectedRow.click({ button: 'right' }).catch(() => {})
        }
        return teal.isVisible().catch(() => false)
      },
      { timeout: 30_000 },
    )
    .toBe(true)
  await teal.click()

  // The mounted terminal (container + xterm ITheme share termBg) retints live:
  // 12% teal over the terminal base — same panel, no remount.
  await expect
    .poll(async () => surface.evaluate((el) => getComputedStyle(el).backgroundColor), {
      timeout: 20_000,
    })
    .toBe(mixRgb('#14b8a6', '#0e0e12', 12))
  await page.screenshot({ path: 'test-results/colour-flow-live-terminal-teal.png' })
})
