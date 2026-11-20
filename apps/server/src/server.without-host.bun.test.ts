/** A server without a host install, on each store engine, with a separate daemon and PTY. */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { shellCommand } from '@podium/harness'
import { createMaintenanceHttpClient } from '@podium/janitor'
import { asMachineId, asUserId } from '@podium/model'
import {
  MAINTENANCE_PROTOCOL_VERSION,
  MAINTENANCE_SCHEMA_VERSION,
  SERVER_MOVE_CAPABILITY,
  stewardPollRunKey,
  wireSchemaDigest,
} from '@podium/protocol'
import { directPtyDurableForTests } from '../../../packages/pty/src/durable'
import { type DaemonHandle, startDaemon } from '../../daemon/src/daemon'
import { userCommandPrincipal } from './command-principal'
import { createMemberOfRequest } from './identity/member-of-request'
import { noJanitorWorkerForTests } from './janitor-host'
import { sha256 } from './modules/machines/enrollment'
import { SuperagentService } from './modules/superagent'
import { RepoRegistry } from './repo-registry'
import { appRouter } from './router'
import { type ServerHandle, startServer } from './server'
import { DATABASE_URL_ENV } from './store'
import { bunPgTestDatabase } from './test-support/pg-test-host'

async function until(check: () => boolean | Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 15_000
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error('Timed out waiting for the remote daemon/session')
    await Bun.sleep(20)
  }
}

