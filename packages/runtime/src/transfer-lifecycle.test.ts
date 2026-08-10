import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { loadConfig, saveConfig } from './config'
import type { RunRole } from './run-registry'
import { applySetup } from './setup'
import {
  applySourceDemotion,
  applyTargetServerPromotion,
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
} {
  const live = new Set(input.live ?? [])
  const managed = new Set(input.managed ?? [])
  const stopped: RunRole[] = []
  const started: RunRole[] = []
  return {
    live,
    managed,
    stopped,
    started,
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
      async startRole(role) {
        started.push(role)
        live.add(role)
      },
      async serverUp() {
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

  it('durably demotes the source, preserves rollback state, and is idempotent', () => {
    saveConfig({
      mode: 'all-in-one',
      publicUrl: 'https://source.example',
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
      persistence: 'detached',
      updateChannel: 'edge',
      port: 20001,
    })
    expect(JSON.parse(readFileSync(targetConfigBackupPath(TRANSFER_ONE), 'utf8'))).toEqual(before)

    const second = applyTargetServerPromotion({
      transferId: TRANSFER_ONE,
      publicUrl: 'https://target.example',
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
    applySetup({ mode: 'server', publicUrl: 'https://target.example' })
    const result = applyTargetServerPromotion({
      transferId: TRANSFER_ONE,
      publicUrl: 'https://target.example',
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
      desired: ['daemon'],
      toStop: ['server', 'janitor'],
      toStart: ['daemon'],
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
      { transferId: TRANSFER_ONE, publicUrl: 'https://target.example', port: 20002 },
      fixture.supervisor,
    )

    expect(result.proven).toBe(true)
    expect(result.roleTransition).toEqual({
      stopped: [],
      started: ['server', 'janitor'],
      disarmed: ['daemon'],
      serverUp: true,
    })
    expect(fixture.live.has('daemon')).toBe(true)
  })

  it('keeps durable server mode recoverable when health proof fails', async () => {
    saveConfig({ mode: 'daemon', serverUrl: 'wss://source.example', port: 20003 })
    const fixture = fakeSupervisor({ live: ['daemon'], healthy: false })

    const result = await promoteTargetServer(
      { transferId: TRANSFER_ONE, publicUrl: 'https://target.example', port: 20003 },
      fixture.supervisor,
    )

    expect(result.proven).toBe(false)
    expect(loadConfig()).toMatchObject({ mode: 'server', publicUrl: 'https://target.example' })
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
    })

    expect(JSON.parse(readFileSync(targetConfigBackupPath(TRANSFER_ONE), 'utf8'))).toMatchObject(
      firstTarget,
    )
    expect(JSON.parse(readFileSync(targetConfigBackupPath(TRANSFER_TWO), 'utf8'))).toMatchObject(
      secondTarget,
    )
  })
})
