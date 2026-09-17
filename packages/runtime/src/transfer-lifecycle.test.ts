import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { asMachineId } from '@podium/model'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { loadConfig, saveConfig } from './config'
import { loadSupervisorState, saveSupervisorState } from './machine-supervisor'
import type { RunRole } from './run-registry'
import { applySetup } from './setup'
import {
  applySourceDemotion,
  applyTargetServerPromotion,
  establishTargetMachineId,
  finalizeTargetServerPromotion,
  hostConfigBackupPath,
  planRoleTransition,
  promoteTargetServer,
  type RoleSupervisor,
  targetConfigBackupPath,
} from './transfer-lifecycle'

const previousStateDir = process.env.PODIUM_STATE_DIR
const TRANSFER_ONE = '11111111-1111-4111-8111-111111111111'
const TRANSFER_TWO = '22222222-2222-4222-8222-222222222222'

function fakeSupervisor(input: { live?: RunRole[]; managed?: RunRole[]; healthy?: boolean }): {
  supervisor: RoleSupervisor
  live: Set<RunRole>
  managed: Set<RunRole>
  stopped: RunRole[]
  started: RunRole[]
  contexts: Array<{ port: number; serverUrl?: string; bindHost?: '127.0.0.1' | '0.0.0.0' }>
  probedBindHosts: Array<'127.0.0.1' | '0.0.0.0' | undefined>
} {
  const live = new Set(input.live ?? [])
  const managed = new Set(input.managed ?? [])
  const stopped: RunRole[] = []
  const started: RunRole[] = []
  const contexts: Array<{ port: number; serverUrl?: string; bindHost?: '127.0.0.1' | '0.0.0.0' }> =
    []
  const probedBindHosts: Array<'127.0.0.1' | '0.0.0.0' | undefined> = []
  return {
    live,
    managed,
    stopped,
    started,
    contexts,
    probedBindHosts,
    supervisor: {
      roleLive: (role) => live.has(role),
      roleManaged: (role) => managed.has(role),
      async stopRole(role) {
        stopped.push(role)
        live.delete(role)
        managed.delete(role)
      },
      async disarmRole(role) {
        managed.delete(role)
      },
      async startRole(role, context) {
        contexts.push(context)
        started.push(role)
        live.add(role)
      },
      async serverUp(_port, bindHost) {
        probedBindHosts.push(bindHost)
        return input.healthy ?? true
      },
    },
  }
}

