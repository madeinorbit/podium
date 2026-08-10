import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { saveConfig } from '@podium/runtime/config'
import type { RunRole } from '@podium/runtime/run-registry'
import {
  applySourceDemotion,
  type RoleSupervisor,
  runRoleTransition,
} from '@podium/runtime/transfer-lifecycle'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  managedRoleSupervisor,
  prepareForegroundDaemon,
  promoteTargetServerRole,
  retireTargetDaemon,
  roleUnit,
  roleUnitBody,
} from './role-reconcile'

const previousStateDir = process.env.PODIUM_STATE_DIR
const TRANSFER_ID = '11111111-1111-4111-8111-111111111111'

describe('server transfer role reconciliation', () => {
  let root: string

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'podium-role-reconcile-'))
    process.env.PODIUM_STATE_DIR = root
  })

  afterEach(() => {
    if (previousStateDir === undefined) delete process.env.PODIUM_STATE_DIR
    else process.env.PODIUM_STATE_DIR = previousStateDir
    rmSync(root, { recursive: true, force: true })
  })

  it('disables enabled-but-not-live source server roles before starting daemon mode', async () => {
    const enabled = new Set(['podium-server.service', 'podium-janitor.service'])
    const disabled: string[] = []
    const started: RunRole[] = []
    const supervisor = managedRoleSupervisor('systemd', {
      systemdAvailable: () => true,
      unitActive: () => false,
      unitManaged: (unit) => enabled.has(unit),
      disableUnits: (units) => {
        disabled.push(...units)
        for (const unit of units) enabled.delete(unit)
      },
      writeUnit: () => '/fixture/unit',
      enableUnits: () => {},
      spawnRole: (role) => {
        started.push(role)
        return 1
      },
      waitForServer: async () => true,
    })

    const result = await runRoleTransition({
      mode: 'daemon',
      port: 18787,
      supervisor: {
        ...supervisor,
        startRole: async (role, context) => {
          started.push(role)
          await supervisor.startRole(role, context)
        },
      },
    })

    expect(result.stopped).toEqual(['server', 'janitor'])
    expect(disabled).toEqual(['podium-server.service', 'podium-janitor.service'])
    expect(result.started).toEqual(['daemon'])
  })

  it('fails closed when a managed server unit cannot be disabled', async () => {
    const spawnRole = vi.fn()
    const supervisor = managedRoleSupervisor('systemd', {
      systemdAvailable: () => true,
      unitActive: () => false,
      unitManaged: (unit) => unit.endsWith('server.service'),
      disableUnits: () => {
        throw new Error('access denied')
      },
      spawnRole,
      waitForServer: async () => true,
    })

    await expect(runRoleTransition({ mode: 'daemon', port: 18787, supervisor })).rejects.toThrow(
      /access denied/,
    )
    expect(spawnRole).not.toHaveBeenCalled()
  })

  it('does not start a second server when systemd already reports it active', async () => {
    saveConfig({ mode: 'server', publicUrl: 'https://target.example', persistence: 'systemd' })
    const written: RunRole[] = []
    const enabled: string[] = []
    const disarmed: string[] = []
    const outcome = await promoteTargetServerRole(
      { transferId: TRANSFER_ID },
      {
        supervisor: managedRoleSupervisor('systemd', {
          systemdAvailable: () => true,
          unitActive: (unit) => unit.endsWith('server.service') || unit.endsWith('daemon.service'),
          unitManaged: (unit) => unit.endsWith('server.service') || unit.endsWith('daemon.service'),
          writeUnit: (role) => {
            written.push(role)
            return '/fixture/unit'
          },
          enableUnits: (units) => enabled.push(...units),
          disarmUnits: (units) => disarmed.push(...units),
          disableUnits: () => {},
          waitForServer: async () => true,
        }),
      },
    )

    expect(outcome.proven).toBe(true)
    expect(written).toEqual(['janitor'])
    expect(enabled).toEqual(['podium-janitor.service'])
    expect(disarmed).toEqual(['podium-daemon.service'])
    expect(outcome.roleTransition.stopped).toEqual([])
  })

  it('retires stale roles only in the explicit post-response daemon seam', async () => {
    saveConfig({ mode: 'server', publicUrl: 'https://source.example' })
    const present = new Set<RunRole>(['server', 'janitor', 'daemon', 'all-in-one'])
    const stopped: RunRole[] = []
    const supervisor: RoleSupervisor = {
      roleLive: (role) => present.has(role),
      roleManaged: (role) => present.has(role),
      async stopRole(role) {
        stopped.push(role)
        present.delete(role)
      },
      async startRole() {},
      async serverUp() {
        return false
      },
    }

    const demotion = applySourceDemotion({
      transferId: TRANSFER_ID,
      serverUrl: 'https://target.example',
    })
    expect(demotion.changed).toBe(true)
    expect(stopped).toEqual([])
    expect(present).toEqual(new Set(['server', 'janitor', 'daemon', 'all-in-one']))

    await expect(prepareForegroundDaemon({ supervisor })).resolves.toEqual({
      owner: 'foreground',
      stopped: ['server', 'janitor', 'daemon'],
      started: [],
    })
    expect(present.has('all-in-one')).toBe(true)
  })

  it('retires the target daemon only through the explicit acknowledged seam', async () => {
    saveConfig({ mode: 'server', publicUrl: 'https://target.example' })
    const events: string[] = []
    const supervisor: RoleSupervisor = {
      roleLive: () => false,
      async stopRole(role) {
        events.push(`stop:${role}`)
      },
      async startRole() {},
      async serverUp() {
        return true
      },
    }

    await retireTargetDaemon({ supervisor, acknowledged: true })
    expect(events).toEqual(['stop:daemon'])
  })

  it('ignores lifecycle workers after the durable role has changed', async () => {
    const stopRole = vi.fn()
    const supervisor: RoleSupervisor = {
      roleLive: () => true,
      async stopRole(role) {
        stopRole(role)
      },
      async startRole() {},
      async serverUp() {
        return true
      },
    }

    saveConfig({ mode: 'daemon', serverUrl: 'wss://source.example' })
    await retireTargetDaemon({ supervisor, acknowledged: true })
    expect(stopRole).not.toHaveBeenCalled()

    saveConfig({ mode: 'server', publicUrl: 'https://source.example' })
    await expect(prepareForegroundDaemon({ supervisor })).resolves.toEqual({
      owner: 'foreground',
      stopped: [],
      started: [],
    })
    expect(stopRole).not.toHaveBeenCalled()
  })

  it('defers a marked desktop source to its native daemon supervisor', async () => {
    saveConfig({ mode: 'daemon', serverUrl: 'wss://target.example', persistence: 'detached' })
    const stopRole = vi.fn()
    const supervisor: RoleSupervisor = {
      roleLive: () => true,
      stopRole: stopRole,
      async startRole() {},
      async serverUp() {
        return false
      },
    }

    await expect(
      prepareForegroundDaemon({
        supervisor,
        env: { PODIUM_DESKTOP_SUPERVISED: '1' },
      }),
    ).resolves.toEqual({ owner: 'desktop', stopped: [], started: [] })
    expect(stopRole).not.toHaveBeenCalled()
  })

  it('reconciles a systemd source through its daemon unit instead of foreground ownership', async () => {
    saveConfig({ mode: 'daemon', serverUrl: 'wss://target.example', persistence: 'systemd' })
    const present = new Set<RunRole>(['server', 'janitor'])
    const stopped: RunRole[] = []
    const started: RunRole[] = []
    const supervisor: RoleSupervisor & { management: 'systemd' } = {
      management: 'systemd',
      roleLive: (role) => present.has(role),
      roleManaged: (role) => present.has(role),
      async stopRole(role) {
        stopped.push(role)
        present.delete(role)
      },
      async startRole(role) {
        started.push(role)
        present.add(role)
      },
      async serverUp() {
        return false
      },
    }

    await expect(prepareForegroundDaemon({ supervisor, env: {} })).resolves.toEqual({
      owner: 'systemd',
      stopped: ['server', 'janitor'],
      started: ['daemon'],
    })
    expect(stopped).toEqual(['server', 'janitor'])
    expect(started).toEqual(['daemon'])
  })

  it('renders only instance-scoped fixed units', () => {
    expect(roleUnit('server', 'blue')).toBe('podium-blue-server.service')
    expect(roleUnitBody('daemon', { port: 23000 }, 'blue')).toContain(
      'ExecStart=%h/.local/bin/podium-blue daemon',
    )
  })
})
