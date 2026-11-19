import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabase } from '@podium/runtime/sqlite'
import { janitorWorkerTarget } from '../apps/server/src/janitor-worker-embed.js'
import { DRIZZLE_MIGRATIONS } from '../apps/server/src/migrations/drizzle-manifest.generated.js'
import { runDrizzleMigrations } from '../apps/server/src/migrations/index.js'
import { JanitorWorkerClient } from '../packages/janitor/src/worker-client.js'

const dir = mkdtempSync(join(tmpdir(), 'podium-janitor-worker-smoke-'))
const dbPath = join(dir, 'podium.db')
// This smoke verifies worker readiness with the maintenance server deliberately offline.
// Boot reads the workspace with a feed and its active admin through the store's query
// definitions (POD-6993), so the database is a migrated store: the chain creates both.
const db = openDatabase(dbPath)
try {
  runDrizzleMigrations(db, DRIZZLE_MIGRATIONS)
} finally {
  db.close()
}

const client = new JanitorWorkerClient(
  {
    serverUrl: 'http://127.0.0.1:1',
    token: 'compiled-smoke',
    dbPath,
    tickMs: 60_000,
  },
  { target: janitorWorkerTarget() },
)

const deadline = Date.now() + 8_000
while (client.state() !== 'running' && Date.now() < deadline) {
  await Bun.sleep(20)
}
console.log(client.state() === 'running' ? 'SMOKE_OK' : `SMOKE_BAD ${client.reason()}`)
await client.close()
rmSync(dir, { recursive: true, force: true })
process.exit(0)
