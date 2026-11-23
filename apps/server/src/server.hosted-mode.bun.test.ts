/**
 * A hosted server (POD-7308): `startServer({ mode: 'hosted' })` on each store
 * engine turns off every shortcut that trusts the machine it runs on. One test
 * per shortcut; a self-hosted boot of the same shape is the control that shows
 * each one is there when the mode allows it.
 *
 * And its workspace edge (POD-7309): every listed entry point of the real
 * server is bound to the workspace the process loaded, refuses a request that
 * names none, and refuses one that names another workspace of the same
 * database, which this process did not load.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { asUserId, asWorkspaceId } from '@podium/model'
import { serverControlSocketPath } from '@podium/runtime/user-socket'
import { userCommandPrincipal } from './command-principal'
import { noJanitorWorkerForTests } from './janitor-host'
import { SuperagentService } from './modules/superagent'
import { RepoRegistry } from './repo-registry'
import { appRouter } from './router'
import { type ServerHandle, startServer } from './server'
import type { ServerMode } from './server-mode'
import { DATABASE_URL_ENV } from './store'
import { bunPgTestDatabase } from './test-support/pg-test-host'
import { cookieOf, httpsFacts } from './test-support/test-identity'
import { type EntryPoint, WORKSPACE_ENTRY_POINTS } from './workspace-edge'

/** The workspace a hosted fixture loads, and its slug. */
const HOSTED_WORKSPACE = 'ws_hosted_a'
const HOSTED_SLUG = 'acme'
/** Another workspace of the same database, which the process did not load. */
const OTHER_WORKSPACE = 'ws_hosted_b'

const ENV_KEYS = [
  'PODIUM_STATE_DIR',
  DATABASE_URL_ENV,
  'PODIUM_MODE',
  'PODIUM_UPDATE_FEED_POLLING',
  'PODIUM_DEV_SOURCE_ROOT',
]

/** A first-run server (no deployment mode chosen yet) whose config waives sign-in on this machine. */
function bootFixture(engine: 'sqlite' | 'pg', mode: ServerMode) {
  const fixture = {
    root: '',
    server: undefined as unknown as ServerHandle,
    pg: undefined as Awaited<ReturnType<typeof bunPgTestDatabase>> | undefined,
    caller: undefined as unknown as ReturnType<typeof appRouter.createCaller>,
    origin: () => `http://127.0.0.1:${fixture.server.port}`,
  }
  const previous = new Map<string, string | undefined>()

  beforeAll(async () => {
    fixture.root = mkdtempSync(join(tmpdir(), `server-${mode}-`))
    for (const key of ENV_KEYS) previous.set(key, process.env[key])
    process.env.PODIUM_STATE_DIR = fixture.root
    delete process.env.PODIUM_MODE
    process.env.PODIUM_UPDATE_FEED_POLLING = 'off'
    // A source checkout, so the development release publisher would start if allowed.
    process.env.PODIUM_DEV_SOURCE_ROOT = fileURLToPath(new URL('../../../', import.meta.url))
    writeFileSync(
      join(fixture.root, 'config.json'),
      JSON.stringify({ configVersion: 2, persistence: 'systemd', auth: { openMode: true } }),
    )
    if (engine === 'pg') {
      fixture.pg = await bunPgTestDatabase()
      process.env[DATABASE_URL_ENV] = fixture.pg.url
    } else delete process.env[DATABASE_URL_ENV]
    fixture.server = await startServer({
      port: 0,
      mode,
      ...(mode === 'hosted' ? { workspaceId: HOSTED_WORKSPACE, workspaceSlug: HOSTED_SLUG } : {}),
      janitorWorkerForTests: noJanitorWorkerForTests,
    })
    // A hosted workspace is created with its first admin by the root (in the
    // cloud, together with the creator's membership). Only the self-hosted
    // install's `local` workspace has one from its migrations.
    if (mode === 'hosted') {
      await fixture.server.identity.memberships.adopt({
        by: 'setup',
        role: 'admin',
        status: 'active',
        account: { kind: 'new', name: 'Founder', email: 'founder@example.test' },
      })
    }
    const admin = await fixture.server.registry.sessionStore.users.earliestAdmin()
    if (!admin) throw new Error('Missing boot administrator')
    const principal = userCommandPrincipal(asUserId(admin.id), 'admin')
    fixture.caller = appRouter.createCaller({
      registry: fixture.server.registry,
      repos: new RepoRegistry(fixture.server.registry.sessionStore),
      superagent: new SuperagentService(fixture.server.registry),
      principal,
      capability: principal.capability,
      serverPlacement: { kind: 'external' },
    })
  }, 120_000)

  afterAll(async () => {
    await fixture.server?.close()
    await fixture.pg?.drop()
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    if (fixture.root) rmSync(fixture.root, { recursive: true, force: true })
  }, 60_000)

  return fixture
}

