/**
 * "Boot + basic ops" proof: run the REAL SessionStore (apps/server/src/store.ts)
 * against the bundled Postgres via the synchronous libpq FFI adapter — no changes
 * to store.ts beyond an injectable-db seam. Proves migrate() + representative CRUD
 * work on Postgres.
 *
 * Run: PODIUM_PG_LIBPQ=<libpq.so> LD_LIBRARY_PATH=<pg/lib> \
 *      bun --conditions=@podium/source scripts/exp/store-on-pg.ts
 */
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { SessionStore, type SessionRow } from '../../apps/server/src/store.ts'
import { openPostgresDatabase } from '../../packages/core/src/postgres/index.ts'
import EmbeddedPostgres from 'embedded-postgres'

const dataDir = process.argv[2] ?? '/tmp/claude-1000/-home-user-src-other-podium/16176d5a-17d0-439d-84f3-468aa7832434/scratchpad/pgdata-store'
const port = Number(process.argv[3] ?? 54330)
const libpq = process.env.PODIUM_PG_LIBPQ
if (!libpq) throw new Error('set PODIUM_PG_LIBPQ to the bundled libpq.so path')

let pass = 0
let fail = 0
function check(name: string, cond: boolean, detail = '') {
  if (cond) {
    pass++
    console.log(`  ✓ ${name}`)
  } else {
    fail++
    console.log(`  ✗ ${name} ${detail}`)
  }
}

const pg = new EmbeddedPostgres({
  databaseDir: dataDir,
  port,
  user: 'podium',
  password: 'podium',
  authMethod: 'password',
  persistent: true,
  postgresFlags: ['-c', 'wal_level=logical', '-c', 'max_wal_senders=4', '-c', 'max_replication_slots=4'],
})

async function main() {
  if (!existsSync(join(dataDir, 'PG_VERSION'))) await pg.initialise()
  await pg.start()
  console.log(`[exp] postgres up on ${port}`)

  const conn = `host=127.0.0.1 port=${port} user=podium password=podium dbname=postgres`
  const db = openPostgresDatabase(conn, { libpq })

  // The big one: construct the real SessionStore → runs the full migrate() on PG.
  console.log('\n=== migrate() on Postgres ===')
  const store = new SessionStore(':memory:', db)
  check('SessionStore constructed (migrate() ran without throwing)', true)

  console.log('\n=== basic ops on Postgres ===')

  // repos (INSERT OR IGNORE + ORDER BY rowid->ctid)
  store.addRepo('/tmp/repoA', '__local__', 'git@example.com:a.git')
  store.addRepo('/tmp/repoB')
  store.addRepo('/tmp/repoA') // duplicate -> ON CONFLICT DO NOTHING
  const repos = store.listRepos()
  check('addRepo + listRepos (dedup via ON CONFLICT)', repos.length === 2, `got ${repos.length}`)
  check('listRepos preserves origin_url', repos.find((r) => r.path === '/tmp/repoA')?.originUrl === 'git@example.com:a.git')

  // pins
  store.setPin('repo', '/tmp/repoA', true)
  check('setPin + listPins', store.listPins().repos.includes('/tmp/repoA'))
  store.setPin('repo', '/tmp/repoA', false)
  check('unpin', !store.listPins().repos.includes('/tmp/repoA'))

  // snoozes
  store.setSnooze('sess1', '2030-01-01T00:00:00Z')
  check('setSnooze + listSnoozes', store.listSnoozes(Date.now())['sess1'] === '2030-01-01T00:00:00Z')

  // tab order (JSON text round-trip)
  store.setTabOrder('/wt', ['a', 'b', 'c'])
  check('setTabOrder + listTabOrders', JSON.stringify(store.listTabOrders()['/wt']) === JSON.stringify(['a', 'b', 'c']))

  // drafts
  store.setDraft('sess1', 'hello draft')
  check('setDraft + loadDrafts', store.loadDrafts()['sess1'] === 'hello draft')

  // sessions (big INSERT ... ON CONFLICT DO UPDATE; INTEGER + TEXT columns)
  const row: SessionRow = {
    id: 'sess-x',
    agentKind: 'claude-code',
    cwd: '/tmp/repoA',
    title: 'My Session',
    name: null,
    originKind: 'spawn',
    conversationId: null,
    resumeKind: null,
    resumeValue: null,
    status: 'live',
    exitCode: null,
    durableLabel: 'podium-sess-x',
    createdAt: new Date().toISOString(),
    lastActiveAt: new Date().toISOString(),
    lastOutputAt: null,
    lastInputAt: null,
    lastResumedAt: null,
    archived: false,
    workState: null,
    machineId: '__local__',
  }
  store.upsertSession(row)
  store.upsertSession({ ...row, title: 'Renamed', exitCode: 0, status: 'exited' }) // conflict update
  const sessions = store.loadSessions()
  const s = sessions.find((x) => x.id === 'sess-x')
  check('upsertSession + loadSessions', !!s, `count=${sessions.length}`)
  check('upsertSession ON CONFLICT update applied', s?.title === 'Renamed', `title=${s?.title}`)
  check('integer column coerced to number (exitCode)', s?.exitCode === 0, `exitCode=${s?.exitCode} (${typeof s?.exitCode})`)
  check('boolean column round-trip (archived)', s?.archived === false, `archived=${s?.archived}`)

  // superagent messages (IDENTITY id + lastInsertRowid via lastval())
  const m = store.appendSuperagentMessage('global', { role: 'user', content: 'hi from pg' })
  check('appendSuperagentMessage returns id>0 (lastval())', m.id > 0, `id=${m.id}`)
  const msgs = store.loadSuperagentMessages('global', 10)
  check('loadSuperagentMessages', msgs.some((x) => x.content === 'hi from pg'))

  // meta via settings (INSERT OR REPLACE -> ON CONFLICT DO UPDATE)
  const settings = store.getSettings()
  store.setSettings({ ...settings })
  check('getSettings/setSettings (meta INSERT OR REPLACE)', true)

  db.close()
  await pg.stop()

  console.log(`\n=== RESULT: ${pass} passed, ${fail} failed ===`)
  process.exit(fail === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error('[exp] FAILED:', e)
  process.exit(1)
})
