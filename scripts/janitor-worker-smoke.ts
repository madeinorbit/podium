import { JanitorWorkerClient } from '../packages/janitor/src/worker-client.js'

/**
 * WHY THE DATABASE IS HANDED IN RATHER THAN MADE HERE.
 *
 * This smoke exists to prove one thing: that `bun build --compile` embeds the
 * janitor worker module and the resulting binary can LOAD it. The assertion on
 * the other side is `not.toContain('ModuleNotFound')`; reaching `running` is how
 * the binary demonstrates the module actually resolved.
 *
 * Since PDM-125 the janitor resolves its own identity from its database and
 * refuses to start when that database names no active admin member, rather than
 * assuming one. The zero-byte file this script used to write is exactly such a
 * database — a schema from before accounts existed, as far as
 * `earliestAdminMember` can tell — so the binary reported `SMOKE_BAD janitor
 * requires an active admin member`. That is a true statement about the FIXTURE
 * and no statement at all about the embed this smoke is here to check.
 *
 * Building a migrated database in this file instead would pull the server's
 * migration chain into the compiled binary, which is precisely the module graph
 * the smoke is supposed to keep small and honest. So the harness builds one and
 * names it here, the same shape PDM-125's own worker-identity test uses.
 */
const dbPath = process.env.PODIUM_JANITOR_SMOKE_DB
if (!dbPath) {
  console.log('SMOKE_BAD PODIUM_JANITOR_SMOKE_DB is unset: this smoke needs a migrated database')
  process.exit(0)
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
process.exit(0)
