import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseServerProcessRoles, type ServerProcessRole } from '@podium/runtime/config'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { JanitorHost, StartJanitorWorkerFn } from './janitor-host'
import { startServer } from './server'

/**
 * ONE BINARY, SEVERAL ROLES (POD-7332; POD-6954 design 4.1 and 4.12).
 *
 * A server process runs any mix of `api` (the HTTP app), `sync` (client sync
 * sockets and daemon links) and `worker` (the janitor and every background
 * job). Naming none is every role, which is how every self-hosted server runs.
 *
 * Each case boots a real server and asserts both halves of "exactly that
 * part": what answers on its listener, and which loops it started. Loops are
 * read twice over: the names the composition root reports as it starts them,
 * and the registry's own sweep timers, which a process without the worker role
 * must not create at all.
 */
const priorEnv = {
  stateDir: process.env.PODIUM_STATE_DIR,
  roles: process.env.PODIUM_SERVER_ROLES,
}

const ALL: readonly ServerProcessRole[] = ['api', 'sync', 'worker']

/** The registry's periodic sweeps (relay.ts): created only with the worker role. */
const REGISTRY_SWEEPS = [
  'messageSweep',
  'credentialExpirySweep',
  'queuedInputSweep',
  'pendingUploadSweep',
] as const

function fakeJanitor(): JanitorHost {
  return {
    progressVersion: () => 1,
    state: () => 'running',
    reason: () => undefined,
    close: async () => {},
  }
}

