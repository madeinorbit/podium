/**
 * A SERVER STARTED ON A POSTGRES URL SERVES A SESSION CREATE AND A BOOTSTRAP [POD-6994].
 *
 * The whole composition, booted as production boots it, its store named by
 * `PODIUM_DATABASE_URL`: a clone of the Postgres leg's template, which holds what a fresh
 * SQLite store holds (`test-support/pg-template-seed.ts`). Under `bun test`, not vitest,
 * because the bootstrap is served by the real sync worker thread, which reads its own
 * session on the same Postgres URL (`sync-worker/read-session.ts`), and vitest's fork
 * runtime keeps the server from starting that thread. The janitor runs too.
 *
 * Needs the Postgres test server: the `podium-test-pg` container, which this file starts
 * if it is missing (`bunPgTestDatabase`), or `PODIUM_TEST_PG_URL`. Run it with
 * `bun run test:file -- apps/server/src/server.postgres.bun.test.ts`.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createTRPCClient, httpBatchLink } from '@trpc/client'

const { startServer } = await import('./server')
const { DATABASE_URL_ENV } = await import('./store')
const { attachHostDaemon } = await import('./test-support/host-daemon')
const { bunPgTestDatabase } = await import('./test-support/pg-test-host')
type AppRouter = import('./router').AppRouter

describe('a server started on a Postgres URL', () => {
  const prior = {
    stateDir: process.env.PODIUM_STATE_DIR,
    databaseUrl: process.env[DATABASE_URL_ENV],
    mode: process.env.PODIUM_MODE,
  }
  let stateDir: string
  let database: Awaited<ReturnType<typeof bunPgTestDatabase>>
  let server: Awaited<ReturnType<typeof startServer>>
  let trpc: ReturnType<typeof createTRPCClient<AppRouter>>

  beforeAll(async () => {
    stateDir = mkdtempSync(join(tmpdir(), 'podium-server-postgres-'))
    database = await bunPgTestDatabase()
    process.env.PODIUM_STATE_DIR = stateDir
    process.env[DATABASE_URL_ENV] = database.url
    // A configured install, so the data plane serves (readiness reads the mode).
    process.env.PODIUM_MODE = 'all-in-one'
    server = await startServer({ port: 0 })
    // The host's daemon, in process: a session is created on an assigned, online machine.
    await attachHostDaemon(server.registry)
    trpc = createTRPCClient<AppRouter>({
      links: [httpBatchLink({ url: `http://127.0.0.1:${server.port}/trpc` })],
    })
  }, 120_000)

  afterAll(async () => {
    await server?.close()
    await database?.drop()
    for (const [key, value] of [
      ['PODIUM_STATE_DIR', prior.stateDir],
      [DATABASE_URL_ENV, prior.databaseUrl],
      ['PODIUM_MODE', prior.mode],
    ] as const) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    rmSync(stateDir, { recursive: true, force: true })
  }, 60_000)

  it('creates a session and serves it in a bootstrap from the sync worker', async () => {
    const cwd = mkdtempSync(join(stateDir, 'cwd-'))
    const { sessionId } = await trpc.sessions.create.mutate({ agentKind: 'shell', cwd })
    expect((await trpc.sessions.list.query()).map((session) => session.sessionId)).toContain(
      sessionId,
    )

    const response = await fetch(`http://127.0.0.1:${server.port}/sync/bootstrap`)
    expect(response.status).toBe(200)
    const changes = (await response.text())
      .trim()
      .split('\n')
      .map(
        (line) =>
          JSON.parse(line) as {
            type: string
            changes?: { entity: string; entityId?: string; value?: { cwd?: string } }[]
          },
      )
      .filter((record) => record.type === 'feedBootstrap')
      .flatMap((record) => record.changes ?? [])
    expect(
      changes.some((change) => change.entity === 'session' && change.entityId === sessionId),
    ).toBe(true)
  }, 60_000)
})