/** The host-local setup bootstrap: a first-run tRPC read with no sign-in, from this machine. */
const bootstrapRead = async (origin: string, headers: Record<string, string> = {}) =>
  await fetch(`${origin}/trpc/setup.info?input=%7B%7D`, { headers: { origin, ...headers } })

/** Names the hosted fixture's workspace by its slug. */
const NAMES_LOADED = { 'Podium-Workspace': HOSTED_SLUG }

/** A concrete path an entry point answers. */
const samplePath = (entry: EntryPoint) =>
  entry.path.endsWith('/') ? `${entry.path}sample` : entry.path
const BOUND = WORKSPACE_ENTRY_POINTS.filter((entry) => entry.binding !== 'unbound')

for (const engine of ['sqlite', 'pg'] as const) {
  describe(`hosted server (${engine})`, () => {
    const f = bootFixture(engine, 'hosted')

    it('reads one mode and derives its capabilities from it', () => {
      expect(f.server.capabilities.mode).toBe('hosted')
      expect(f.server.registry.sessionStore.hostMachine).toBeNull()
      expect(existsSync(join(f.root, 'machine.json'))).toBe(false)
    })

    it('creates no control socket: no login password, member recovery or host sign-in', () => {
      // `podium setup`'s password, `podium auth recovery-link` and `podium auth
      // mint-session` (/v1/host-sign-in) are served only on this socket.
      expect(f.server.capabilities.controlSocket).toBe(false)
      expect(existsSync(serverControlSocketPath({ instanceId: f.server.instanceId }))).toBe(false)
    })

    it('admits no request by the same-machine rule, whatever authOpenMode says', async () => {
      const status = await fetch(`${f.origin()}/auth/status`, { headers: NAMES_LOADED })
      expect(await status.json()).toMatchObject({ error: 'https_required' })
      expect(await f.server.identity.signInRequired()).toBe(true)
    })

    it('acts as no earliest admin for the setup bootstrap', async () => {
      expect(await (await fetch(`${f.origin()}/readiness`)).json()).toMatchObject({
        state: 'unconfigured',
      })
      const response = await bootstrapRead(f.origin(), NAMES_LOADED)
      expect(response.status).not.toBe(200)
    })

    it('serves no /setup/* route', async () => {
      expect((await fetch(`${f.origin()}/setup/config`)).status).toBe(404)
      expect((await fetch(`${f.origin()}/setup/mobile`)).status).toBe(404)
    })

    it('refuses a lock held as the shared operator with a typed error', async () => {
      await expect(
        f.caller.lock.acquire({ repoPath: '/repo', name: 'merge:main' }),
      ).rejects.toMatchObject({
        name: 'HostedModeRefusal',
        code: 'PRECONDITION_FAILED',
        feature: 'operator-lock',
      })
    })

    describe('the workspace edge', () => {
      /** A member of the loaded workspace, signed in; over HTTPS as the proxy reports it. */
      let asMember: Record<string, string>
      beforeAll(async () => {
        expect(f.server.registry.sessionStore.workspaceId).toBe(HOSTED_WORKSPACE)
        expect(f.server.identity.workspaceId).toBe(HOSTED_WORKSPACE)
        await f.server.registry.sessionStore.database.provisionWorkspace(
          asWorkspaceId(OTHER_WORKSPACE),
        )
        const memberships = f.server.identity.memberships
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
        const issued = await f.server.identity.core.signIn.password(
          {
            email: 'member@example.test',
            password: 'member password 1',
            device: { kind: 'browser' },
            delivery: 'cookie',
          },
          httpsFacts(),
        )
        if ('refused' in issued) throw new Error(`sign-in refused: ${issued.refused}`)
        asMember = { cookie: cookieOf(issued), 'x-forwarded-proto': 'https' }
      })

      const send = (path: string, headers: Record<string, string>) =>
        fetch(`${f.origin()}${path}`, { method: 'POST', headers: { ...asMember, ...headers } })

      it('refuses every bound entry point a request that names no workspace', async () => {
        for (const entry of BOUND) {
          const response = await send(samplePath(entry), {})
          expect(response.status, entry.path).toBe(400)
          expect(await response.json(), entry.path).toMatchObject({ error: 'workspace_required' })
        }
      })

      it('refuses every bound entry point a request that names another workspace of its database', async () => {
        for (const entry of BOUND) {
          for (const naming of [
            { 'Podium-Workspace': OTHER_WORKSPACE },
            { 'Podium-Workspace-Id': OTHER_WORKSPACE },
          ]) {
            const response = await send(samplePath(entry), naming)
            expect(response.status, entry.path).toBe(404)
            expect(await response.json(), entry.path).toMatchObject({
              error: 'workspace_not_served',
            })
          }
          const query = await send(`${samplePath(entry)}?workspace=${OTHER_WORKSPACE}`, {})
          expect(query.status, entry.path).toBe(404)
        }
        const artifact = await fetch(
          `${f.origin()}/files/artifact/workspace/${OTHER_WORKSPACE}/iss_1/art_1/index.html`,
          { headers: asMember },
        )
        expect(artifact.status).toBe(404)
      })

      it('binds a member who names the loaded workspace, by slug or id, to it', async () => {
        for (const naming of [NAMES_LOADED, { 'Podium-Workspace-Id': HOSTED_WORKSPACE }]) {
          const status = await fetch(`${f.origin()}/auth/status`, {
            headers: { ...asMember, ...naming },
          })
          expect(await status.json()).toMatchObject({
            authed: true,
            // The device keys its stores by the bound workspace (POD-7312).
            syncBoundaryId: HOSTED_WORKSPACE,
          })
        }
        const viewer = await fetch(`${f.origin()}/auth/admin/viewer`, {
          headers: { ...asMember, ...NAMES_LOADED },
        })
        expect(viewer.status).toBe(200)
        const query = await fetch(`${f.origin()}/trpc/machines.list`, {
          headers: { ...asMember, ...NAMES_LOADED },
        })
        expect(query.status).toBe(200)
      })

      it('serves the unbound routes without a selector', async () => {
        for (const path of ['/health', '/version', '/.well-known/podium', '/readiness']) {
          expect((await fetch(`${f.origin()}${path}`)).status, path).toBe(200)
        }
      })
    })

    it('publishes no development release', async () => {
      expect(await f.caller.updates.proposal()).toBeNull()
      await expect(
        f.caller.updates.approveProposal({ headSha: 'a'.repeat(40), version: '0.0.1' }),
      ).rejects.toMatchObject({
        code: 'PRECONDITION_FAILED',
        message: 'This server does not publish development releases.',
      })
    })
  })
}

describe('self-hosted server of the same shape (control)', () => {
  const f = bootFixture('sqlite', 'self-hosted')

  it('has its control socket, setup routes and host-local bootstrap', async () => {
    expect(f.server.capabilities.mode).toBe('self-hosted')
    expect(existsSync(serverControlSocketPath({ instanceId: f.server.instanceId }))).toBe(true)
    expect((await fetch(`${f.origin()}/setup/config`)).status).toBe(200)
    expect((await fetch(`${f.origin()}/setup/mobile`)).status).toBe(200)
    expect((await bootstrapRead(f.origin())).status).toBe(200)
  })

  it('needs no selector, and reads none (POD-7309)', async () => {
    expect(f.server.registry.sessionStore.workspaceId).toBe('local')
    for (const headers of [{}, { 'Podium-Workspace': 'some-slug' }]) {
      const status = await fetch(`${f.origin()}/auth/status`, { headers })
      expect(status.status).toBe(200)
    }
  })
})