describe('server process roles', () => {
  let stateDir: string
  let handle: Awaited<ReturnType<typeof startServer>> | undefined
  let janitorStarts: number

  const janitor: StartJanitorWorkerFn = async () => {
    janitorStarts += 1
    return fakeJanitor()
  }

  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), 'podium-server-roles-'))
    process.env.PODIUM_STATE_DIR = stateDir
    delete process.env.PODIUM_SERVER_ROLES
    janitorStarts = 0
  })

  afterEach(async () => {
    await handle?.close()
    handle = undefined
    for (const [key, value] of [
      ['PODIUM_STATE_DIR', priorEnv.stateDir],
      ['PODIUM_SERVER_ROLES', priorEnv.roles],
    ] as const) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    rmSync(stateDir, { recursive: true, force: true })
  })

  async function boot(roles?: readonly string[]): Promise<NonNullable<typeof handle>> {
    handle = await startServer({
      port: 0,
      janitorWorkerForTests: janitor,
      ...(roles ? { roles } : {}),
    })
    return handle
  }

  const url = (path: string): string => `http://127.0.0.1:${handle?.port}${path}`

  /** What the listener answers for each role's surface. */
  async function surfaces(): Promise<{ health: number; api: number; sync: number; worker: number }> {
    const health = (await fetch(url('/health'))).status
    // The api: the HTTP app's own version route.
    const api = (await fetch(url('/version'))).status
    // Sync: a socket path asked without the capability it needs is refused by
    // the socket plane itself (426), never by the HTTP app.
    const sync = (await fetch(url('/client'))).status
    // The worker: the janitor's maintenance channel refuses a missing credential.
    const worker = (
      await fetch(url('/maintenance/handshake'), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      })
    ).status
    return { health, api, sync, worker }
  }

  /** Wait for the parts that start after the handle resolves (the janitor). */
  async function settled(server: NonNullable<typeof handle>, part?: string): Promise<void> {
    const deadline = Date.now() + 5_000
    while (part !== undefined && !server.started().has(part) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    // A janitor start is awaited off the listen path; give a non-start the same window.
    await new Promise((resolve) => setTimeout(resolve, 50))
  }

  /** Every started part belongs to a role this process runs. */
  function expectOnlyRoles(server: NonNullable<typeof handle>, roles: readonly string[]): void {
    for (const part of server.started()) {
      const owner = part.split('.')[0] as string
      if (owner === 'listener') continue
      expect(roles, `'${part}' started in a process running ${roles.join(',')}`).toContain(owner)
    }
  }

  function registrySweeps(server: NonNullable<typeof handle>): Record<string, boolean> {
    const fields = server.registry as unknown as Record<string, unknown>
    return Object.fromEntries(REGISTRY_SWEEPS.map((name) => [name, fields[name] !== undefined]))
  }

  it('runs every role when none is named: the self-hosted default', async () => {
    const server = await boot()
    await settled(server, 'worker.janitor')
    expect([...server.roles].sort()).toEqual([...ALL].sort())
    expect(await surfaces()).toEqual({ health: 200, api: 200, sync: 426, worker: 401 })
    for (const part of [
      'listener',
      'api.http',
      'sync.sockets',
      'worker.janitor',
      'worker.identitySweep',
      'worker.messaging',
      'worker.snapshotCatalogue',
      'worker.updateTargetRefresh',
    ]) {
      expect(server.started(), part).toContain(part)
    }
    expect(janitorStarts).toBe(1)
    expect(server.localDaemonLink).toBeDefined()
    expect(server.registry.backgroundWork).toBe(true)
    expect(Object.values(registrySweeps(server))).toEqual(REGISTRY_SWEEPS.map(() => true))
  })

  it('api alone serves the HTTP app and starts no socket plane and no background work', async () => {
    const server = await boot(['api'])
    await settled(server)
    expect([...server.roles]).toEqual(['api'])
    expect(await surfaces()).toMatchObject({ health: 200, api: 200, worker: 404 })
    // No socket plane: `/client` reaches the HTTP app, which has no such route.
    expect((await surfaces()).sync).not.toBe(426)
    expect(server.started()).toContain('listener')
    expect(server.started()).toContain('api.http')
    expectOnlyRoles(server, ['api'])
    expect(janitorStarts).toBe(0)
    expect(server.localDaemonLink).toBeUndefined()
    expect(server.registry.backgroundWork).toBe(false)
    expect(Object.values(registrySweeps(server))).toEqual(REGISTRY_SWEEPS.map(() => false))
  })

  it('sync alone accepts sockets and answers no HTTP route but /health', async () => {
    const server = await boot(['sync'])
    await settled(server)
    expect(await surfaces()).toEqual({ health: 200, api: 404, sync: 426, worker: 404 })
    expect((await fetch(url('/trpc/auth.status'))).status).toBe(404)
    expect(server.started()).toContain('listener')
    expect(server.started()).toContain('sync.sockets')
    expectOnlyRoles(server, ['sync'])
    expect(janitorStarts).toBe(0)
    // The in-process daemon link is a daemon link: the sync role's.
    expect(server.localDaemonLink).toBeDefined()
    expect(server.registry.backgroundWork).toBe(false)
    expect(Object.values(registrySweeps(server))).toEqual(REGISTRY_SWEEPS.map(() => false))
  })

  it('worker alone runs the janitor and the sweeps behind a loopback-only listener', async () => {
    const server = await boot(['worker'])
    await settled(server, 'worker.janitor')
    expect(await surfaces()).toEqual({ health: 200, api: 404, sync: 404, worker: 401 })
    // No public port: the listener is the janitor's private channel.
    expect(server.started()).toContain('listener.loopback')
    expect(server.started()).not.toContain('listener')
    for (const part of [
      'worker.janitor',
      'worker.identitySweep',
      'worker.messaging',
      'worker.updateTargetRefresh',
    ]) {
      expect(server.started(), part).toContain(part)
    }
    expectOnlyRoles(server, ['worker'])
    expect(janitorStarts).toBe(1)
    expect(server.localDaemonLink).toBeUndefined()
    expect(server.registry.backgroundWork).toBe(true)
    expect(Object.values(registrySweeps(server))).toEqual(REGISTRY_SWEEPS.map(() => true))
  })

  it('reads PODIUM_SERVER_ROLES when the root names none; an explicit list wins', async () => {
    process.env.PODIUM_SERVER_ROLES = 'sync'
    const fromEnv = await boot()
    expect([...fromEnv.roles]).toEqual(['sync'])
    await fromEnv.close()
    handle = undefined
    const explicit = await boot(['api', 'worker'])
    expect([...explicit.roles].sort()).toEqual(['api', 'worker'])
  })

  it('refuses to boot a role it does not know or does not have', async () => {
    await expect(startServer({ port: 0, roles: ['api', 'cache'] })).rejects.toThrow(
      /unknown server role 'cache'/,
    )
    await expect(startServer({ port: 0, roles: ['room'] })).rejects.toThrow(
      /'room' role is not in this build/,
    )
    process.env.PODIUM_SERVER_ROLES = 'worker,'
    expect([...parseServerProcessRoles(process.env.PODIUM_SERVER_ROLES)]).toEqual(['worker'])
  })
})
