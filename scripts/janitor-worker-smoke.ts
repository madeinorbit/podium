import { JanitorWorkerClient } from '../apps/janitor/src/worker-client.js'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dir = mkdtempSync(join(tmpdir(), 'podium-janitor-worker-smoke-'))
const dbPath = join(dir, 'podium.db')
writeFileSync(dbPath, '')

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
client.close()
rmSync(dir, { recursive: true, force: true })
process.exit(0)
