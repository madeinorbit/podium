/** POD-798 remaining deliverable 1: OFFLINE-EDIT-DRAINS (ADR 2 D7) on the
 *  isolated stack. Reuses the runtime-verifier.ts setup that produced 01-03. */
import { Database } from 'bun:sqlite'
import { chromium, expect } from '@playwright/test'

const ROOT = '/home/mgw/src/other/podium/.worktrees/issue-790-issues-vertical-on-new-architecture'
const STATE = '/tmp/pod-798-runtime-10c647cc/state'
const DB = `${STATE}/podium.db`
const PORT = 28798
const BASE = `http://localhost:${PORT}`
const OUT = `${ROOT}/docs/internal/pod-798-evidence`

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

async function startServer() {
  const proc = Bun.spawn(['bun', '--conditions=@podium/source', 'scripts/switch-bench-serve.ts'], {
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
  })
  await waitForHealth(true)
  return proc
}

async function stopServer(proc: ReturnType<typeof Bun.spawn>) {
  proc.kill('SIGTERM')
  await proc.exited
  await waitForHealth(false)
}

function queryOne<T>(sql: string, ...params: (string | number)[]): T {
  const db = new Database(DB, { readonly: true })
  try {
    const row = db.query(sql).get(...params) as T | null
    if (!row) throw new Error(`no row: ${sql}`)
    return row
  } finally {
    db.close()
  }
}

async function waitForDbTitle(title: string, timeoutMs = 90_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (queryOne<{ n: number }>('SELECT count(*) n FROM issues WHERE title=?', title).n === 1) return
    await Bun.sleep(250)
  }
  throw new Error(`database never received title: ${title}`)
}

