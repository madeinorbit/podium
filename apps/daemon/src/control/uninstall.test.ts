import type { UninstallEditOutcome } from '@podium/protocol'
import { describe, expect, it } from 'vitest'
import {
  handleMachineUninstall,
  type MachineUninstallDeps,
  podiumCommand,
  type UninstallLaunch,
} from './uninstall'

function deps(
  over: Partial<MachineUninstallDeps> = {},
  outcomes: UninstallEditOutcome[] = [],
): MachineUninstallDeps & { launches: Array<{ launch: UninstallLaunch; args: string[] }> } {
  const launches: Array<{ launch: UninstallLaunch; args: string[] }> = []
  return {
    launches,
    env: { PODIUM_INSTANCE: 'lab', PODIUM_UNDER_PARENT: '1', XDG_STATE_HOME: '/s' },
    mode: () => 'daemon',
    undoAll: async () => outcomes,
    launch: (launch, args) => {
      launches.push({ launch, args })
    },
    command: () => ['/opt/podium/podium'],
    ...over,
  }
}

const request = (force?: boolean) =>
  ({
    type: 'machineUninstallRequest',
    requestId: 'r1',
    ...(force === undefined ? {} : { force }),
  }) as const

describe('handleMachineUninstall', () => {
  it('undoes the edits, starts the removal with the instance env, and answers each outcome', async () => {
    const outcomes: UninstallEditOutcome[] = [
      { harness: 'claude', file: '/home/me/.claude.json', status: 'restored' },
    ]
    const d = deps({}, outcomes)
    expect(await handleMachineUninstall(request(), d)).toEqual({
      type: 'machineUninstallResult',
      requestId: 'r1',
      ok: true,
      outcomes,
      removesState: true,
    })
    // Only the folder-locating variables travel; the parent's markers do not.
    expect(d.launches).toEqual([
      {
        launch: {
          command: ['/opt/podium/podium'],
          env: { PODIUM_INSTANCE: 'lab', XDG_STATE_HOME: '/s' },
        },
        args: ['--yes'],
      },
    ])
  })

  it('says the files stay when an edit was not undone, unless forced', async () => {
    const outcomes: UninstallEditOutcome[] = [
      { harness: 'codex', file: '/c', status: 'changed', reason: 'changed since' },
    ]
    expect((await handleMachineUninstall(request(), deps({}, outcomes))).removesState).toBe(false)
    const forced = deps({}, outcomes)
    expect((await handleMachineUninstall(request(true), forced)).removesState).toBe(true)
    expect(forced.launches[0]?.args).toEqual(['--yes', '--force'])
  })

  it('refuses a machine the desktop app supervises or that runs the server, before undoing', async () => {
    let undone = false
    const undoAll = async () => {
      undone = true
      return []
    }
    const desktop = await handleMachineUninstall(
      request(),
      deps({ env: { PODIUM_DESKTOP_SUPERVISED: '1' }, undoAll }),
    )
    expect(desktop).toMatchObject({ ok: false, error: expect.stringContaining('desktop app') })
    const server = await handleMachineUninstall(
      request(),
      deps({ mode: () => 'all-in-one', undoAll }),
    )
    expect(server).toMatchObject({ ok: false, error: expect.stringContaining('runs the server') })
    expect(undone).toBe(false)
  })

  it('starts nothing when the record of edits cannot be read', async () => {
    const d = deps({
      undoAll: async () => {
        throw new Error('ledger is newer')
      },
    })
    expect(await handleMachineUninstall(request(), d)).toMatchObject({
      ok: false,
      error: expect.stringContaining('ledger is newer'),
    })
    expect(d.launches).toEqual([])
  })

  it('reports the outcomes and the failure when the removal cannot start', async () => {
    const outcomes: UninstallEditOutcome[] = [{ harness: 'claude', file: '/a', status: 'restored' }]
    const d = deps(
      {
        launch: () => {
          throw new Error('no user bus')
        },
      },
      outcomes,
    )
    expect(await handleMachineUninstall(request(), d)).toMatchObject({
      ok: false,
      outcomes,
      error: expect.stringContaining('no user bus'),
    })
  })
})

describe('podiumCommand', () => {
  it('is the binary itself when compiled, and the source entry through Bun otherwise', () => {
    expect(podiumCommand('/opt/podium/podium', 'file:///$bunfs/root/daemon.js')).toEqual([
      '/opt/podium/podium',
    ])
    const source = podiumCommand(
      '/usr/bin/bun',
      'file:///repo/apps/daemon/src/control/uninstall.ts',
    )
    expect(source).toEqual(['/usr/bin/bun', '--conditions=@podium/source', '/repo/scripts/cli.ts'])
  })
})
