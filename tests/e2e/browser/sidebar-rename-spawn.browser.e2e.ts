import { basename } from 'node:path'
import { type APIRequestContext, expect, type Page, test } from '@playwright/test'
import { RELAY } from './_harness'

/**
 * RUNTIME VERIFICATION OF THE TWO EXTRACTED FLOWS (POD-407).
 *
 * POD-407 pulled the inline-rename lifecycle into `use-inline-rename.ts` and the
 * agent→repo→machine submenu into `NewAgentMenu.tsx`. Both are REAL-CLICK paths
 * — a double-click that swaps a row's label for an input, and a nested menu that
 * decides where code executes — and neither is provable from unit tests alone:
 * the rename commits on BLUR, and the submenu's disabled states are Base UI
 * behaviour rather than our own markup.
 *
 * The existing sidebar suites cover the spawn button but stop short of both, and
 * the one rename suite that exists (`session-rename-skeleton`) renames a
 * SESSION, not an issue row. So this file is the verification the acceptance
 * criteria ask for, and it exists because the alternative was citing a suite
 * that does not test the thing.
 *
 * Desktop-only: the aside sidebar is not rendered by the mobile layout.
 */
test.skip(({ isMobile }) => isMobile, 'desktop verification: the sidebar is desktop-only')
test.setTimeout(120_000)

const HTTP = RELAY.replace(/^ws/, 'http')
const PORT = Number(process.env.PORT ?? 8799)

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

/** `repos.list` answers with PATHS, and the harness registers its own scratch
 *  repo — prefer it, fall back to whatever is first. */
async function firstRepoPath(request: APIRequestContext): Promise<string> {
  const repos = await rpc<string[]>(request, 'repos.list', undefined, 'get')
  const path = repos.find((r) => basename(r) === `zz-podium-e2e-repo-${PORT}`) ?? repos[0]
  if (!path) throw new Error('harness registered no repo; cannot seed an issue')
  return path
}

/**
 * Seed an issue that the SIDEBAR will actually show.
 *
 * `issues.create` lands in `backlog`, and the worklist is the ACTIVE work list,
 * not the whole tracker — a backlog row renders in the Tasks board and
 * deliberately not in the sidebar. Verified against this harness: a freshly
 * created issue appears as `ZZP-1` under Backlog on /issues while the aside
 * shows only the spawn row. So the stage move is part of the fixture, not a
 * workaround.
 */
async function seedSidebarIssue(
  request: APIRequestContext,
  repoPath: string,
  title: string,
): Promise<string> {
  const issue = await rpc<{ id: string }>(request, 'issues.create', {
    repoPath,
    title,
    startNow: false,
  })
  await rpc(request, 'issues.update', { id: issue.id, patch: { stage: 'in_progress' } })
  return issue.id
}

/** One issue's current title/updatedAt, read back from the server. */
async function issueRow(
  request: APIRequestContext,
  repoPath: string,
  id: string,
): Promise<{ title: string; updatedAt?: string } | undefined> {
  const rows = await rpc<{ id: string; title: string; updatedAt?: string }[]>(
    request,
    'issues.list',
    { repoPath },
    'get',
  )
  return rows.find((r) => r.id === id)
}

async function openSidebar(page: Page): Promise<void> {
  await page.setViewportSize({ width: 1280, height: 900 })
  await page.goto(`/?server=${RELAY}&e2e=1`)
  await page.waitForFunction(() => !document.querySelector('.app-loading'), undefined, {
    timeout: 60_000,
  })
  await page.locator('aside').first().waitFor({ state: 'visible', timeout: 60_000 })
}

test('inline rename: a no-op commit writes nothing, a real one reaches the server', async ({
  page,
  request,
}) => {
  const repoPath = await firstRepoPath(request)
  const before = `pod407 rename me ${Date.now()}`
  const after = `pod407 renamed ok ${Date.now()}`
  const issueId = await seedSidebarIssue(request, repoPath, before)

  await openSidebar(page)
  const aside = page.locator('aside').first()
  const label = aside.getByText(before, { exact: false }).first()
  // The work list scrolls — assert PRESENCE, then bring the row into view.
  // `toBeVisible` alone fails on a row that exists but sits below the fold,
  // which reads as "never rendered" and is a different bug entirely.
  await expect(label).toHaveCount(1, { timeout: 30_000 })
  await label.scrollIntoViewIfNeeded()
  await expect(label).toBeVisible({ timeout: 10_000 })

  const seeded = await issueRow(request, repoPath, issueId)

  // ---- 1. THE NO-OP HALF (#170) ----------------------------------------
  // Open the editor and blur it without changing anything. The editor commits
  // on BLUR, so this is the real commit path carrying an identical value, and
  // it must NOT write: a double-click is reachable by fumbling, and a write
  // here would be a revision bump and a feed change for no user intent.
  //
  // Both halves live in ONE test, on ONE row, deliberately. As two tests the
  // second depended on the sidebar state the first left behind, and it passed
  // alone while failing in sequence — an ordering dependence that would have
  // read as a flake forever.
  await label.dblclick()
  const editor = aside.locator('input[type="text"]').first()
  await expect(editor).toBeVisible({ timeout: 10_000 })
  await editor.blur()

  await expect(aside.getByText(before, { exact: false }).first()).toHaveCount(1, {
    timeout: 15_000,
  })
  const afterNoop = await issueRow(request, repoPath, issueId)
  expect(afterNoop?.title).toBe(before)
  expect(afterNoop?.updatedAt).toBe(seeded?.updatedAt)

  // ---- 2. THE REAL RENAME ----------------------------------------------
  const label2 = aside.getByText(before, { exact: false }).first()
  await label2.scrollIntoViewIfNeeded()
  await label2.dblclick()
  const editor2 = aside.locator('input[type="text"]').first()
  await expect(editor2).toBeVisible({ timeout: 10_000 })
  // Select-all-on-open means the first keystroke replaces the whole name.
  await editor2.fill(after)
  await editor2.press('Enter')

  await expect(aside.getByText(after, { exact: false }).first()).toHaveCount(1, {
    timeout: 15_000,
  })

  // The row is not the claim — the SERVER is. A rename that only repaints
  // locally is the failure an optimistic UI hides best.
  await expect
    .poll(async () => (await issueRow(request, repoPath, issueId))?.title, { timeout: 20_000 })
    .toBe(after)
})

test('new-agent submenu: the agent→repo menu opens and offers a real spawn target', async ({
  page,
}) => {
  await openSidebar(page)
  const aside = page.locator('aside').first()

  await aside.getByRole('button', { name: 'Choose agent and repo' }).click()
  const claude = page.getByRole('menuitem', { name: 'New Claude' })
  await expect(claude).toBeVisible({ timeout: 10_000 })

  // Into the repo level — the submenu the extraction owns.
  await claude.hover()
  const repoItem = page.getByRole('menuitem').filter({ hasNotText: 'New ' }).first()
  await expect(repoItem).toBeVisible({ timeout: 10_000 })

  // Every machine row this menu paints carries its availability, and an
  // unusable one is never clickable (§3.1.4 M5). On the single-machine harness
  // the repo level is flat, so assert the invariant over whatever rows exist
  // rather than requiring a fleet the harness does not have.
  const machineRows = page.getByTestId('new-agent-machine')
  for (let i = 0; i < (await machineRows.count()); i++) {
    const row = machineRows.nth(i)
    const availability = await row.getAttribute('data-availability')
    expect(['available', 'unreachable', 'unauthorized']).toContain(availability)
    if (availability !== 'available') await expect(row).toBeDisabled()
  }
})
