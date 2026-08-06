import { type APIRequestContext, expect, type Page, test } from '@playwright/test'
import { gotoWorkspace, podium, RELAY } from './_harness'

/**
 * Acceptance flow for the redesigned issue peek card (POD-155) against the REAL
 * Live UI: a ref token printed into a live shell pane is linkified by the
 * terminal ref provider, a real mouse click opens the floating miniview card,
 * and the flow must preserve three honest levels: a quiet reference preview, the
 * shared compact drawer with contextual actions, and a real full-page navigation.
 * Run now is exercised from the compact level against the live server.
 */
test.skip(({ isMobile }) => isMobile, 'desktop pointer test (real mouse click on a terminal cell)')
test.setTimeout(120_000)

const HTTP = RELAY.replace(/^ws/, 'http')

async function rpc<T>(
  request: APIRequestContext,
  proc: string,
  input?: unknown,
  method: 'post' | 'get' = 'post',
): Promise<T> {
  const response =
    method === 'get'
      ? await request.get(
          `${HTTP}/trpc/${proc}${input !== undefined ? `?input=${encodeURIComponent(JSON.stringify(input))}` : ''}`,
        )
      : await request.post(`${HTTP}/trpc/${proc}`, { data: input ?? {} })
  if (!response.ok()) throw new Error(`${proc} -> ${response.status()}: ${await response.text()}`)
  const body = (await response.json()) as { result?: { data?: T } }
  return body.result?.data as T
}

interface WireIssue {
  id: string
  displayRef?: string
  stage: string
  worktreePath?: string | null
}

async function openWorkspaceWithShell(page: Page): Promise<void> {
  await page.addInitScript(() => localStorage.setItem('podium.panelMode', 'native'))
  await page.goto(`/?server=${RELAY}&e2e=1`)
  await page.waitForFunction(() => !document.querySelector('.app-loading'), undefined, {
    timeout: 20_000,
  })
  await gotoWorkspace(page)
  await page.getByRole('button', { name: 'New panel' }).click({ timeout: 15_000 })
  await page.getByRole('menuitem', { name: 'New Shell' }).click({ timeout: 10_000 })
  await page.waitForFunction(
    () => !!(window as unknown as { __podium?: unknown }).__podium,
    undefined,
    { timeout: 20_000 },
  )
  await page.waitForTimeout(800)
}

