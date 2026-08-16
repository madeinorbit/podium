/**
 * Runtime drive of Settings → Updates against the branch app (POD-2103).
 *
 * Kept here rather than in `tests/e2e/browser/` on purpose: this is evidence,
 * not a gate. The gates for this surface are the happy-dom suites next to the
 * component; what only a real drive can show is that the section renders what
 * THIS SERVER actually serves — `operations.history` bytes straight out of
 * SQLite, `fleet().channelChecks` as the coordinator recorded them, and
 * `updates.checkNow` answering a real button press.
 *
 * Run it against the harness (which serves the built branch web on its own
 * origin, matching production):
 *
 *   bun scripts/browser-lane.ts --build-only         # or a filtered web build
 *   PORT=8799 PODIUM_UPDATE_CHANNEL=edge \
 *     bun --conditions=@podium/source tests/e2e/serve-harness.ts &
 *   bun .artifacts/POD-2103/capture-updates.ts
 *
 * The three history rows are seeded straight into the harness database because
 * a fresh harness has never run an update, and an empty list is exactly the one
 * state this issue's screenshot must NOT be. `OperationStore.history()` queries
 * SQLite on every call, so a seeded row travels the whole real path — store →
 * engine → `operations.history` → `parseOperation` → the section.
 */
import { Database } from 'bun:sqlite'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { chromium } from 'playwright'

const PORT = Number(process.env.PORT ?? 8799)
const ORIGIN = `http://localhost:${PORT}`
const RELAY = `ws://localhost:${PORT}`
const OUT = new URL('.', import.meta.url).pathname
const STATE_DIR = join(
  process.env.PODIUM_TEST_HOST_TMPDIR?.trim() || tmpdir(),
  `podium-e2e-${PORT}`,
  'state',
)

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const now = Date.now()

/** Three outcomes, because the row a support conversation needs is the failed one. */
const OPERATIONS = [
  {
    id: 'op_01jdrive0finished',
    state: 'done',
    startedAt: now - 11 * HOUR,
    finishedAt: now - 11 * HOUR + 4 * MINUTE,
    version: '0.4.3',
    error: null,
  },
  {
    id: 'op_01jdrive1failed',
    state: 'failed',
    startedAt: now - 2 * HOUR,
    finishedAt: now - 2 * HOUR + 90_000,
    version: '0.4.3',
    error: {
      code: 'machine-dirty-checkout',
      message: 'vmi3407763 refused the grant',
      detail: 'git status reported 3 modified files under apps/server',
      places: ['vmi3407763'],
    },
  },
  {
    id: 'op_01jdrive2canceled',
    state: 'canceled',
    startedAt: now - 26 * HOUR,
    finishedAt: now - 26 * HOUR + 12_000,
    version: '0.4.2',
    error: null,
  },
]

function seedHistory(): void {
  mkdirSync(STATE_DIR, { recursive: true })
  const db = new Database(join(STATE_DIR, 'podium.db'))
  const insert = db.prepare(
    `INSERT OR REPLACE INTO operations
       (id, kind, exclusion_group, state, created_at, updated_at, finished_at, payload)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  )
  for (const row of OPERATIONS) {
    const payload = {
      id: row.id,
      kind: 'update',
      exclusionGroup: 'lifecycle',
      state: row.state,
      createdBy: 'user',
      details: { target: { version: row.version, channel: 'edge' } },
      createdAt: row.startedAt,
      startedAt: row.startedAt,
      updatedAt: row.finishedAt,
      finishedAt: row.finishedAt,
      steps: [
        { id: 'prepare', title: 'Preparing the update', state: 'done' },
        {
          id: 'machines',
          title: 'Updating your machines',
          state: row.state === 'done' ? 'done' : 'failed',
        },
      ],
      error: row.error,
    }
    insert.run(
      row.id,
      'update',
      'lifecycle',
      row.state,
      row.startedAt,
      row.finishedAt,
      row.finishedAt,
      JSON.stringify(payload),
    )
  }
  db.close()
  console.log(`seeded ${OPERATIONS.length} operations into ${STATE_DIR}/podium.db`)
}

async function main(): Promise<void> {
  seedHistory()

  const browser = await chromium.launch({ args: ['--no-sandbox', '--disable-dev-shm-usage'] })
  const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } })

  await page.goto(`${ORIGIN}/?server=${RELAY}&e2e=1`)
  await page.locator('aside').first().waitFor({ state: 'visible', timeout: 180_000 })
  await page.evaluate(() => {
    history.pushState(null, '', `/settings/updates${location.search}`)
    dispatchEvent(new PopStateEvent('popstate'))
  })
  await page.getByRole('heading', { name: 'Updates' }).waitFor({ timeout: 60_000 })

  // The audit trail has to be there before the shutter: a screenshot taken
  // while history was still loading would prove nothing about §3.7.
  await page.getByText('Podium 0.4.3').first().waitFor({ timeout: 60_000 })
  await page.getByRole('button', { name: 'What happened?' }).first().click()
  await page.getByText(/local edits that prevent a safe update/).waitFor({ timeout: 15_000 })

  await page.screenshot({ path: join(OUT, 'settings-updates.png'), fullPage: true })
  console.log('captured settings-updates.png')

  // The button is driven for real — the note under it is whatever the service
  // said, rate window included.
  const check = page.getByRole('button', { name: 'Check now' })
  await check.click()
  // The note only exists once the mutation has answered; screenshotting the
  // in-flight "Checking…" would prove nothing about what the server said.
  await page.getByRole('button', { name: 'Check now' }).waitFor({ timeout: 60_000 })
  const note = page.locator('[role="status"]').filter({ hasText: /\S/ }).first()
  await note.waitFor({ timeout: 60_000 })
  console.log(`check now said: ${await note.innerText()}`)
  await page.screenshot({ path: join(OUT, 'settings-updates-checked.png'), fullPage: true })
  console.log('captured settings-updates-checked.png')

  // The audit trail runs past the fold; the third shot is the list itself.
  await page.getByText('Recent updates').scrollIntoViewIfNeeded()
  await page.mouse.wheel(0, 400)
  await page.screenshot({ path: join(OUT, 'settings-updates-history.png'), fullPage: true })
  console.log('captured settings-updates-history.png')

  // Nothing the server said may reach the page in its own vocabulary (§6.3).
  const body = await page.locator('body').innerText()
  for (const banned of ['No update target is configured.', 'No target:']) {
    if (body.includes(banned)) throw new Error(`banned precondition string rendered: ${banned}`)
  }
  console.log('no precondition string reachable in the section')

  await browser.close()
}

await main()
