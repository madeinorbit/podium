/** Real HTTP admin authentication + independent scratch client state. Historical
 * cases execute immutable old state owners, never a relabeled current runtime. */
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { asMachineId, firstAdminMemberId } from '@podium/model'
import { wireSchemaDigest } from '@podium/protocol'
import { createTRPCClient, httpBatchLink } from '@trpc/client'
import { expect, it } from 'vitest'
import { noJanitorWorkerForTests } from '../apps/server/src/janitor-host'
import type { AppRouter } from '../apps/server/src/router'
import { startServer } from '../apps/server/src/server'
import { hashPassword } from '../packages/runtime/src/auth-store'
import { loadConfig, saveConfig } from '../packages/runtime/src/config'
import { readMachineState } from '../packages/runtime/src/local-machine'
import {
  createMachineCredential,
  machinePublicKeyWire,
} from '../packages/runtime/src/machine-credential'
import {
  createMachineSupervisorConnection,
  loadSupervisorState,
  reconcileSupervisorAssignment,
  saveSupervisorState,
} from '../packages/runtime/src/machine-supervisor'
import { applyLocalSetupDefault, consumePairCode } from '../packages/runtime/src/setup'
import { confirmSetupEnrollment } from '../packages/runtime/src/setup-enrollment'

const historical = [
  { version: '0.2.0', root: process.env.PODIUM_LEGACY_020_ROOT },
  { version: '0.3.0', root: process.env.PODIUM_LEGACY_030_ROOT },
]
const digest = (file: string) => createHash('sha256').update(readFileSync(file)).digest('hex')

