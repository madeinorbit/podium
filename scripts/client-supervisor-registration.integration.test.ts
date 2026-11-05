/** Real coordinator + production zero-child parent, supervisor handshake and update executor.
 * The payload adapter is a scratch-file fixture; no provider or host installation is used. */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { asMachineId, firstAdminMemberId } from '@podium/model'
import { wireSchemaDigest } from '@podium/protocol'
import { expect, it, vi } from 'vitest'
import { noJanitorWorkerForTests } from '../apps/server/src/janitor-host'
import { startServer } from '../apps/server/src/server'
import { loadConfig, saveConfig } from '../packages/runtime/src/config'
import { clearConnectivity } from '../packages/runtime/src/connectivity'
import { readMachineState } from '../packages/runtime/src/local-machine'
import {
  machinePublicKeyWire,
  readMachineCredential,
} from '../packages/runtime/src/machine-credential'
import {
  claimSupervisorGeneration,
  createMachineSupervisorConnection,
  loadSupervisorState,
  reconcileSupervisorAssignment,
  saveSupervisorState,
} from '../packages/runtime/src/machine-supervisor'
import { MachineUpdateExecutor } from '../packages/runtime/src/machine-update'
import { ParentProcess } from '../packages/runtime/src/parent-process'
import { machineServiceReport } from '../packages/runtime/src/parent-supervisor'
import { applyLocalSetupDefault, applyMode, consumePairCode } from '../packages/runtime/src/setup'
import { confirmSetupEnrollment } from '../packages/runtime/src/setup-enrollment'

