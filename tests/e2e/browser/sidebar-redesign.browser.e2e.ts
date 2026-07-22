import { readdir, readFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { type APIRequestContext, expect, type Page, test } from '@playwright/test'
import { harnessEnv } from '../harness-env'
import { RELAY } from './_harness'

/**
 * Runtime verification of the #41 work-sidebar redesign against the real Live
 * UI: two-line rows with the motion grammar (spinner+timer while working, amber
 * pill + frozen stamp while waiting), the selected row's colour-flowed
 * background and bridge notch physically crossing the aside border, dimmed
 * queued rows, and the collapsed 52px rail keeping the full square language
 * (squares, hairlines, corner badges, notch, select-then-pick clicks).
 */
test.skip(({ isMobile }) => isMobile, 'desktop verification: the sidebar/rail are desktop-only')

const PORT = Number(process.env.PORT ?? 8799)
const HTTP = RELAY.replace(/^ws/, 'http')
const HOOKS_DIR = join(harnessEnv(PORT).stateDir, 'hooks')

async function rpc<T>(
  request: APIRequestContext,
  proc: string,
  input?: unknown,
  method: 'post' | 'get' = 'post',
): Promise<T> {
  const response =
    method === 'get'
      ? await request.get(
          `${HTTP}/trpc/${proc}${input ? `?input=${encodeURIComponent(JSON.stringify(input))}` : ''}`,
        )
      : await request.post(`${HTTP}/trpc/${proc}`, { data: input ?? {} })
  if (!response.ok()) throw new Error(`${proc} -> ${response.status()}: ${await response.text()}`)
  const body = (await response.json()) as { result?: { data?: T } }
  return body.result?.data as T
}

async function hookSettingsFiles(): Promise<Set<string>> {
  return new Set(await readdir(HOOKS_DIR).catch(() => []))
}

async function newHookUrl(existing: Set<string>): Promise<string | undefined> {
  const files = await hookSettingsFiles()
  for (const file of files) {
    if (existing.has(file)) continue
    const settings = await readFile(join(HOOKS_DIR, file), 'utf8').catch(() => undefined)
    if (!settings) continue
    const url = settings.match(/"url":\s*"([^"]+\/hooks\/[^"]+)"/)?.[1]
    if (url) return url
  }
  return undefined
}

async function openShell(page: Page): Promise<void> {
  await page.goto(`/?server=${RELAY}&e2e=1`)
  await page.waitForFunction(() => !document.querySelector('.app-loading'), undefined, {
    timeout: 60_000,
  })
  await page.locator('aside').first().waitFor({ state: 'visible', timeout: 60_000 })
}

/** Resolve a CSS color expression to its computed rgb() in the live page. */
async function resolveColor(page: Page, expression: string): Promise<string> {
  return page.evaluate((expr) => {
    const probe = document.createElement('div')
    probe.style.color = expr
    document.body.appendChild(probe)
    const value = getComputedStyle(probe).color
    probe.remove()
    return value
  }, expression)
}

test('rows carry the motion grammar, the selected row grows the bridge notch, colour flows', async ({
  page,
  request,
}) => {
  await page.setViewportSize({ width: 1280, height: 900 })
  await openShell(page)
  const aside = page.locator('aside').first()

  // ---- Seed one issue with real work through the stable server boundary. ----
  const repos = await rpc<string[]>(request, 'repos.list', undefined, 'get')
  const repoPath = repos.find((repo) => basename(repo) === `zz-podium-e2e-repo-${PORT}`) ?? repos[0]
  if (!repoPath) throw new Error('harness registered no repo')
  const title = `E2E sidebar redesign ${Date.now()}`
  const preexistingHooks = await hookSettingsFiles()
  await rpc(request, 'issues.create', { repoPath, title, startNow: true })

  let hookUrl: string | undefined
  await expect
    .poll(async () => {
      hookUrl = await newHookUrl(preexistingHooks)
      return hookUrl
    })
    .toMatch(/^http:\/\/127\.0\.0\.1:\d+\/hooks\//)

  const row = page.getByTestId('unified-issue-row').filter({ hasText: title }).first()
  const rowSurface = row.locator('[data-phase]').first()
  await expect(rowSurface).toBeVisible({ timeout: 30_000 })

  // ---- WORKING: one lifecycle lockup owns spinner + word + counting timer. ----
  const working = await fetch(hookUrl as string, {
    method: 'POST',
    body: JSON.stringify({ hook_event_name: 'UserPromptSubmit', prompt: 'e2e working' }),
  })
  expect(working.ok).toBe(true)
  await expect(rowSurface).toHaveAttribute('data-phase', 'working', { timeout: 15_000 })
  const lifecycle = row.getByTestId('row-lifecycle-status')
  await expect(lifecycle).toHaveAttribute('data-phase', 'working')
  await expect(lifecycle.locator('.spb')).toBeVisible()
  await expect(lifecycle).toContainText(/working.*·\s*\d+:\d\d/i)
  const fleet = row.getByTestId('issue-fleet-summary')
  await expect(fleet).toBeVisible()
  await expect(fleet.locator('.rounded-full')).toHaveCount(0)
  if (process.env.SIDEBAR_WORKING_SHOT) {
    await row.screenshot({ path: process.env.SIDEBAR_WORKING_SHOT })
  }

  // ---- WAITING: a question freezes the row into amber stillness + pill. ----
  const asking = await fetch(hookUrl as string, {
    method: 'POST',
    body: JSON.stringify({
      hook_event_name: 'PreToolUse',
      tool_name: 'AskUserQuestion',
      tool_input: { questions: [{ question: 'e2e: 16:9 or vertical?' }] },
    }),
  })
  expect(asking.ok).toBe(true)
  await expect(rowSurface).toHaveAttribute('data-phase', 'waiting', { timeout: 15_000 })
  await expect(row.getByRole('img', { name: '1 waiting on you' })).toBeVisible()
  await expect(row.locator('.spb')).toHaveCount(0)
  // The square carries the amber waiting corner dot on wide rows.
  const square = row.getByTestId('issue-id-square')
  await expect(square).toHaveAttribute('data-badge', 'dot')

  // ---- Selecting the row grows the bridge notch ACROSS the aside border. ----
  await row.locator('button.flex-1').first().click()
  await expect(rowSurface).toHaveAttribute('data-selected', 'true', { timeout: 10_000 })
  const notch = row.getByTestId('bridge-notch')
  await expect(notch).toBeVisible()
  const asideBox = await aside.boundingBox()
  const notchBox = await notch.boundingBox()
  expect(asideBox).not.toBeNull()
  expect(notchBox).not.toBeNull()
  if (asideBox && notchBox) {
    // The notch must fully cover the aside's right border (its tip lands flush
    // with the aside's OUTER edge from the row's 8px inset, #64) — it may not
    // be clipped by the scroll container.
    expect(notchBox.x + notchBox.width).toBeGreaterThan(asideBox.x + asideBox.width - 0.1)
  }

  // ---- Colour flows live: pick Violet, the row background re-mixes. ----
  await square.click()
  const picker = page.getByRole('dialog', { name: /Task colour for / })
  await expect(picker).toBeVisible()
  await picker.getByRole('button', { name: 'Violet' }).click()
  await expect(square).toHaveAttribute('data-color', 'violet')
  const selectedViolet = await resolveColor(page, 'color-mix(in srgb, #8b5cf6 28%, #16161c)')
  await expect
    .poll(async () =>
      rowSurface.evaluate((el) => getComputedStyle(el as HTMLElement).backgroundColor),
    )
    .toBe(selectedViolet)
  await expect(square).toHaveAttribute('aria-busy', 'false', { timeout: 15_000 })

  // ---- DONE: the real Stop hook replaces motion with check + explicit copy. ----
  const stopped = await fetch(hookUrl as string, {
    method: 'POST',
    body: JSON.stringify({ hook_event_name: 'Stop' }),
  })
  expect(stopped.ok).toBe(true)
  await expect(rowSurface).toHaveAttribute('data-phase', 'done', { timeout: 15_000 })
  await expect(lifecycle).toHaveAttribute('data-phase', 'done')
  await expect(lifecycle).toContainText(/done/i)
  await expect(lifecycle.locator('svg')).toBeVisible()
  await expect(lifecycle.locator('.spb')).toHaveCount(0)
  await expect(fleet.locator('.rounded-full')).toHaveCount(0)
  if (process.env.SIDEBAR_DONE_SHOT) {
    await row.screenshot({ path: process.env.SIDEBAR_DONE_SHOT })
  }

  if (process.env.SIDEBAR_SHOT) {
    await aside.screenshot({ path: process.env.SIDEBAR_SHOT })
  }
})

test('collapsed 52px rail keeps the square language and select-then-pick clicks persist', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 900 })
  await openShell(page)

  // Ensure at least one work row exists (reuses rows from earlier tests when
  // the harness kept them; otherwise spawn one).
  const aside = page.locator('aside').first()
  if ((await aside.getByTestId('unified-issue-row').count()) === 0) {
    await aside.getByRole('button', { name: /^New .+ in .+/ }).click()
    await expect
      .poll(async () => aside.getByTestId('unified-issue-row').count(), { timeout: 30_000 })
      .toBeGreaterThan(0)
  }

  // ---- Collapse: the shell folds to the 52px rail. ----
  await page.getByRole('button', { name: 'Collapse sidebar' }).click()
  const rail = page.locator('.collapsed-sidebar')
  await expect(rail).toBeVisible()
  const railBox = await rail.boundingBox()
  expect(Math.round(railBox?.width ?? 0)).toBe(52)

  // The rail carries the full language: compact new-agent button, per-project
  // hairlines, one ID square per row, footer search.
  await expect(rail.getByTestId('rail-new-agent')).toBeVisible()
  await expect(rail.getByTestId('rail-project-hairline').first()).toBeVisible()
  const railSquares = rail.getByTestId('issue-id-square')
  await expect.poll(async () => railSquares.count(), { timeout: 15_000 }).toBeGreaterThan(0)
  await expect(rail.getByRole('button', { name: 'Search' })).toBeVisible()

  // ---- Rail click #1 selects the issue (square gains ring + notch)… ----
  const firstSquare = railSquares.first()
  const initiallySelected = (await firstSquare.getAttribute('data-selected')) === 'true'
  if (!initiallySelected) {
    await firstSquare.click()
    await expect(firstSquare).toHaveAttribute('data-selected', 'true', { timeout: 10_000 })
  }
  const railNotch = rail.getByTestId('bridge-notch').first()
  await expect(railNotch).toBeVisible()
  const notchBox = await railNotch.boundingBox()
  const box = await rail.boundingBox()
  if (box && notchBox) {
    expect(notchBox.x + notchBox.width).toBeGreaterThan(box.x + box.width + 0.4)
  }

  // ---- …click #2 on the selected square opens the colour picker. ----
  await firstSquare.click()
  await expect(page.getByRole('dialog', { name: /Task colour for / })).toBeVisible()
  await page.keyboard.press('Escape')

  if (process.env.RAIL_SHOT) {
    await rail.screenshot({ path: process.env.RAIL_SHOT })
  }

  // ---- Collapse state persists across a reload. ----
  await page.reload()
  await page.waitForFunction(() => !document.querySelector('.app-loading'), undefined, {
    timeout: 60_000,
  })
  await expect(page.locator('.collapsed-sidebar')).toBeVisible({ timeout: 15_000 })
  await expect(
    page.locator('.collapsed-sidebar').getByTestId('issue-id-square').first(),
  ).toBeVisible({ timeout: 15_000 })

  // ---- Expand restores the wide sidebar. ----
  await page.getByRole('button', { name: 'Expand sidebar' }).click()
  await expect(page.locator('aside').first().getByTestId('unified-issue-row').first()).toBeVisible({
    timeout: 15_000,
  })
})