it('requires actual current administrator HTTP login for revoked recovery, preserving identity and bounded handoff', async () => {
  const root = mkdtempSync(join(tmpdir(), 'podium-existing-recovery-'))
  const previous = process.env.PODIUM_STATE_DIR
  const serverDir = join(root, 'server')
  process.env.PODIUM_STATE_DIR = serverDir
  let server: Awaited<ReturnType<typeof startServer>> | undefined
  let connection: ReturnType<typeof createMachineSupervisorConnection> | undefined
  try {
    applyLocalSetupDefault()
    server = await startServer({ port: 0, janitorWorkerForTests: noJanitorWorkerForTests })
    const actor = await firstAdminMemberId(server.registry.sessionStore)
    await server.registry.sessionStore.users.setPasswordHash(
      actor,
      await hashPassword('scratch-admin-recovery'),
      new Date().toISOString(),
    )
    const setup = loadSupervisorState(serverDir).setupEnrollment!
    confirmSetupEnrollment(setup.requestId, setup.publicKey, serverDir)
    const http = `http://127.0.0.1:${server.port}`
    const serverUrl = `ws://127.0.0.1:${server.port}`
    const api = (cookie = '') =>
      createTRPCClient<AppRouter>({
        links: [httpBatchLink({ url: `${http}/trpc`, headers: { cookie } })],
      })
    const login = await fetch(`${http}/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password: 'scratch-admin-recovery' }),
    })
    expect(login.status).toBe(200)
    const cookie = login.headers.get('set-cookie')!.split(';')[0]!
    const clientDir = join(root, 'client')
    process.env.PODIUM_STATE_DIR = clientDir
    const config = { mode: 'client' as const, serverUrl, updateChannel: 'stable' as const }
    saveConfig(config)
    const state = loadSupervisorState(clientDir)
    state.assignment = reconcileSupervisorAssignment(state, config, clientDir)
    saveSupervisorState(clientDir, state)
    const publicKey = machinePublicKeyWire(createMachineCredential(clientDir))
    const originalKey = digest(join(clientDir, 'machine.key'))
    const request = {
      podiumManaged: true,
      copyAgentCredentials: false,
      clientRegistration: { machineId: state.machineId, publicKey },
    }
    process.env.PODIUM_STATE_DIR = serverDir
    await expect(api().machines.pairingCode.mutate(request)).rejects.toThrow()
    await expect(
      api('podium_session=expired-session').machines.pairingCode.mutate(request),
    ).rejects.toThrow()
    const enrolled = await api(cookie).machines.pairingCode.mutate(request)
    const service = {
      policy: 'disabled' as const,
      state: 'stopped' as const,
      observedAt: new Date().toISOString(),
    }
    const start = (pairCode?: string, onPaired?: () => void) => {
      connection?.close()
      connection = createMachineSupervisorConnection({
        state: loadSupervisorState(clientDir),
        stateDir: clientDir,
        serverUrl,
        ...(pairCode ? { pairCode } : {}),
        onPaired,
        build: { appVersion: 'recovery-test', wireSchemaDigest: wireSchemaDigest() },
        deliveryCaps: [],
        report: () => ({ server: service, agentExecution: service }),
        onGrant: () => {},
      })
      connection.start()
      return connection.waitUntilConnected()
    }
    expect(await start(enrolled.code)).toBe(true)
    await server.registry.modules.machines.revokeMachine(state.machineId)
    expect(await start()).toBe(false)
    expect(loadSupervisorState(clientDir).registration).toMatchObject({
      state: 'rejected',
      recovery: { publicKey },
    })
    const revoked = await server.registry.sessionStore.machines.getMachine(state.machineId)
    await expect(api().machines.pairingCode.mutate(request)).rejects.toThrow()
    await expect(
      api('podium_session=expired-session').machines.pairingCode.mutate(request),
    ).rejects.toThrow()
    expect(await server.registry.sessionStore.machines.getMachine(state.machineId)).toEqual(revoked)
    const recovered = await api(cookie).machines.pairingCode.mutate(request)
    let ack = 0
    expect(await start(recovered.code, () => ack++)).toBe(true)
    expect(ack).toBe(1)
    expect(digest(join(clientDir, 'machine.key'))).toBe(originalKey)
    expect(loadSupervisorState(clientDir)).toMatchObject({
      machineId: state.machineId,
      enrolledPublicKey: publicKey,
      registration: { state: 'enrolled', serverUrl },
      assignment: { server: false, agentExecution: false },
    })
    for (let i = 0; i < 2; i++) expect(await start()).toBe(true)
    expect(
      (await server.registry.sessionStore.machines.getMachine(state.machineId))?.revokedAt,
    ).toBeNull()
    await expect(api(cookie).machines.pairingCode.mutate(request)).rejects.toThrow(
      'already registered',
    )
    // A stale page login claim must fail after the real session is revoked.
    await fetch(`${http}/auth/logout`, { method: 'POST', headers: { cookie } })
    await expect(
      api(cookie).machines.pairingCode.mutate({
        ...request,
        clientRegistration: { machineId: 'other-fresh-client' },
      }),
    ).rejects.toThrow()
  } finally {
    connection?.close()
    await server?.close()
    if (previous === undefined) delete process.env.PODIUM_STATE_DIR
    else process.env.PODIUM_STATE_DIR = previous
    rmSync(root, { recursive: true, force: true })
  }
}, 45_000)

for (const release of historical) {
  it.skipIf(!release.root)(
    `recovers actual ${release.version} source-produced state and repairs lost accepted-key receipts`,
    async () => {
      const root = mkdtempSync(join(tmpdir(), `podium-old-${release.version}-`))
      const serverDir = join(root, 'server')
      const clientDir = join(root, 'client')
      const previous = process.env.PODIUM_STATE_DIR
      process.env.PODIUM_STATE_DIR = serverDir
      let server: Awaited<ReturnType<typeof startServer>> | undefined
      let connection: ReturnType<typeof createMachineSupervisorConnection> | undefined
      try {
        server = await startServer({ port: 0, janitorWorkerForTests: noJanitorWorkerForTests })
        const serverUrl = `ws://127.0.0.1:${server.port}`
        const producer = spawnSync(
          process.env.PODIUM_LEGACY_BUN ?? '/home/mgw/.bun/bin/bun',
          [
            '--conditions=@podium/source',
            resolve('scripts/fixtures/legacy-client-state.ts'),
            release.root!,
            serverUrl,
          ],
          {
            cwd: release.root,
            env: { ...process.env, PODIUM_STATE_DIR: clientDir },
            encoding: 'utf8',
          },
        )
        expect(producer.status, producer.stderr).toBe(0)
        const identity = JSON.parse(producer.stdout.trim()) as {
          machineId: string
          publicKey: string
        }
        const before = readMachineState(clientDir)!
        expect(before.supervisor?.registration).toBeUndefined()
        const keyHash = digest(join(clientDir, 'machine.key'))
        const service = {
          policy: 'disabled' as const,
          state: 'stopped' as const,
          observedAt: new Date().toISOString(),
        }
        const start = (pairCode?: string, ack?: () => void) => {
          connection?.close()
          const state = loadSupervisorState(clientDir)
          const assignment = reconcileSupervisorAssignment(
            state,
            { mode: 'client', serverUrl },
            clientDir,
          )
          expect(assignment).toEqual({ server: false, agentExecution: false })
          connection = createMachineSupervisorConnection({
            state,
            stateDir: clientDir,
            serverUrl,
            pairCode,
            onPaired: ack,
            build: { appVersion: 'current-recovery' },
            deliveryCaps: [],
            report: () => ({ server: service, agentExecution: service }),
            onGrant: () => {},
          })
          connection.start()
          return connection.waitUntilConnected()
        }
        // The real old source leaves this same-coordinator state unresolved.
        expect(await start()).toBe(false)
        expect(loadSupervisorState(clientDir).registration).toMatchObject({
          state: 'rejected',
          recovery: { publicKey: identity.publicKey },
        })
        const code = await server.registry.modules.machines.mintClientRegistrationCode(
          { machineId: asMachineId(identity.machineId), publicKey: identity.publicKey },
          await firstAdminMemberId(server.registry.sessionStore),
        )
        process.env.PODIUM_STATE_DIR = clientDir
        saveConfig({ ...loadConfig(), pairCode: code })
        process.env.PODIUM_STATE_DIR = serverDir
        let acknowledged = 0
        expect(
          await start(code, () => {
            acknowledged++
          }),
        ).toBe(true)
        expect(acknowledged).toBe(1)
        expect(digest(join(clientDir, 'machine.key'))).toBe(keyHash)
        expect(loadSupervisorState(clientDir)).toMatchObject({
          machineId: identity.machineId,
          enrolledPublicKey: identity.publicKey,
          registration: { state: 'enrolled', serverUrl },
        })
        // Simulate receipt interruption at the disk boundary; server already committed.
        // The next signed hello proves the retained key, including when code is stale.
        connection?.close()
        const saved = loadSupervisorState(clientDir)
        delete saved.enrolledPublicKey
        delete saved.registration
        saveSupervisorState(clientDir, saved)
        let lostAck = 0
        expect(
          await start(code, () => {
            lostAck++
            process.env.PODIUM_STATE_DIR = clientDir
            try {
              consumePairCode(code)
            } finally {
              process.env.PODIUM_STATE_DIR = serverDir
            }
          }),
        ).toBe(true)
        expect(lostAck).toBe(1)
        expect(
          JSON.parse(readFileSync(join(clientDir, 'config.json'), 'utf8')).pairCode,
        ).toBeUndefined()
        for (let i = 0; i < 2; i++) expect(await start()).toBe(true)
        expect(digest(join(clientDir, 'machine.key'))).toBe(keyHash)
        expect(readFileSync(join(clientDir, 'retained-user-data'), 'utf8')).toBe(
          'history must survive\n',
        )
        expect(readMachineState(clientDir)?.machineId).toBe(identity.machineId)
        expect(readMachineState(clientDir)?.role).toEqual(before.role)
      } finally {
        connection?.close()
        await server?.close()
        if (previous === undefined) delete process.env.PODIUM_STATE_DIR
        else process.env.PODIUM_STATE_DIR = previous
        rmSync(root, { recursive: true, force: true })
      }
    },
    45_000,
  )
}