it('pairs the same client identity, persists zero roles, reconnects by machine key and accepts an authorized payload update', async () => {
  const root = mkdtempSync(join(tmpdir(), 'podium-client-registration-'))
  const serverDir = join(root, 'coordinator')
  const clientDir = join(root, 'client')
  const previous = process.env.PODIUM_STATE_DIR
  process.env.PODIUM_STATE_DIR = serverDir
  let server: Awaited<ReturnType<typeof startServer>> | undefined
  let connection: ReturnType<typeof createMachineSupervisorConnection> | undefined
  let parent: ParentProcess | undefined
  try {
    server = await startServer({ port: 0, janitorWorkerForTests: noJanitorWorkerForTests })
    if (previous === undefined) delete process.env.PODIUM_STATE_DIR
    else process.env.PODIUM_STATE_DIR = previous
    const coordinator = server
    const serverUrl = `ws://127.0.0.1:${coordinator.port}`
    // A normal desktop starts locally before either VPS onboarding choice.
    // Use those production setup operations: do not seed registration metadata.
    process.env.PODIUM_STATE_DIR = clientDir
    expect(applyLocalSetupDefault()).toBe('applied')
    const initial = loadSupervisorState(clientDir)
    const setup = initial.setupEnrollment!
    confirmSetupEnrollment(setup.requestId, setup.publicKey, clientDir)
    const local = loadSupervisorState(clientDir)
    local.assignment = reconcileSupervisorAssignment(local, loadConfig(), clientDir)
    saveSupervisorState(clientDir, local)
    const originalKey = readFileSync(join(clientDir, 'machine.key'), 'utf8')
    const config = applyMode({ mode: 'client', serverUrl })
    if (previous === undefined) delete process.env.PODIUM_STATE_DIR
    else process.env.PODIUM_STATE_DIR = previous
    const state = loadSupervisorState(clientDir)
    const originalId = state.machineId
    const assignment = reconcileSupervisorAssignment(state, config, clientDir)
    state.assignment = assignment
    saveSupervisorState(clientDir, state)
    claimSupervisorGeneration(state, clientDir)
    const spawn = vi.fn(() => {
      throw new Error('client must never spawn a child')
    })
    parent = new ParentProcess({
      stateDir: clientDir,
      installDir: join(clientDir, 'install'),
      installBinary: '/unused/podium',
      port: 0,
      children: [],
      env: { PODIUM_APP_VERSION: '1.0.0' },
      spawn,
      notify: () => {},
      exit: () => {},
    })
    await parent.start()
    const activeParent = parent
    const report = () =>
      machineServiceReport({ snap: activeParent.snapshot(), assignment, running: assignment })
    const base = {
      serverUrl,
      stateDir: clientDir,
      build: { appVersion: '1.0.0', wireSchemaDigest: wireSchemaDigest() },
      deliveryCaps: ['update.delivery.feed'],
      report,
      onGrant: () => {},
    }
    // Pre-login boot retains its local key but has no VPS credential or code.
    connection = createMachineSupervisorConnection({ ...base, state })
    connection.start()
    expect(loadSupervisorState(clientDir).registration).toMatchObject({
      serverUrl,
      state: 'unregistered',
    })
    expect(readFileSync(join(clientDir, 'machine.key'), 'utf8')).toBe(originalKey)
    connection.close()

    const pairCode = coordinator.registry.modules.machines.mintPairingCode({
      podiumManaged: true,
      copyAgentCredentials: false,
      ownerUserId: await firstAdminMemberId(coordinator.registry.sessionStore),
    })
    // This in-process fixture has no real process restart to clear the config
    // cache. Use its writer so the guarded production consumer sees this code.
    saveConfig({ ...config, pairCode }, join(clientDir, 'config.json'))
    let paired = 0
    const attached = () =>
      new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          dispose()
          reject(new Error('coordinator did not attach the client'))
        }, 10_000)
        const dispose = coordinator.registry.bus.on('machine.connected', ({ machineId }) => {
          if (machineId !== originalId) return
          clearTimeout(timer)
          dispose()
          resolve()
        })
      })
    const observedPairing = attached()
    const pairingState = loadSupervisorState(clientDir)
    const pairingGeneration = claimSupervisorGeneration(pairingState, clientDir)
    connection = createMachineSupervisorConnection({
      ...base,
      state: pairingState,
      pairCode,
      build: { ...base.build, supervisorGeneration: pairingGeneration },
      onPaired: () => {
        paired++
        // Use the same guarded consumer as the CLI, only after acknowledgement.
        const previousDir = process.env.PODIUM_STATE_DIR
        process.env.PODIUM_STATE_DIR = clientDir
        try {
          consumePairCode(pairCode)
        } finally {
          if (previousDir === undefined) delete process.env.PODIUM_STATE_DIR
          else process.env.PODIUM_STATE_DIR = previousDir
        }
      },
    })
    connection.start()
    expect(await connection.waitUntilConnected()).toBe(true)
    await observedPairing
    const saved = loadSupervisorState(clientDir)
    const publicKey = machinePublicKeyWire(readMachineCredential(clientDir)!)
    expect(readFileSync(join(clientDir, 'machine.key'), 'utf8')).toBe(originalKey)
    expect(saved).toMatchObject({
      machineId: originalId,
      enrolledPublicKey: publicKey,
      assignment: { server: false, agentExecution: false },
      registration: { state: 'enrolled', serverUrl },
    })
    expect(paired).toBe(1)
    expect(
      JSON.parse(readFileSync(join(clientDir, 'config.json'), 'utf8')).pairCode,
    ).toBeUndefined()
    connection.close()

    // The daemon setup path clears only the stopped backend's observation.
    // A registered client's identity and declaration must still own reconnect.
    clearConnectivity(clientDir)
    expect(readMachineState(clientDir)?.connectivity).toBeUndefined()
    expect(loadSupervisorState(clientDir)).toEqual(saved)
    expect(readFileSync(join(clientDir, 'machine.key'), 'utf8')).toBe(originalKey)

    const calls: string[] = []
    const updated = new Promise<void>((resolve, reject) => {
      const executor = new MachineUpdateExecutor({
        runtimeDir: clientDir,
        adapter: {
          runningVersion: () => '1.0.0',
          prepare: async () => {
            calls.push('prepare')
            return { digest: 'scratch-payload' }
          },
          activate: async () => {
            calls.push('activate')
            writeFileSync(join(clientDir, 'payload-version'), '1.0.1')
          },
          discard: async () => {},
          restart: async () => {
            calls.push('restart')
            return 'handover-pending'
          },
        },
        report: (status) => connection?.send(status),
      })
      connection = createMachineSupervisorConnection({
        ...base,
        state: saved,
        build: { ...base.build, supervisorGeneration: claimSupervisorGeneration(saved, clientDir) },
        onGrant: (grant, authority) => {
          void executor.accept(grant, true, false, authority).then(resolve, reject)
        },
      })
    })
    const observedReconnect = attached()
    connection.start()
    expect(await connection.waitUntilConnected()).toBe(true)
    await observedReconnect
    expect(calls).toEqual([])
    coordinator.registry.modules.machines.toMachine(originalId, {
      type: 'updateGrant',
      grantId: 'explicit-client-payload-update',
      issuedAt: Date.now(),
      target: { version: '1.0.1', critical: false, artifacts: {} },
    })
    await updated
    expect(calls).toEqual(['prepare', 'activate', 'restart'])
    expect(readFileSync(join(clientDir, 'payload-version'), 'utf8')).toBe('1.0.1')
    expect(readMachineState(clientDir)?.machineId).toBe(originalId)
    expect(machinePublicKeyWire(readMachineCredential(clientDir)!)).toBe(publicKey)
    expect(parent.snapshot().children).toEqual({
      server: { status: 'stopped' },
      daemon: { status: 'stopped' },
    })
    expect(spawn).not.toHaveBeenCalled()
    const rows = await coordinator.registry.modules.machines.listMachines()
    const clientRows = rows.filter((row) => row.id === originalId)
    expect(clientRows).toHaveLength(1)
    expect(clientRows[0]).toMatchObject({
      serviceAssignment: { server: false, agentExecution: false },
    })
    // The public listing omits the default true policy; verify durable custody.
    expect(
      await coordinator.registry.sessionStore.machines.getMachine(asMachineId(originalId)),
    ).toMatchObject({
      podiumManaged: true,
    })
  } finally {
    connection?.close()
    await parent?.stop()
    await server?.close()
    if (previous === undefined) delete process.env.PODIUM_STATE_DIR
    else process.env.PODIUM_STATE_DIR = previous
    rmSync(root, { recursive: true, force: true })
  }
}, 30_000)