async function startDaemon() {
  const daemonCode = `
    import { readFileSync, mkdirSync } from 'node:fs'
    import { join } from 'node:path'
    import { startDaemon } from '${ROOT}/apps/daemon/src/daemon.ts'
    import { LOCAL_MACHINE_ID } from '${ROOT}/apps/server/src/local-machine.ts'
    const stateDir = process.env.PODIUM_STATE_DIR
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

let server = await startServer()
const daemon = await startDaemon()
const browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] })
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } })
const pageErrors: string[] = []
page.on('pageerror', (err) => pageErrors.push(err.message))

try {
  await page.goto(`${BASE}/?e2e=1`, { waitUntil: 'domcontentloaded', timeout: 120_000 })
  try {
    await page.getByRole('button', { name: 'Close' }).click({ timeout: 8_000 })
  } catch {}
  await page.locator('aside').first().waitFor({ state: 'visible', timeout: 60_000 })
  const repoDiscovery = page.getByRole('dialog', { name: 'Find repositories' })
  if (await repoDiscovery.isVisible()) await page.keyboard.press('Escape')
  await page
    .getByRole('navigation', { name: 'Primary' })
    .getByRole('button', { name: 'Tasks', exact: true })
    .click()
  const board = page.getByRole('region', { name: /Tasks|Issues/ })
  await expect(board).toBeVisible({ timeout: 60_000 })
  const flatten = board.getByRole('button', { name: 'Flatten', exact: true })
  if ((await flatten.getAttribute('aria-pressed')) !== 'true') await flatten.click()

  const stamp = Date.now()
  const createdTitle = `POD-798 offline-drain ${stamp}`

  // canSubmit requires a repoPath, snapshotted at dialog mount — if repos
  // haven't streamed in yet the Create button never enables. Retry the mount.
  const dialog = page.getByRole('dialog')
  let created$ = false
  for (let attempt = 0; attempt < 6 && !created$; attempt++) {
    await board.getByRole('button', { name: /New (Task|Issue)/ }).click()
    await expect(dialog).toBeVisible()
    await dialog.getByLabel('Title').fill(createdTitle)
    const startNow = dialog.getByRole('checkbox', { name: 'Start work now' })
    if (await startNow.isChecked()) await startNow.uncheck()
    const create = dialog.getByRole('button', { name: /^Create$/ })
    try {
      await expect(create).toBeEnabled({ timeout: 10_000 })
      await create.click()
      created$ = true
    } catch {
      await page.keyboard.press('Escape')
      await expect(dialog).toBeHidden({ timeout: 10_000 })
      await page.waitForTimeout(3_000)
    }
  }
  if (!created$) throw new Error('Create never enabled — repos never loaded')
  await expect(dialog).toBeHidden({ timeout: 30_000 })
  await waitForDbTitle(createdTitle)
  const created = queryOne<{ id: string }>('SELECT id FROM issues WHERE title=?', createdTitle)
  const card = board.locator(`[data-issue-id="${created.id}"]`)
  // While ONLINE: context menu -> "Mark as read" stamps issues.read_at (#124).
  await card.click({ button: 'right' })
  await page.getByRole('menuitem', { name: /Mark as read/i }).click()
  {
    const deadline = Date.now() + 60_000
    while (Date.now() < deadline) {
      const r = queryOne<{ readAt: string | null }>('SELECT read_at readAt FROM issues WHERE id=?', created.id)
      if (r.readAt) break
      await Bun.sleep(250)
    }
  }
  const readAtOnline = queryOne<{ readAt: string | null }>(
    'SELECT read_at readAt FROM issues WHERE id=?',
    created.id,
  ).readAt
  if (!readAtOnline) throw new Error('issue never marked read while online — cannot demo the unread drain')

  // --- ADR 2 D7: sever the authority, make an outbox-covered issue edit ---
  // NOTE (honest scope): at 10c647cc the outbox covers issueMarkRead/issueMarkUnread
  // among issue mutations (OutboxKinds in packages/client-core/src/engine/wiring.ts);
  // issues.update (title/desc) is trpc-direct and fails fast offline. So the
  // offline edit exercised here is "Mark as unread" from the issue context menu.
  await stopServer(server)
  await card.click({ button: 'right' })
  await page.getByRole('menuitem', { name: /Mark as unread/i }).click()
  await page.waitForTimeout(3_000)
  // Durable-queue proof: the entry sits in the replica-backed outbox collection
  // (localStorage `podium.replica.outbox.v1`), surviving reload/reconnect.
  const queuedUnread = await page.evaluate(() => {
    const raw = localStorage.getItem('podium.replica.outbox.v1') ?? '{}'
    const rows = Object.values(JSON.parse(raw)) as { data?: { kind?: string; input?: { id?: string } } }[]
    return rows.filter((r) => r.data?.kind === 'issueMarkUnread').map((r) => r.data?.input?.id)
  })
  if (queuedUnread.length !== 1) throw new Error(`expected 1 queued issueMarkUnread, got ${queuedUnread.length}`)
  const outboxKeys = await page.evaluate(() =>
    Object.keys(localStorage).filter((k) => k.toLowerCase().includes('outbox')),
  )
  const readAtWhileOffline = queryOne<{ readAt: string | null }>(
    'SELECT read_at readAt FROM issues WHERE id=?',
    created.id,
  ).readAt
  await page.screenshot({ path: `${OUT}/04-offline-edit-drains-1-queued.png`, fullPage: true })

  // --- restart the authority; the outbox must drain into the server DB ---
  server = await startServer()
  {
    const deadline = Date.now() + 120_000
    let drained = false
    while (Date.now() < deadline) {
      const r = queryOne<{ readAt: string | null }>('SELECT read_at readAt FROM issues WHERE id=?', created.id)
      if (r.readAt === null) {
        drained = true
        break
      }
      await Bun.sleep(250)
    }
    if (!drained) throw new Error('offline mark-unread never drained to the server DB')
  }
  // Queue must be empty of the entry after the drain.
  {
    const deadline = Date.now() + 60_000
    let empty = false
    while (Date.now() < deadline) {
      const left = await page.evaluate(() => {
        const raw = localStorage.getItem('podium.replica.outbox.v1') ?? '{}'
        const rows = Object.values(JSON.parse(raw)) as { data?: { kind?: string } }[]
        return rows.filter((r) => r.data?.kind === 'issueMarkUnread').length
      })
      if (left === 0) {
        empty = true
        break
      }
      await Bun.sleep(500)
    }
    if (!empty) throw new Error('issueMarkUnread entry still queued after reconnect')
  }
  await page.screenshot({ path: `${OUT}/04-offline-edit-drains-2-landed.png`, fullPage: true })

  console.log(
    JSON.stringify(
      {
        createdId: created.id,
        createdTitle,
        readAtOnline,
        readAtWhileOffline,
        readAtAfterDrain: null,
        outboxKeys,
        drainedToDatabase: true,
        pageErrors,
      },
      null,
      2,
    ),
  )
} finally {
  await browser.close()
  daemon.kill('SIGTERM')
  await daemon.exited.catch(() => undefined)
  await stopServer(server).catch(() => undefined)
}
console.log('offline-edit-drains complete')