describe('server transfer lifecycle', () => {
  let root: string

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'podium-transfer-lifecycle-'))
    process.env.PODIUM_STATE_DIR = root
  })

  afterEach(() => {
    if (previousStateDir === undefined) delete process.env.PODIUM_STATE_DIR
    else process.env.PODIUM_STATE_DIR = previousStateDir
    rmSync(root, { recursive: true, force: true })
  })

  it('moves both cached supervisor roles with the durable source and target config', () => {
    const state = loadSupervisorState(root)
    saveSupervisorState(root, { ...state, assignment: { server: true, agentExecution: false } })
    saveConfig({ mode: 'server', publicUrl: 'https://source.example' })
    applySourceDemotion({ transferId: TRANSFER_ONE, serverUrl: 'https://target.example' })
    expect(loadSupervisorState(root).assignment).toEqual({ server: false, agentExecution: true })
    applyTargetServerPromotion({
      transferId: TRANSFER_TWO,
      publicUrl: 'https://promoted.example',
      bindHost: '0.0.0.0',
    })
    expect(loadSupervisorState(root).assignment).toEqual({ server: true, agentExecution: false })
    expect(loadConfig().serverUrl).toBe('wss://target.example')
    finalizeTargetServerPromotion()
    expect(loadConfig().serverUrl).toBeUndefined()
    expect(loadSupervisorState(root).assignment).toEqual({ server: true, agentExecution: false })
    expect(loadSupervisorState(root).machineId).toBe(state.machineId)
  })

  it('preserves later assignment policy on transfer retries and finalized endpoint cleanup', () => {
    saveConfig({ mode: 'server', publicUrl: 'https://source.example' })
    applySourceDemotion({ transferId: TRANSFER_ONE, serverUrl: 'https://target.example' })
    const state = loadSupervisorState(root)
    const assignment = { server: false, agentExecution: false }
    saveSupervisorState(root, { ...state, assignment })
    applySourceDemotion({ transferId: TRANSFER_ONE, serverUrl: 'https://target.example' })
    expect(loadSupervisorState(root).assignment).toEqual(assignment)
    const promotion = {
      transferId: TRANSFER_TWO,
      publicUrl: 'https://promoted.example',
      bindHost: '0.0.0.0' as const,
    }
    applyTargetServerPromotion(promotion)
    saveSupervisorState(root, { ...state, assignment })
    applyTargetServerPromotion(promotion)
    finalizeTargetServerPromotion()
    finalizeTargetServerPromotion()
    expect(loadConfig().serverUrl).toBeUndefined()
    expect(loadSupervisorState(root).assignment).toEqual(assignment)
  })

  it('durably creates the target machine identity', () => {
    const machineId = asMachineId('target-machine')

    expect(establishTargetMachineId(machineId)).toBe(machineId)
    expect(readFileSync(join(root, 'machine.id'), 'utf8')).toBe(machineId)
    expect(statSync(join(root, 'machine.id')).mode & 0o777).toBe(0o600)
    expect(readdirSync(root).some((name) => name.startsWith('.machine-id-transfer-'))).toBe(false)
  })

  it('accepts an equal target machine identity idempotently', () => {
    const machineId = asMachineId('target-machine')
    writeFileSync(join(root, 'machine.id'), machineId, { mode: 0o600 })

    expect(establishTargetMachineId(machineId)).toBe(machineId)
    expect(readFileSync(join(root, 'machine.id'), 'utf8')).toBe(machineId)
    expect(readdirSync(root).some((name) => name.startsWith('.machine-id-transfer-'))).toBe(false)
  })

  it('refuses to overwrite a conflicting target machine identity', () => {
    writeFileSync(join(root, 'machine.id'), 'other-machine', { mode: 0o600 })

    expect(() => establishTargetMachineId(asMachineId('target-machine'))).toThrow(
      /refusing to replace it with transfer target target-machine/,
    )
    expect(readFileSync(join(root, 'machine.id'), 'utf8')).toBe('other-machine')
  })

  it('durably demotes the source, preserves rollback state, and is idempotent', () => {
    saveConfig({
      mode: 'all-in-one',
      publicUrl: 'https://source.example',
      bindHost: '0.0.0.0',
      pairCode: 'consumed',
      persistence: 'systemd',
      updateChannel: 'edge',
    })
    const before = loadConfig()

    const first = applySourceDemotion({
      transferId: TRANSFER_ONE,
      serverUrl: 'https://target.example',
    })

    expect(first).toMatchObject({
      changed: true,
      serverUrl: 'wss://target.example',
      previousConfig: before,
    })
    expect(first.backupPath).toBe(hostConfigBackupPath(TRANSFER_ONE))
    expect(loadConfig()).toEqual({
      configVersion: before.configVersion,
      mode: 'daemon',
      serverUrl: 'wss://target.example',
      persistence: 'systemd',
      updateChannel: 'edge',
    })
    expect(JSON.parse(readFileSync(join(root, 'daemon.json'), 'utf8'))).toEqual({
      machineId: readFileSync(join(root, 'machine.id'), 'utf8').trim(),
      token: readFileSync(join(root, 'daemon.secret'), 'utf8').trim(),
    })
    expect(JSON.parse(readFileSync(hostConfigBackupPath(TRANSFER_ONE), 'utf8'))).toEqual(before)
    expect(readdirSync(root).some((name) => name.startsWith('.config-transfer-'))).toBe(false)

    const second = applySourceDemotion({
      transferId: TRANSFER_ONE,
      serverUrl: 'wss://target.example',
    })
    expect(second).toMatchObject({
      changed: false,
      backupPath: hostConfigBackupPath(TRANSFER_ONE),
      previousConfig: before,
    })
    expect(() =>
      applySourceDemotion({ transferId: TRANSFER_TWO, serverUrl: 'https://other.example' }),
    ).toThrow(/already a daemon/)
  })

  it('promotes only a paired daemon and preserves target rollback metadata', () => {
    saveConfig({
      mode: 'daemon',
      serverUrl: 'wss://source.example',
      pairCode: 'used',
      persistence: 'detached',
      updateChannel: 'edge',
      port: 19999,
    })
    const before = loadConfig()

    const first = applyTargetServerPromotion({
      transferId: TRANSFER_ONE,
      publicUrl: 'https://target.example/',
      bindHost: '0.0.0.0',
      port: 20001,
    })

    expect(first).toMatchObject({
      changed: true,
      previousConfig: before,
      backupPath: targetConfigBackupPath(TRANSFER_ONE),
    })
    expect(loadConfig()).toEqual({
      configVersion: before.configVersion,
      mode: 'server',
      publicUrl: 'https://target.example',
      bindHost: '0.0.0.0',
      serverUrl: 'wss://source.example',
      persistence: 'detached',
      updateChannel: 'edge',
      port: 20001,
    })
    expect(JSON.parse(readFileSync(targetConfigBackupPath(TRANSFER_ONE), 'utf8'))).toEqual(before)

    const second = applyTargetServerPromotion({
      transferId: TRANSFER_ONE,
      publicUrl: 'https://target.example',
      bindHost: '0.0.0.0',
      port: 20001,
    })
    expect(second).toMatchObject({ changed: false, previousConfig: before })
  })

  it('backs up the original daemon config through the current restartAfterTransfer call path', () => {
    saveConfig({
      mode: 'daemon',
      serverUrl: 'wss://source.example',
      pairCode: 'used',
      persistence: 'systemd',
      updateChannel: 'edge',
      port: 20004,
    })
    const before = loadConfig()

    // Target staging currently records mode/publicUrl before restartAfterTransfer invokes the
    // lifecycle helper. applySetup retains the daemon-only fields, allowing reconstruction.
    applySetup({ mode: 'server', publicUrl: 'https://target.example', bindHost: '0.0.0.0' })
    const result = applyTargetServerPromotion({
      transferId: TRANSFER_ONE,
      publicUrl: 'https://target.example',
      bindHost: '0.0.0.0',
    })

    expect(result).toMatchObject({
      changed: true,
      previousConfig: before,
      backupPath: targetConfigBackupPath(TRANSFER_ONE),
    })
    expect(JSON.parse(readFileSync(targetConfigBackupPath(TRANSFER_ONE), 'utf8'))).toEqual(before)
    expect(loadConfig()).toEqual({
      configVersion: before.configVersion,
      mode: 'server',
      publicUrl: 'https://target.example',
      bindHost: '0.0.0.0',
      serverUrl: 'wss://source.example',
      persistence: 'systemd',
      updateChannel: 'edge',
      port: 20004,
    })
  })

  it('refuses non-daemon targets without changing their config', () => {
    saveConfig({ mode: 'all-in-one', publicUrl: 'https://existing.example' })
    expect(() =>
      applyTargetServerPromotion({
        transferId: TRANSFER_ONE,
        publicUrl: 'https://target.example',
        bindHost: '0.0.0.0',
      }),
    ).toThrow(/paired daemon/)
    expect(loadConfig()).toMatchObject({
      mode: 'all-in-one',
      publicUrl: 'https://existing.example',
    })
    expect(existsSync(targetConfigBackupPath(TRANSFER_ONE))).toBe(false)
  })

  it('stops managed roles that can restart even when they have no live pid', () => {
    expect(
      planRoleTransition({
        mode: 'daemon',
        live: [],
        managed: ['server', 'janitor'],
      }),
    ).toEqual({
      desired: ['parent', 'daemon'],
      toStop: ['server', 'janitor'],
      toStart: ['parent', 'daemon'],
      toDisarm: [],
    })
  })

  it('promotes and proves the target without stopping its in-flight daemon', async () => {
    saveConfig({
      mode: 'daemon',
      serverUrl: 'wss://source.example',
      persistence: 'systemd',
      port: 20002,
    })
    const fixture = fakeSupervisor({
      live: ['daemon'],
      managed: ['daemon'],
      healthy: true,
    })

    const result = await promoteTargetServer(
      {
        transferId: TRANSFER_ONE,
        publicUrl: 'https://target.example',
        bindHost: '0.0.0.0',
        port: 20002,
      },
      fixture.supervisor,
    )

    expect(result.proven).toBe(true)
    // `parent`, not `janitor`: the janitor became a WORKER INSIDE THE SERVER and is
    // no longer a peer role, while a parent now supervises the server and daemon
    // (POD-2505, spec §3). Promotion therefore starts the supervising parent and
    // its server; a janitor here would mean the old three-unit topology came back.
    expect(result.roleTransition).toEqual({
      stopped: [],
      started: ['parent', 'server'],
      disarmed: [],
      serverUp: true,
    })
    expect(fixture.live.has('daemon')).toBe(true)
    expect(fixture.contexts).toEqual([
      { port: 20002, bindHost: '0.0.0.0' },
      { port: 20002, bindHost: '0.0.0.0' },
    ])
    expect(fixture.probedBindHosts).toEqual(['0.0.0.0'])
  })

  it('keeps durable server mode recoverable when health proof fails', async () => {
    saveConfig({ mode: 'daemon', serverUrl: 'wss://source.example', port: 20003 })
    const fixture = fakeSupervisor({ live: ['daemon'], healthy: false })

    const result = await promoteTargetServer(
      {
        transferId: TRANSFER_ONE,
        publicUrl: 'https://target.example',
        bindHost: '127.0.0.1',
        port: 20003,
      },
      fixture.supervisor,
    )

    expect(result.proven).toBe(false)
    expect(fixture.probedBindHosts).toEqual(['127.0.0.1'])
    expect(loadConfig()).toMatchObject({
      mode: 'server',
      publicUrl: 'https://target.example',
      bindHost: '127.0.0.1',
      serverUrl: 'wss://source.example',
    })
    finalizeTargetServerPromotion()
    expect(loadConfig()).not.toHaveProperty('serverUrl')
    expect(result.promotion.previousConfig).toMatchObject({
      mode: 'daemon',
      serverUrl: 'wss://source.example',
    })
  })

  it('keeps source and target rollback backups isolated across two transfers', () => {
    const firstSource = {
      mode: 'server' as const,
      publicUrl: 'https://source-one.example',
      persistence: 'detached' as const,
      port: 21001,
    }
    saveConfig(firstSource)
    applySourceDemotion({ transferId: TRANSFER_ONE, serverUrl: 'https://target-one.example' })

    const secondSource = {
      mode: 'server' as const,
      publicUrl: 'https://source-two.example',
      persistence: 'systemd' as const,
      port: 21002,
    }
    saveConfig(secondSource)
    applySourceDemotion({ transferId: TRANSFER_TWO, serverUrl: 'https://target-two.example' })

    expect(JSON.parse(readFileSync(hostConfigBackupPath(TRANSFER_ONE), 'utf8'))).toMatchObject(
      firstSource,
    )
    expect(JSON.parse(readFileSync(hostConfigBackupPath(TRANSFER_TWO), 'utf8'))).toMatchObject(
      secondSource,
    )

    const firstTarget = {
      mode: 'daemon' as const,
      serverUrl: 'wss://old-one.example',
      persistence: 'detached' as const,
      port: 22001,
    }
    saveConfig(firstTarget)
    applyTargetServerPromotion({
      transferId: TRANSFER_ONE,
      publicUrl: 'https://promoted-one.example',
      bindHost: '0.0.0.0',
    })

    const secondTarget = {
      mode: 'daemon' as const,
      serverUrl: 'wss://old-two.example',
      persistence: 'systemd' as const,
      port: 22002,
    }
    saveConfig(secondTarget)
    applyTargetServerPromotion({
      transferId: TRANSFER_TWO,
      publicUrl: 'https://promoted-two.example',
      bindHost: '127.0.0.1',
    })

    expect(JSON.parse(readFileSync(targetConfigBackupPath(TRANSFER_ONE), 'utf8'))).toMatchObject(
      firstTarget,
    )
    expect(JSON.parse(readFileSync(targetConfigBackupPath(TRANSFER_TWO), 'utf8'))).toMatchObject(
      secondTarget,
    )
  })
})
