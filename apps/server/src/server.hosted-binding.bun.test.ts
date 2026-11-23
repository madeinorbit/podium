/**
 * A CONFIGURED HOSTED SERVER SERVES ITS BOUND WORKSPACE PAST EVERY GATE
 * (POD-7309, review F4).
 *
 * `startServer({ mode: 'hosted', workspaceId, workspaceSlug })` on each store
 * engine, with a deployment mode chosen so the data plane serves, and with the
 * real sync worker thread (under `bun test`, as `server.postgres.bun.test.ts`
 * explains). A signed-in member who names the loaded workspace reaches the
 * tRPC context, the sync worker and the artifact route with the bound
 * workspace; a request that names none or another is refused at the edge.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const { startServer } = await import('./server')
const { DATABASE_URL_ENV } = await import('./store')
const { bunPgTestDatabase } = await import('./test-support/pg-test-host')
const { cookieOf, httpsFacts } = await import('./test-support/test-identity')

const WORKSPACE = 'ws_bound_hosted'
const SLUG = 'bound'

for (const engine of ['sqlite', 'pg'] as const) {
  describe(`a configured hosted server (${engine})`, () => {
    const prior = {
      stateDir: process.env.PODIUM_STATE_DIR,
      databaseUrl: process.env[DATABASE_URL_ENV],
      mode: process.env.PODIUM_MODE,
      polling: process.env.PODIUM_UPDATE_FEED_POLLING,
    }
    let stateDir: string
    let database: Awaited<ReturnType<typeof bunPgTestDatabase>> | undefined
    let server: Awaited<ReturnType<typeof startServer>>
    let member: Record<string, string>
    const origin = () => `http://127.0.0.1:${server.port}`
    const get = (path: string, headers: Record<string, string> = {}) =>
      fetch(`${origin()}${path}`, { headers: { ...member, ...headers } })

    beforeAll(async () => {
      stateDir = mkdtempSync(join(tmpdir(), `podium-hosted-binding-${engine}-`))
      process.env.PODIUM_STATE_DIR = stateDir
      process.env.PODIUM_UPDATE_FEED_POLLING = 'off'
      // A configured install, so the data plane serves (readiness reads the mode).
      process.env.PODIUM_MODE = 'server'
      if (engine === 'pg') {
        database = await bunPgTestDatabase()
        process.env[DATABASE_URL_ENV] = database.url
      } else delete process.env[DATABASE_URL_ENV]
      server = await startServer({
        port: 0,
        mode: 'hosted',
        workspaceId: WORKSPACE,
        workspaceSlug: SLUG,
      })
      const { memberships, core } = server.identity
      // The root creates a hosted workspace with its first admin.
      await memberships.adopt({
        by: 'setup',
        role: 'admin',
        status: 'active',
        account: { kind: 'new', name: 'Owner', email: 'owner@example.test' },
      })
      const { invitation } = await memberships.invite({
        actor: { system: 'host' },
        role: 'member',
        email: 'member@example.test',
      })
      await memberships.accept({
        token: invitation.token,
        account: {
          kind: 'new',
          name: 'Member',
          email: 'member@example.test',
          password: 'member password 1',
        },
      })
      const issued = await core.signIn.password(
        {
          email: 'member@example.test',
          password: 'member password 1',
          device: { kind: 'browser' },
          delivery: 'cookie',
        },
        httpsFacts(),
      )
      if ('refused' in issued) throw new Error(`sign-in refused: ${issued.refused}`)
      // Over HTTPS as the loopback proxy hop reports it.
      member = { cookie: cookieOf(issued), 'x-forwarded-proto': 'https' }
    }, 120_000)

    afterAll(async () => {
      await server?.close()
      await database?.drop()
      for (const [key, value] of [
        ['PODIUM_STATE_DIR', prior.stateDir],
        [DATABASE_URL_ENV, prior.databaseUrl],
        ['PODIUM_MODE', prior.mode],
        ['PODIUM_UPDATE_FEED_POLLING', prior.polling],
      ] as const) {
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
      rmSync(stateDir, { recursive: true, force: true })
    }, 60_000)

    it('loads the workspace its root named', () => {
      expect(server.registry.sessionStore.workspaceId).toBe(WORKSPACE)
      expect(server.identity.workspaceId).toBe(WORKSPACE)
    })

    it("answers the member's status in the bound workspace", async () => {
      for (const naming of [{ 'Podium-Workspace': SLUG }, { 'Podium-Workspace-Id': WORKSPACE }]) {
        const status = await get('/auth/status', naming)
        expect(await status.json()).toMatchObject({ authed: true, syncBoundaryId: WORKSPACE })
      }
    })

    it('serves a tRPC query to the member, with the bound workspace in its context', async () => {
      const response = await get('/trpc/machines.list', { 'Podium-Workspace': SLUG })
      expect(response.status).toBe(200)
      expect(await response.json()).toMatchObject({ result: { data: expect.anything() } })
    })

    it("serves the bound workspace's bootstrap from the sync worker", async () => {
      const response = await get('/sync/bootstrap', { 'Podium-Workspace': SLUG })
      expect(response.status).toBe(200)
      const records = (await response.text())
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line) as { type: string })
      expect(records.some((record) => record.type === 'feedBootstrap')).toBe(true)
    }, 60_000)

    it('reaches the artifact route for a path naming the bound workspace, by slug or id', async () => {
      for (const segment of [SLUG, WORKSPACE]) {
        const response = await get(
          `/files/artifact/workspace/${segment}/iss_none/art_none/a.html`,
          {
            'Podium-Workspace': SLUG,
          },
        )
        // The route's own answer for an artifact that does not exist.
        expect(response.status, segment).toBe(404)
        expect(await response.text(), segment).toBe('not found')
      }
    })

    it('refuses the same requests at the edge when they name no workspace or another', async () => {
      for (const path of ['/trpc/machines.list', '/sync/bootstrap', '/auth/status']) {
        const none = await get(path)
        expect(none.status, path).toBe(400)
        expect(await none.json(), path).toMatchObject({ error: 'workspace_required' })
        const other = await get(path, { 'Podium-Workspace': 'ws_somebody_else' })
        expect(other.status, path).toBe(404)
        expect(await other.json(), path).toMatchObject({ error: 'workspace_not_served' })
      }
    })
  })
}
