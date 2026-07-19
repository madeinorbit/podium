import { Database } from 'bun:sqlite'
import { chromium, expect } from '@playwright/test'

const ROOT = '/home/mgw/src/other/podium/.worktrees/issue-790-issues-vertical-on-new-architecture'
const STATE = '/tmp/pod-798-runtime-10c647cc/state'
const DB = `${STATE}/podium.db`
const PORT = 28798
const BASE = `http://localhost:${PORT}`
const OUT = `${ROOT}/docs/internal/pod-798-evidence`

type ServerProcess = ReturnType<typeof Bun.spawn>
type DaemonProcess = ReturnType<typeof Bun.spawn>

async function waitForHealth(up: boolean, timeoutMs = 60_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    let healthy = false
    try {
      healthy = (await fetch(`${BASE}/health`, { signal: AbortSignal.timeout(1_000) })).ok
    } catch {
      healthy = false
    }
    if (healthy === up) return
    await Bun.sleep(250)
  }
  throw new Error(`server did not become ${up ? 'healthy' : 'offline'} within ${timeoutMs}ms`)
}

async function startServer(): Promise<ServerProcess> {
  const proc = Bun.spawn(
    ['bun', '--conditions=@podium/source', 'scripts/switch-bench-serve.ts'],
    {
      cwd: ROOT,
      env: {
        ...process.env,
        BENCH_STATE: STATE,
        PORT: String(PORT),
        PODIUM_PORT: String(PORT),
        PODIUM_NO_SCOPE: '1',
        PODIUM_NO_RELAY: '1',
      },
      stdout: 'inherit',
      stderr: 'inherit',
    },
  )
  await waitForHealth(true)
  return proc
}

async function stopServer(proc: ServerProcess): Promise<void> {
  proc.kill('SIGTERM')
  await proc.exited
  await waitForHealth(false)
}

async function startDaemon(): Promise<DaemonProcess> {
  const daemonCode = `
    import { readFileSync, mkdirSync } from 'node:fs'
    import { join } from 'node:path'
    import { startDaemon } from '${ROOT}/apps/daemon/src/daemon.ts'
    import { LOCAL_MACHINE_ID } from '${ROOT}/apps/server/src/local-machine.ts'
    const stateDir = process.env.PODIUM_STATE_DIR
    if (!stateDir) throw new Error('PODIUM_STATE_DIR is required')
    mkdirSync(join(stateDir, 'hooks'), { recursive: true })
    mkdirSync('/tmp/pod-798-runtime-10c647cc/empty-home', { recursive: true })
    await startDaemon({
      serverUrl: process.env.PODIUM_SERVER_URL,
      bootstrapToken: readFileSync(join(stateDir, 'daemon.secret'), 'utf8').trim(),
      machineId: LOCAL_MACHINE_ID,
      installCodexHooks: false,
      discovery: { background: false, homeDir: '/tmp/pod-798-runtime-10c647cc/empty-home' },
      metrics: { background: false },
      hooks: { port: 0, settingsDir: join(stateDir, 'hooks') },
      agentRelay: { port: 0 },
      launch: () => ({ cmd: '/bin/false', args: [], cwd: process.cwd() }),
    })
    await new Promise(() => {})
  `
  const proc = Bun.spawn(['bun', '--conditions=@podium/source', '-e', daemonCode], {
    cwd: ROOT,
    env: {
      ...process.env,
      PODIUM_STATE_DIR: STATE,
      PODIUM_SERVER_URL: `ws://localhost:${PORT}`,
      PODIUM_NO_SCOPE: '1',
      PODIUM_NO_RELAY: '1',
      ABDUCO_SOCKET_DIR: '/tmp/pod-798-runtime-10c647cc/abduco',
      TMUX_TMPDIR: '/tmp/pod-798-runtime-10c647cc/tmux',
    },
    stdout: 'inherit',
    stderr: 'inherit',
  })
  await Bun.sleep(4_000)
  return proc
}

async function stopDaemon(proc: DaemonProcess): Promise<void> {
  proc.kill('SIGTERM')
  await proc.exited
}

function queryOne<T>(sql: string, ...params: (string | number | null)[]): T {
  const db = new Database(DB, { readonly: true })
  try {
    const row = db.query(sql).get(...params) as T | null
    if (!row) throw new Error(`query returned no row: ${sql}`)
    return row
  } finally {
    db.close()
  }
}

async function waitForDbTitle(title: string, timeoutMs = 60_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const found = queryOne<{ n: number }>('SELECT count(*) n FROM issues WHERE title=?', title).n
    if (found === 1) return
    await Bun.sleep(250)
  }
  throw new Error(`database never received title: ${title}`)
}

