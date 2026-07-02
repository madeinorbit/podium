import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, type Page, test } from '@playwright/test'
import { newSession, openApp, podium } from './_harness'

/**
 * Session-follows-view policy, driven through the REAL stack: a shell session
 * reports a worktree move via the daemon's issue-relay loopback (exactly what
 * `podium worktree <path>` does), the daemon resolves + restamps sessionCwd,
 * the server broadcasts, and the web store either FOLLOWS (the moved session
 * is in a visible pane of the selected worktree) or TOASTS (background move).
 *
 * The harness registers a scratch repo with a linked worktree at deterministic
 * per-port paths (serve-harness.ts) so the sidebar has worktrees to move between.
 */
test.skip(({ isMobile }) => isMobile, 'desktop workspace policy only')

const PORT = Number(process.env.PORT ?? 8799)
const SCRATCH_REPO = join(tmpdir(), `zz-podium-e2e-repo-${PORT}`)
const SCRATCH_FEAT = `${SCRATCH_REPO}-feat`
const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url)).replace(/\/$/, '')

const selectedWorktree = (page: Page): Promise<string | null> =>
  page.evaluate(() => localStorage.getItem('podium.selectedWorktree'))

const tabIds = (page: Page): Promise<string[]> =>
  page.$$eval('.overflow-x-auto [data-session]', (els) =>
    (els as HTMLElement[]).map((el) => el.dataset.session ?? ''),
  )

/** Click a worktree nav button in the sidebar by its exact accessible name and
 *  wait for the switch. Scratch-repo rows render as "<name> <branch>", so the
 *  main worktree's accessible name is "main main" and the linked one "e2e-feat". */
async function selectWorktree(page: Page, name: string, path: string): Promise<void> {
  await page
    .locator('aside')
    .first()
    .getByRole('button', { name, exact: true })
    .first()
    .click({ timeout: 15_000 })
  await expect.poll(() => selectedWorktree(page), { timeout: 10_000 }).toBe(path)
}

/** Report a worktree move from INSIDE the session's shell, as an agent would.
 *  `delaySec` queues the report so it can fire after the user looks away. */
async function reportWorktree(page: Page, path: string, delaySec = 0): Promise<void> {
  const curl = `curl -s -X POST "$PODIUM_ISSUE_RELAY" -H 'content-type: application/json' -d '{"router":"session","proc":"setWorktree","input":{"path":"${path}"}}'`
  await podium.send(page, delaySec > 0 ? `(sleep ${delaySec} && ${curl}) &\r` : `${curl}\r`)
}

async function spawnShellTab(page: Page): Promise<string> {
  const preexisting = new Set(await tabIds(page))
  await newSession(page, 'Shell')
  await expect
    .poll(async () => (await tabIds(page)).filter((id) => !preexisting.has(id)).length, {
      timeout: 15_000,
    })
    .toBe(1)
  const mine = (await tabIds(page)).find((id) => !preexisting.has(id))
  if (!mine) throw new Error('spawned tab not found')
  return mine
}

test('a visible-pane session that moves worktrees pulls the whole view along', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 820 })
  await openApp(page)
  await selectWorktree(page, 'main main', SCRATCH_REPO)

  const mine = await spawnShellTab(page)
  await reportWorktree(page, SCRATCH_FEAT)

  // The session was in the visible pane of the selected worktree → the view follows.
  await expect.poll(() => selectedWorktree(page), { timeout: 15_000 }).toBe(SCRATCH_FEAT)
  // And the session is still in the (new worktree's) tab strip — it never vanished.
  await expect.poll(() => tabIds(page), { timeout: 10_000 }).toContain(mine)
})

test('a background session move shows a toast and leaves the view alone', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 820 })
  await openApp(page)
  await selectWorktree(page, 'main main', SCRATCH_REPO)

  await spawnShellTab(page)
  // Queue the move report from inside the shell, then take the user elsewhere
  // BEFORE it fires — the session is background when the move lands.
  await reportWorktree(page, REPO_ROOT, 4)
  await selectWorktree(page, 'e2e-feat', SCRATCH_FEAT)

  // The move (home → REPO_ROOT) fires while the user looks at SCRATCH_FEAT →
  // background policy: a toast announces it, the selection stays put.
  await expect
    .poll(() => page.locator('[data-sonner-toast]').getByText(/moved to/).count(), {
      timeout: 15_000,
    })
    .toBeGreaterThan(0)
  expect(await selectedWorktree(page)).toBe(SCRATCH_FEAT)
})
