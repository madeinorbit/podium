import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabase } from '@podium/runtime/sqlite'
import { JanitorWorkerClient } from '../packages/janitor/src/worker-client.js'

const dir = mkdtempSync(join(tmpdir(), 'podium-janitor-worker-smoke-'))
const dbPath = join(dir, 'podium.db')
// This smoke verifies worker readiness with the maintenance server deliberately offline.
// Boot still requires an active admin; no maintenance tables are read without a handshake.
const db = openDatabase(dbPath)
try {
  db.exec(`
    CREATE TABLE users (id TEXT PRIMARY KEY, role TEXT, disabled_at TEXT, created_at TEXT);
    INSERT INTO users VALUES ('compiled-smoke-admin', 'admin', NULL, '2026-01-01T00:00:00Z');
  `)
} finally {
  db.close()
}

const client = new JanitorWorkerClient({
  serverUrl: 'http://127.0.0.1:1',
  token: 'compiled-smoke',
  dbPath,
  tickMs: 60_000,
})

const deadline = Date.now() + 8_000
while (client.state() !== 'running' && Date.now() < deadline) {
  await Bun.sleep(20)
}
console.log(client.state() === 'running' ? 'SMOKE_OK' : `SMOKE_BAD ${client.reason()}`)
await client.close()
rmSync(dir, { recursive: true, force: true })
process.exit(0)