const before = queryOne<{ issues: number; sessions: number; nullIssueIds: number }>(
  `SELECT
     (SELECT count(*) FROM issues) issues,
     (SELECT count(*) FROM sessions) sessions,
     (SELECT count(*) FROM sessions WHERE issue_id IS NULL) nullIssueIds`,
)
const blocked = queryOne<{ id: string; ref: string; title: string; blockerRef: string }>(
  `SELECT a.id,
          coalesce(p.prefix || '-', '#') || a.seq ref,
          a.title,
          coalesce(bp.prefix || '-', '#') || b.seq blockerRef
     FROM issue_deps d
     JOIN issues a ON a.id=d.from_id
     JOIN issues b ON b.id=d.to_id
     LEFT JOIN repo_prefixes p ON p.repo_id=a.repo_id
     LEFT JOIN repo_prefixes bp ON bp.repo_id=b.repo_id
    WHERE d.type='blocks' AND a.stage<>'done' AND b.stage<>'done'
      AND a.deleted_at IS NULL AND b.deleted_at IS NULL
      AND a.archived=0 AND b.archived=0
    ORDER BY a.seq LIMIT 1`,
)
const ready = queryOne<{ id: string; ref: string; title: string }>(
  `WITH active_blockers AS (
     SELECT d.from_id,count(*) n FROM issue_deps d
     JOIN issues b ON b.id=d.to_id
     WHERE d.type='blocks' AND b.stage<>'done' GROUP BY d.from_id
   )
   SELECT i.id, coalesce(p.prefix || '-', '#') || i.seq ref, i.title
     FROM issues i
     LEFT JOIN active_blockers ab ON ab.from_id=i.id
     LEFT JOIN repo_prefixes p ON p.repo_id=i.repo_id
    WHERE i.stage<>'done' AND i.deleted_at IS NULL AND i.archived=0
      AND coalesce(ab.n,0)=0
      AND (i.defer_until IS NULL OR datetime(i.defer_until)<=datetime('now'))
    ORDER BY CASE WHEN i.id='iss_c69d4f20-d672-437f-8605-20509f2b755b' THEN 0 ELSE 1 END,
             i.seq LIMIT 1`,
)

let server = await startServer()
const daemon = await startDaemon()
const browser = await chromium.launch({
  headless: true,
  args: ['--no-sandbox', '--disable-dev-shm-usage'],
})
const context = await browser.newContext({ viewport: { width: 1600, height: 1000 } })
await context.tracing.start({ screenshots: true, snapshots: true, sources: true })
const page = await context.newPage()
const pageErrors: string[] = []
page.on('pageerror', (err) => pageErrors.push(err.message))