test('terminal ref click opens the redesigned peek card; preview escalates through the compact drawer to the full issue', async ({
  page,
  request,
}) => {
  // ---- Seed a startable issue with an agent-posted state note ----
  const repos = await rpc<string[]>(request, 'repos.list', undefined, 'get')
  const repoPath = repos[0]
  if (!repoPath) throw new Error('harness registered no repo')
  const title = `Peek acceptance probe ${Date.now()}`
  const note = 'The direction is scoped. Start an agent here without leaving the peek.'
  const created = await rpc<{ id: string }>(request, 'issues.create', {
    repoPath,
    title,
    description: 'Peek card acceptance probe.',
    startNow: false,
  })
  const dependencyTitle = `Review dependency ${Date.now()}`
  const dependency = await rpc<{ id: string }>(request, 'issues.create', {
    repoPath,
    title: dependencyTitle,
    description: 'Related-task status icon probe.',
    startNow: false,
  })
  await rpc(request, 'issues.update', {
    id: dependency.id,
    patch: { stage: 'review' },
  })
  await rpc(request, 'issues.depAdd', { fromId: created.id, toId: dependency.id, type: 'related' })
  await rpc(request, 'issues.update', { id: created.id, patch: { stage: 'planning' } })
  await rpc(request, 'issues.setState', { id: created.id, text: note })
  const listed = await rpc<WireIssue[]>(request, 'issues.list', { repoPath }, 'get')
  const ref = listed.find((i) => i.id === created.id)?.displayRef
  if (!ref) throw new Error('created issue has no displayRef')

  // ---- Print the ref into a real shell pane and click the linkified token ----
  await page.setViewportSize({ width: 1280, height: 820 })
  await openWorkspaceWithShell(page)
  await expect
    .poll(async () => (await podium.screen(page)).length, { timeout: 20_000 })
    .toBeGreaterThan(0)
  // Bare token on its own OUTPUT line (the echo line carries quotes/printf).
  await podium.send(page, `printf '%s\\n' '${ref}'\r`)
  await expect
    .poll(async () => (await podium.screen(page)).split('\n').includes(ref), { timeout: 15_000 })
    .toBe(true)

  const st = await page.evaluate(() => {
    const s = (
      window as unknown as { __podium: { state(): { cols: number; rows: number } } }
    ).__podium.state()
    return { cols: s.cols, rows: s.rows }
  })
  const card = page.getByRole('dialog', { name: `Reference ${ref}` })
  const clicked = await (async () => {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const lines = (await podium.screen(page)).split('\n')
      const total = lines.length - 1
      const lineIndex = lines.lastIndexOf(ref)
      const screenRow = lineIndex - (total - st.rows)
      if (lineIndex >= 0 && screenRow >= 0 && screenRow < st.rows) {
        const box = await page.evaluate(() => {
          const els = Array.from(document.querySelectorAll('.xterm-screen')) as HTMLElement[]
          const el =
            els.find((e) => e.offsetParent !== null && e.getBoundingClientRect().width > 0) ??
            els[0]
          const r = el.getBoundingClientRect()
          return { x: r.x, y: r.y, w: r.width, h: r.height }
        })
        const col = Math.min(3, ref.length - 1)
        const x = Math.round(box.x + (col + 0.5) * (box.w / st.cols))
        const y = Math.round(box.y + (screenRow + 0.5) * (box.h / st.rows))
        await page.mouse.move(x, y)
        await page.waitForTimeout(250)
        await page.mouse.click(x, y)
        if (await card.isVisible().catch(() => false)) return true
        try {
          await card.waitFor({ state: 'visible', timeout: 1500 })
          return true
        } catch {
          /* miss — recompute and retry */
        }
      } else {
        await page.waitForTimeout(300)
      }
    }
    return false
  })()
  expect(clicked, 'clicking the terminal ref opened the miniview card').toBe(true)

  // ---- The redesigned hierarchy (POD-155) ----
  await expect(card).toContainText(title)
  await expect(card.getByRole('img', { name: `Planning task ${ref}: ${title}` })).toBeVisible() // the canonical leading glyph owns workflow status
  await expect(card).toContainText('Latest update')
  await expect(card).toContainText(note)
  // Normal availability is silent: no "ready" chip, no blocker copy.
  await expect(card).not.toContainText(/ready/i)
  await expect(card).not.toContainText(/blocked/i)
  await expect(card.getByRole('button', { name: 'Open issue peek' })).toBeVisible()
  await expect(card.getByRole('button', { name: 'Copy ref' })).toBeVisible()

  // ---- Level 2: the compact drawer keeps context and owns compact actions ----
  await card.getByRole('button', { name: 'Open issue peek' }).click()
  const drawer = page.getByRole('dialog', { name: `Peek ${ref}` })
  await expect(drawer).toBeVisible()
  await expect(drawer).toContainText(title)
  await expect(drawer).toContainText('Planning')
  const drawerRelations = drawer.getByTestId('dock-relations')
  await expect(drawerRelations.getByRole('img', { name: 'Review' })).toBeVisible()
  await expect(drawerRelations).toContainText(dependencyTitle)

  await expect(drawer.getByRole('button', { name: 'Open full issue' })).toBeVisible()
  await drawer.getByRole('button', { name: 'More issue actions' }).click()
  await expect(page.getByRole('menuitem', { name: 'Archive' })).toBeVisible()
  await expect(page.getByRole('menuitem', { name: 'Delete' })).toBeVisible()
  await drawer.getByText(title).click()

  // Optional review shot of the card in situ (PEEK_SHOT=/abs/path.png).
  if (process.env.PEEK_SHOT) await page.screenshot({ path: process.env.PEEK_SHOT })

  // ---- Run now preserves startability semantics: it really starts the issue ----
  const runNow = drawer.getByRole('button', { name: 'Run now' })
  await expect(runNow).toBeVisible()
  await runNow.click()
  await expect
    .poll(
      async () => {
        const rows = await rpc<WireIssue[]>(request, 'issues.list', { repoPath }, 'get')
        const row = rows.find((i) => i.id === created.id)
        return row?.worktreePath ? row.stage : 'pending'
      },
      { timeout: 45_000 },
    )
    .toBe('in_progress')
  // Once started the issue is no longer startable — the action leaves the card.
  await expect(drawer.getByRole('button', { name: 'Run now' })).toHaveCount(0, { timeout: 15_000 })

  // ---- Level 3: full issue is an actual navigation, not another drawer label ----
  await drawer.getByRole('button', { name: 'Open full issue' }).click()
  const fullPage = page.getByTestId('issue-page')
  await expect(fullPage).toBeVisible()
  await expect(fullPage).toContainText(title)
  const aside = fullPage.getByTestId('issue-aside')
  await expect(aside.getByRole('img', { name: 'Review' })).toBeVisible()
  await expect(aside).toContainText(dependencyTitle)
})
