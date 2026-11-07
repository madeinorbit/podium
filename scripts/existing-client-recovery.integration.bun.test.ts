/** Real HTTP admin authentication + independent scratch client state. Historical
 * cases execute immutable old state owners, never a relabeled current runtime. */

import { expect, it, spyOn } from 'bun:test'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { asMachineId, firstAdminMemberId } from '@podium/model'
import type { MachineSupervisorControlMessage } from '@podium/protocol'
import { wireSchemaDigest } from '@podium/protocol'
import { createTRPCClient, httpBatchLink } from '@trpc/client'
import { PAIR_CODE_TTL_MS, PairingManager } from '../apps/server/src/hub/pairing'
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
  claimSupervisorGeneration,
  createMachineSupervisorConnection,
  loadSupervisorState,
  reconcileSupervisorAssignment,
  saveSupervisorState,
} from '../packages/runtime/src/machine-supervisor'
import type { MachineUpdateAuthority } from '../packages/runtime/src/machine-update'
import { MachineUpdateExecutor } from '../packages/runtime/src/machine-update'
import { applyLocalSetupDefault, consumePairCode } from '../packages/runtime/src/setup'
import { confirmSetupEnrollment } from '../packages/runtime/src/setup-enrollment'

const historical = [
  {
    version: '0.2.0',
    root: process.env.PODIUM_LEGACY_020_ROOT,
    bun: process.env.PODIUM_LEGACY_020_BUN ?? process.env.PODIUM_LEGACY_BUN ?? 'bun',
  },
  {
    version: '0.3.0',
    root: process.env.PODIUM_LEGACY_030_ROOT,
    bun: process.env.PODIUM_LEGACY_030_BUN ?? 'bun',
  },
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
    const signIn = () =>
      fetch(`${http}/auth/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ password: 'scratch-admin-recovery' }),
      })
    const login = await signIn()
    expect(login.status).toBe(200)
    let cookie = login.headers.get('set-cookie')!.split(';')[0]!
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
    let onGrant: (
      grant: Extract<MachineSupervisorControlMessage, { type: 'updateGrant' }>,
      authority: MachineUpdateAuthority,
    ) => void = () => {}
    const start = async (pairCode?: string, onPaired?: () => void) => {
      connection?.close()
      const current = loadSupervisorState(clientDir)
      let attached!: () => void
      const observed = new Promise<void>((resolveAttached) => {
        attached = resolveAttached
      })
      const dispose = server!.registry.bus.on('machine.connected', (event) => {
        if (event.machineId === current.machineId) attached()
      })
      connection = createMachineSupervisorConnection({
        state: current,
        stateDir: clientDir,
        serverUrl,
        ...(pairCode ? { pairCode } : {}),
        onPaired,
        build: {
          appVersion: '0.3.0',
          wireSchemaDigest: wireSchemaDigest(),
          supervisorGeneration: claimSupervisorGeneration(current, clientDir),
        },
        deliveryCaps: ['update.delivery.feed'],
        report: () => ({ server: service, agentExecution: service }),
        onGrant: (grant, authority) => onGrant(grant, authority),
      })
      connection.start()
      try {
        const accepted = await connection.waitUntilConnected()
        if (accepted)
          await Promise.race([
            observed,
            Bun.sleep(5_000).then(() => {
              throw new Error('coordinator attachment timed out')
            }),
          ])
        return accepted
      } finally {
        dispose()
      }
    }
    expect(await start(enrolled.code)).toBe(true)
    await server.registry.modules.machines.revokeMachine(asMachineId(state.machineId))
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
    const expired = await api(cookie).machines.pairingCode.mutate(request)
    process.env.PODIUM_STATE_DIR = clientDir
    saveConfig({ ...loadConfig(), pairCode: expired.code })
    process.env.PODIUM_STATE_DIR = serverDir
    // Advance only the existing pairing manager's clock at consumption. The
    // admin HTTP request and durable saved authority are real; no session,
    // challenge, machine-state or product clock is replaced.
    const afterSleep = Date.now() + PAIR_CODE_TTL_MS + 1
    const peek = PairingManager.prototype.peek
    const redeem = PairingManager.prototype.redeem
    const peekClock = spyOn(PairingManager.prototype, 'peek').mockImplementation(function (
      this: PairingManager,
      code: string,
    ) {
      return peek.call(this, code, afterSleep)
    })
    const redeemClock = spyOn(PairingManager.prototype, 'redeem').mockImplementation(function (
      this: PairingManager,
      code: string,
    ) {
      return redeem.call(this, code, afterSleep)
    })
    try {
      expect(await start(expired.code)).toBe(false)
    } finally {
      peekClock.mockRestore()
      redeemClock.mockRestore()
    }
    for (let boot = 0; boot < 3; boot++) {
      expect(loadSupervisorState(clientDir).registration).toMatchObject({
        state: 'rejected',
        pendingPairCode: expired.code,
        recovery: { publicKey, pairCode: expired.code },
      })
      expect(await start(expired.code)).toBe(false)
    }
    expect(JSON.parse(readFileSync(join(clientDir, 'config.json'), 'utf8')).pairCode).toBe(
      expired.code,
    )
    expect(await server.registry.sessionStore.machines.getMachine(state.machineId)).toEqual(revoked)
    await fetch(`${http}/auth/logout`, { method: 'POST', headers: { cookie } })
    await expect(api(cookie).machines.pairingCode.mutate(request)).rejects.toThrow()
    await expect(api().machines.pairingCode.mutate(request)).rejects.toThrow()
    await expect(
      api('podium_session=expired-session').machines.pairingCode.mutate(request),
    ).rejects.toThrow()
    const relogin = await signIn()
    expect(relogin.status).toBe(200)
    cookie = relogin.headers.get('set-cookie')!.split(';')[0]!
    const recovered = await api(cookie).machines.pairingCode.mutate(request)
    process.env.PODIUM_STATE_DIR = clientDir
    saveConfig({ ...loadConfig(), pairCode: recovered.code })
    process.env.PODIUM_STATE_DIR = serverDir
    let ack = 0
    expect(
      await start(recovered.code, () => {
        ack++
        process.env.PODIUM_STATE_DIR = clientDir
        try {
          consumePairCode(recovered.code)
        } finally {
          process.env.PODIUM_STATE_DIR = serverDir
        }
      }),
    ).toBe(true)
    expect(ack).toBe(1)
    expect(
      JSON.parse(readFileSync(join(clientDir, 'config.json'), 'utf8')).pairCode,
    ).toBeUndefined()
    expect(digest(join(clientDir, 'machine.key'))).toBe(originalKey)
    expect(loadSupervisorState(clientDir)).toMatchObject({
      machineId: state.machineId,
      enrolledPublicKey: publicKey,
      registration: { state: 'enrolled', serverUrl },
      assignment: { server: false, agentExecution: false },
    })
    expect(
      (await server.registry.sessionStore.machines.getMachine(state.machineId))?.revokedAt,
    ).toBeNull()
    // Recovery keeps the normal machine-plane update authority usable. The
    // payload adapter writes only this test's scratch file; delivery is separate.
    const updateCalls: string[] = []
    let settled!: () => void
    let failUpdate!: (error: unknown) => void
    const updated = new Promise<void>((resolveUpdate, reject) => {
      settled = resolveUpdate
      failUpdate = reject
    })
    const executor = new MachineUpdateExecutor({
      runtimeDir: clientDir,
      adapter: {
        runningVersion: () => '0.3.0',
        prepare: async () => {
          updateCalls.push('prepare')
          return { digest: 'scratch-recovery-payload' }
        },
        activate: async () => {
          updateCalls.push('activate')
          writeFileSync(join(clientDir, 'payload-version'), '0.3.1')
        },
        discard: async () => {},
        restart: async () => {
          updateCalls.push('restart')
          return 'handover-pending'
        },
      },
      report: (status) => connection?.send(status),
    })
    onGrant = (grant, authority) => {
      void executor.accept(grant, true, false, authority).then(settled, failUpdate)
    }
    expect(await start()).toBe(true)
    server.registry.modules.machines.toMachine(state.machineId, {
      type: 'updateGrant',
      grantId: 'authorized-after-recovery',
      issuedAt: Date.now(),
      target: { version: '0.3.1', critical: false, artifacts: {} },
    })
    await Promise.race([
      updated,
      Bun.sleep(5_000).then(() => {
        throw new Error(`update grant did not finish: ${JSON.stringify(updateCalls)}`)
      }),
    ])
    expect(updateCalls).toEqual(['prepare', 'activate', 'restart'])
    expect(readFileSync(join(clientDir, 'payload-version'), 'utf8')).toBe('0.3.1')
    expect(digest(join(clientDir, 'machine.key'))).toBe(originalKey)
    for (let i = 0; i < 2; i++) expect(await start()).toBe(true)
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
        for (const [file, expected] of Object.entries({
          'machine-supervisor.ts': '5107c491520ebd26513399e8dc148407193b6b94',
          'local-machine.ts': '3fa32727e1742e000872b1aeca906073f38591b3',
          'machine-credential.ts': '8a7b98d925d264126316ba8f858624e6e20c8975',
          'setup.ts': 'c665829e200e2644956f2ac1748e31049df5af08',
          'setup-enrollment.ts': '63eec01aa7ad3a5a6ca2269ab05a606886c5d7bd',
        })) {
          const bytes = readFileSync(join(release.root!, 'packages/runtime/src', file))
          expect(
            createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex'),
          ).toBe(expected)
        }
        const produce = async (dir: string, code = '', behavior = '') => {
          const producer = await new Promise<{
            status: number | null
            stdout: string
            stderr: string
          }>((resolveResult) => {
            const child = spawn(
              release.bun,
              [
                '--conditions=@podium/source',
                resolve('scripts/fixtures/legacy-client-state.ts'),
                release.root!,
                serverUrl,
                code,
                behavior,
              ],
              {
                cwd: release.root,
                env: { ...process.env, PODIUM_STATE_DIR: dir },
                stdio: ['ignore', 'pipe', 'pipe'],
              },
            )
            let stdout = '',
              stderr = ''
            child.stdout.on('data', (chunk) => {
              stdout += chunk
            })
            child.stderr.on('data', (chunk) => {
              stderr += chunk
            })
            child.on('exit', (status) => resolveResult({ status, stdout, stderr }))
          })
          expect(producer.status, producer.stderr).toBe(0)
          return JSON.parse(producer.stdout.trim().split('\n').at(-1)!) as {
            machineId: string
            publicKey: string
            pendingPublicKey?: string
            acceptedReceipt: boolean
            droppedAcknowledgement: boolean
          }
        }
        const identity = await produce(clientDir)
        const before = readMachineState(clientDir)!
        expect(before.supervisor?.registration).toBeUndefined()
        const keyHash = digest(join(clientDir, 'machine.key'))
        const service = {
          policy: 'disabled' as const,
          state: 'stopped' as const,
          observedAt: new Date().toISOString(),
        }
        const start = (pairCode?: string, ack?: () => void, selectedDir = clientDir) => {
          connection?.close()
          const state = loadSupervisorState(selectedDir)
          const assignment = reconcileSupervisorAssignment(
            state,
            { mode: 'client', serverUrl },
            selectedDir,
          )
          expect(assignment).toEqual({ server: false, agentExecution: false })
          connection = createMachineSupervisorConnection({
            state,
            stateDir: selectedDir,
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
        expect(readMachineState(clientDir)?.machineId).toBe(asMachineId(identity.machineId))
        expect(readMachineState(clientDir)?.role).toEqual(before.role)
        for (const behavior of ['retain-code', 'lose-ack', 'lose-ack-newer', 'pending-rotation']) {
          const oldDir = join(root, behavior)
          const oldCode = server.registry.modules.machines.mintPairingCode({
            ownerUserId: await firstAdminMemberId(server.registry.sessionStore),
            podiumManaged: false,
          })
          const oldIdentity = await produce(oldDir, oldCode, behavior)
          expect(oldIdentity.droppedAcknowledgement).toBe(behavior.startsWith('lose-ack'))
          expect(oldIdentity.acceptedReceipt).toBe(!behavior.startsWith('lose-ack'))
          const oldKey = digest(join(oldDir, 'machine.key'))
          const oldRow = await server.registry.sessionStore.machines.getMachine(
            oldIdentity.machineId,
          )
          expect(oldRow).toMatchObject({ podiumManaged: false, revokedAt: null })
          let oldAck = 0
          expect(
            await start(
              behavior === 'pending-rotation' ? undefined : oldCode,
              () => {
                oldAck++
                // A newer replacement code must survive the stale ACK's consumer.
                process.env.PODIUM_STATE_DIR = oldDir
                try {
                  if (behavior === 'lose-ack-newer')
                    saveConfig({ ...loadConfig(), pairCode: 'NEWER-CODE' })
                  consumePairCode(oldCode)
                } finally {
                  process.env.PODIUM_STATE_DIR = serverDir
                }
              },
              oldDir,
            ),
          ).toBe(true)
          expect(oldAck).toBe(behavior === 'pending-rotation' ? 0 : 1)
          if (behavior !== 'pending-rotation')
            expect(digest(join(oldDir, 'machine.key'))).toBe(oldKey)
          if (behavior !== 'pending-rotation')
            expect(JSON.parse(readFileSync(join(oldDir, 'config.json'), 'utf8')).pairCode).toBe(
              behavior === 'lose-ack-newer' ? 'NEWER-CODE' : undefined,
            )
          expect(loadSupervisorState(oldDir)).toMatchObject({
            machineId: oldIdentity.machineId,
            enrolledPublicKey: oldIdentity.pendingPublicKey ?? oldIdentity.publicKey,
            registration: { state: 'enrolled', serverUrl },
            assignment: { server: false, agentExecution: false },
          })
          expect(
            (await server.registry.sessionStore.machines.getMachine(oldIdentity.machineId))
              ?.createdAt,
          ).toBe(oldRow?.createdAt)
          expect(
            (await server.registry.sessionStore.machines.getMachine(oldIdentity.machineId))
              ?.podiumManaged,
          ).toBe(false)
        }
      } finally {
        connection?.close()
        await server?.close()
        if (previous === undefined) delete process.env.PODIUM_STATE_DIR
        else process.env.PODIUM_STATE_DIR = previous
        rmSync(root, { recursive: true, force: true })
      }
    },
    60_000,
  )
}