try {
  await page.goto(`${BASE}/?e2e=1&switchTrace=1`, {
    waitUntil: 'domcontentloaded',
    timeout: 120_000,
  })
  const closeOnboarding = page.getByRole('button', { name: 'Close' })
  try {
    await closeOnboarding.click({ timeout: 8_000 })
  } catch {
    // Existing replica repo metadata bypassed onboarding.
  }
  await page.locator('aside').first().waitFor({ state: 'visible', timeout: 60_000 })
  // A server-only live-scale harness has no connected daemon, so the cold shell
  // offers repository discovery. Dismiss it; issue truth already came from the DB.
  const repoDiscovery = page.getByRole('dialog', { name: 'Find repositories' })
  if (await repoDiscovery.isVisible()) await page.keyboard.press('Escape')
  await page.getByRole('navigation', { name: 'Primary' }).getByRole('button', { name: 'Tasks', exact: true }).click()
  const board = page.getByRole('region', { name: /Tasks|Issues/ })
  await expect(board).toBeVisible({ timeout: 60_000 })
  const flatten = board.getByRole('button', { name: 'Flatten', exact: true })
  if ((await flatten.getAttribute('aria-pressed')) !== 'true') await flatten.click()

  const blockedCard = board.locator(`[data-issue-id="${blocked.id}"]`)
  await expect(blockedCard).toContainText(blocked.ref)
  await expect(blockedCard).toContainText(blocked.title)
  await expect(blockedCard.locator('[aria-label="Blocked"]')).toBeVisible()

  await board.getByRole('button', { name: 'Filter', exact: true }).click()
  const filterMenu = page.locator('[data-slot="dropdown-menu-content"]:visible')
  await filterMenu.getByRole('menuitem', { name: 'Status', exact: true }).hover()
  await page.locator('[data-slot="dropdown-menu-sub-content"]:visible').getByRole('menuitem', { name: 'ready', exact: true }).click()
  const readyCard = board.locator(`[data-issue-id="${ready.id}"]`)
  await expect(readyCard).toContainText(ready.ref)
  await expect(readyCard).toContainText(ready.title)
  await page.screenshot({ path: `${OUT}/01-live-scale-board-ready-blocked-refs.png`, fullPage: true })
  await board.getByRole('button', { name: 'Status: ready', exact: true }).click()

  // The selected ready row is POD-3, one of the nine boot-backfilled cwd-only sessions.
  await readyCard.click()
  const issuePage = page.getByTestId('issue-page')
  await expect(issuePage).toBeVisible()
  const issueAside = page.getByTestId('issue-aside')
  await expect(issueAside.getByRole('heading', { name: 'Sessions (1)' })).toBeVisible()
  await expect(issueAside.getByRole('button', { name: /Add auto continue mode for agent errors/ })).toBeVisible()
  await page.screenshot({ path: `${OUT}/02-boot-backfill-member-session.png`, fullPage: true })
  await page.locator('button[title="Back"]').click()

  const stamp = Date.now()
  const createdTitle = `POD-798 runtime ${stamp}`
  const onlineTitle = `${createdTitle} online-edit`
  const offlineTitle = `${createdTitle} offline-drained`

  await board.getByRole('button', { name: /New (Task|Issue)/ }).click()
  const dialog = page.getByRole('dialog')
  await expect(dialog).toBeVisible()
  await dialog.getByLabel('Title').fill(createdTitle)
  const startNow = dialog.getByRole('checkbox', { name: 'Start work now' })
  if (await startNow.isChecked()) await startNow.uncheck()
  const create = dialog.getByRole('button', { name: /^Create$/ })
  await expect(create).toBeEnabled({ timeout: 30_000 })
  await create.click()
  await expect(dialog).toBeHidden({ timeout: 30_000 })
  await waitForDbTitle(createdTitle)

  const created = queryOne<{ id: string; ref: string }>(
    `SELECT i.id, coalesce(p.prefix || '-', '#') || i.seq ref
       FROM issues i LEFT JOIN repo_prefixes p ON p.repo_id=i.repo_id WHERE i.title=?`,
    createdTitle,
  )
  const createdCard = board.locator(`[data-issue-id="${created.id}"]`)
  await expect(createdCard).toContainText(created.ref)
  await createdCard.click()
  await page.getByTitle('Click to edit title').click()
  const titleInput = page.getByLabel('Task title')
  await titleInput.fill(onlineTitle)
  await titleInput.press('Enter')
  await expect(page.getByTitle('Click to edit title')).toContainText(onlineTitle)
  await waitForDbTitle(onlineTitle)

  const status = page.getByTestId('issue-aside').getByTestId('status-trigger')
  await status.click()
  const statusMenu = page.locator('[data-slot="dropdown-menu-content"]:visible')
  await statusMenu.locator('input').first().fill('Close: done')
  await statusMenu.getByRole('menuitem').filter({ hasText: 'Close: done' }).click()
  await expect(status).toContainText('Closed', { timeout: 90_000 })
  const closed = queryOne<{ stage: string; closedReason: string | null }>(
    'SELECT stage,closed_reason closedReason FROM issues WHERE id=?',
    created.id,
  )
  if (closed.stage !== 'done' || closed.closedReason !== 'done') {
    throw new Error(`close did not round-trip: ${JSON.stringify(closed)}`)
  }
  await page.screenshot({ path: `${OUT}/03-command-create-edit-close.png`, fullPage: true })

  // ADR 2 D7: keep this already-loaded UI alive while the authority is absent.
  await stopServer(server)
  await page.getByTitle('Click to edit title').click()
  await page.getByLabel('Task title').fill(offlineTitle)
  await page.getByLabel('Task title').press('Enter')
  await expect(page.getByText(/1 pending change/)).toBeVisible({ timeout: 15_000 })
  const outboxKeys = await page.evaluate(() => Object.keys(localStorage).filter((k) => k.includes('outbox')))
  if (outboxKeys.length === 0) throw new Error('offline edit painted but no durable outbox key exists')
  await page.screenshot({ path: `${OUT}/04-offline-edit-queued.png`, fullPage: true })

  server = await startServer()
  await waitForDbTitle(offlineTitle, 90_000)
  await expect(page.getByText(/1 pending change/)).toHaveCount(0, { timeout: 90_000 })
  await expect(page.getByTitle('Click to edit title')).toContainText(offlineTitle)
  await page.screenshot({ path: `${OUT}/05-offline-edit-drained.png`, fullPage: true })

  const after = queryOne<{ issues: number; sessions: number; nullIssueIds: number }>(
    `SELECT
       (SELECT count(*) FROM issues) issues,
       (SELECT count(*) FROM sessions) sessions,
       (SELECT count(*) FROM sessions WHERE issue_id IS NULL) nullIssueIds`,
  )
  await Bun.write(
    `${OUT}/runtime-results.json`,
    JSON.stringify(
      {
        head: '10c647cc4d2591fc2aba71a9a76271ecc0e1cf7c',
        state: DB,
        port: PORT,
        beforeScript: before,
        afterScript: after,
        bootBackfill: { nullBeforeBoot: 309, nullAfterBoot: 300, attached: 9 },
        spotChecks: { blocked: { ...blocked, uiBlockedIcon: true }, ready },
        mutation: {
          id: created.id,
          ref: created.ref,
          createdTitle,
          onlineTitle,
          closed,
          offlineTitle,
          outboxKeys,
          drainedToDatabase: true,
        },
        pageErrors,
      },
      null,
      2,
    ),
  )
} finally {
  await context.tracing.stop({ path: `${OUT}/runtime-trace.zip` })
  await browser.close()
  await stopDaemon(daemon).catch(() => undefined)
  await stopServer(server).catch(() => undefined)
}

console.log('POD-798 runtime verification complete')