for (const engine of ['sqlite', 'pg'] as const) {
  describe(`server without a host machine (${engine})`, () => {
    let root: string
    let server: ServerHandle
    let daemon: DaemonHandle | undefined
    let pg: Awaited<ReturnType<typeof bunPgTestDatabase>> | undefined
    let token: string
    let workerLocalMachine: string | null | undefined
    let caller: ReturnType<typeof appRouter.createCaller>
    const machineId = asMachineId('remote-daemon')
    const machineToken = 'remote-daemon-test-token'
    const previous = new Map<string, string | undefined>()
    const origin = () => `http://127.0.0.1:${server.port}`
    const launches: string[] = []

    beforeAll(async () => {
      root = mkdtempSync(join(tmpdir(), 'no-host-'))
      for (const key of [
        'PODIUM_STATE_DIR',
        DATABASE_URL_ENV,
        'PODIUM_MODE',
        'PODIUM_UPDATE_FEED_POLLING',
        'PODIUM_DEV_SOURCE_ROOT',
      ])
        previous.set(key, process.env[key])
      process.env.PODIUM_STATE_DIR = root
      process.env.PODIUM_MODE = 'all-in-one'
      process.env.PODIUM_UPDATE_FEED_POLLING = 'off'
      process.env.PODIUM_DEV_SOURCE_ROOT = fileURLToPath(new URL('../../../', import.meta.url))
      if (engine === 'pg') {
        pg = await bunPgTestDatabase()
        process.env[DATABASE_URL_ENV] = pg.url
      } else delete process.env[DATABASE_URL_ENV]
      server = await startServer({
        port: 0,
        hostMachine: false,
        janitorWorkerForTests: async (options) => {
          token = typeof options.token === 'function' ? options.token() : options.token
          workerLocalMachine = options.localMachineId
          return await noJanitorWorkerForTests(options)
        },
      })
      await until(() => token !== undefined)
      const admin = await server.registry.sessionStore.users.earliestAdmin()
      if (!admin) throw new Error('Missing boot administrator')
      const principal = userCommandPrincipal(asUserId(admin.id), 'admin')
      caller = appRouter.createCaller({
        registry: server.registry,
        repos: new RepoRegistry(server.registry.sessionStore),
        superagent: new SuperagentService(server.registry),
        principal,
        capability: principal.capability,
        serverPlacement: { kind: 'external' },
      })
    }, 120_000)

    afterAll(async () => {
      await daemon?.close({ reapSessions: true })
      await server?.close()
      await pg?.drop()
      for (const [key, value] of previous) {
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
      if (root) rmSync(root, { recursive: true, force: true })
    }, 60_000)

    it('boots without a machine identity file or machine row and satisfies the handover gate', async () => {
      const store = server.registry.sessionStore
      expect(store.hostMachine).toBeNull()
      expect(store.database.hostMachine).toBeNull()
      expect(server.registry.modules.machines.hostMachine).toBeNull()
      expect(existsSync(join(root, 'machine.json'))).toBe(false)
      expect(await store.machines.listMachines()).toEqual([])
      expect((await fetch(origin() + '/health')).status).toBe(200)
      expect(await (await fetch(origin() + '/version')).json()).toMatchObject({
        daemonConnected: true,
      })
    })

    it('authenticates the janitor and applies an HTTP maintenance command without a machine row', async () => {
      expect(workerLocalMachine).toBeNull()
      expect(await server.registry.sessionStore.machines.listMachines()).toEqual([])
      const client = createMaintenanceHttpClient(origin(), token)
      const lease = await client.handshake({
        protocolVersion: MAINTENANCE_PROTOCOL_VERSION,
        schemaVersion: MAINTENANCE_SCHEMA_VERSION,
        generationId: 'no-host-janitor',
      })
      expect(lease.status).toBe('ready')
      if (lease.status !== 'ready') throw new Error('Janitor handshake refused')
      const observed = { fromCursor: 0, toEventId: 1 }
      const command = {
        protocolVersion: MAINTENANCE_PROTOCOL_VERSION,
        schemaVersion: MAINTENANCE_SCHEMA_VERSION,
        jobKind: 'steward-poll' as const,
        runKey: stewardPollRunKey(observed),
        fencingToken: lease.fencingToken,
        observed,
      }
      expect(await client.apply(command)).toMatchObject({ status: 'applied' })
      expect(await client.apply(command)).toMatchObject({ status: 'already-applied' })
      expect(
        (
          await fetch(origin() + '/maintenance/handshake', {
            method: 'POST',
            headers: { authorization: `Bearer ${token.slice(1)}` },
            body: '{}',
          })
        ).status,
      ).toBe(401)
    })

    it('connects a separate daemon and starts a real session on it', async () => {
      const store = server.registry.sessionStore
      const admin = await store.users.earliestAdmin()
      await store.machines.upsertMachine({
        id: machineId,
        name: 'Remote daemon',
        hostname: 'remote.example.test',
        tokenHash: sha256(machineToken),
        ownerUserId: admin!.id,
        assignment: { server: false, agentExecution: true },
      })
      const remoteRoot = join(root, 'remote')
      mkdirSync(remoteRoot)
      daemon = await startDaemon({
        serverUrl: `ws://127.0.0.1:${server.port}/daemon`,
        machineId,
        machineToken,
        identityDir: remoteRoot,
        homesDir: join(remoteRoot, 'homes'),
        hooks: { port: 0, settingsDir: join(remoteRoot, 'hooks') },
        agentRelay: { port: 0 },
        discovery: { background: false, cachePath: ':memory:', homeDir: remoteRoot },
        metrics: { background: false },
        backend: 'none',
        durable: directPtyDurableForTests(),
        exitStopsServer: true,
        launch: (_kind, options) => {
          launches.push(options.cwd)
          return shellCommand({
            cmd: process.execPath,
            args: ['-e', 'setInterval(() => {}, 1000)'],
            cwd: options.cwd,
          })
        },
      })
      await until(() => server.registry.modules.machines.hasDaemon(machineId))
      expect(daemon.connected).toBe(true)
      const { sessionId } = await caller.sessions.create({
        agentKind: 'shell',
        machineId,
        cwd: remoteRoot,
      })
      await until(() =>
        server.registry.modules.sessions
          .runningSessionFacts()
          .some((s) => s.sessionId === sessionId && s.status === 'live'),
      )
      expect(launches).toContain(remoteRoot)
      expect(await store.sessions.getSession(sessionId)).toMatchObject({ machineId })
      expect(existsSync(join(root, 'machine.json'))).toBe(false)
      for (const machine of await server.registry.modules.machines.listMachines()) {
        expect(machine.availability?.server).toBe(false)
        expect(machine.serverMoveEligibility?.eligible).toBe(false)
      }
      await server.registry.modules.machines.setMachineBuild(
        machineId,
        { appVersion: 'test', wireSchemaDigest: wireSchemaDigest() },
        [SERVER_MOVE_CAPABILITY],
        new Date().toISOString(),
      )
      expect(
        (await server.registry.modules.machines.recordFacts([machineId]))[0]?.see
          .serverMoveSupported,
      ).toBe(false)
    }, 60_000)

    it('refuses self-update through its existing precondition', async () => {
      await expect(caller.updates.start()).rejects.toMatchObject({
        code: 'PRECONDITION_FAILED',
        message: 'This server cannot run update operations.',
      })
      expect(await caller.setup.channel()).toMatchObject({ updateScope: 'fleet-only' })
    })

    it('refuses development publication through its existing precondition', async () => {
      expect(await caller.updates.proposal()).toBeNull()
      await expect(
        caller.updates.approveProposal({ headSha: 'a'.repeat(40), version: '0.0.1' }),
      ).rejects.toMatchObject({
        code: 'PRECONDITION_FAILED',
        message: 'This server does not publish development releases.',
      })
    })

    it('refuses payload repair without a named machine', async () => {
      await expect(caller.updates.repairPayload()).rejects.toMatchObject({
        code: 'PRECONDITION_FAILED',
        message: 'This server has no host machine to repair. Name a machine to repair its payload.',
      })
    })

    it('refuses server move through its existing precondition', async () => {
      await expect(
        caller.machines.moveServer({
          targetMachineId: machineId,
          publicUrl: 'https://podium.example.test',
          bindHost: '0.0.0.0',
          confirmation: 'TRANSFER SERVER',
        }),
      ).rejects.toMatchObject({
        code: 'PRECONDITION_FAILED',
        message: 'Server move is unavailable on this server: it has no host machine.',
      })
      expect(
        await server.registry.modules.serverTransfer.publicStatus([{ id: machineId }]),
      ).toMatchObject({
        sourceMachineId: null,
        targetEligibility: [{ targetMachineId: machineId, eligible: false, reason: 'unsupported' }],
      })
    })

    it('refuses host enrollment with a typed precondition', async () => {
      const admin = await server.registry.sessionStore.users.earliestAdmin()
      await expect(
        server.registry.modules.machines.completeHostSetup(asUserId(admin!.id), true),
      ).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' })
    })

    it('treats loopback sign-in, HTTPS gates and pairing as remote', async () => {
      const memberOfRequest = createMemberOfRequest({
        identity: server.identity,
        users: server.registry.sessionStore.users,
        trustedProxyHops: 0,
        hostMachine: null,
      })
      const request = new Request(origin() + '/auth/status', {
        headers: { 'x-podium-peer-address': '127.0.0.1' },
      })
      expect(memberOfRequest.factsOf(request).sameMachine).toBe(false)
      expect(await memberOfRequest(request)).toEqual({ kind: 'https_required' })
      expect(await server.identity.signInRequired()).toBe(true)
      expect(await (await fetch(origin() + '/auth/status')).json()).toMatchObject({
        error: 'https_required',
      })
      expect((await fetch(origin() + '/sync/bootstrap')).status).toBe(400)
    })
  })
}
