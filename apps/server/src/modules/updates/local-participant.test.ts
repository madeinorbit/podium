import { asMachineId, type MachineId } from '@podium/model'
import type { ControlMessage } from '@podium/protocol/daemon'
import { describe, expect, it, vi } from 'vitest'
import { startLocalUpdateParticipant } from './local-participant'

describe('local update participant', () => {
  it('registers the existing host once and applies its grant through the parent seams', async () => {
    const machineId = asMachineId('host')
    let receive: ((grant: Extract<ControlMessage, { type: 'updateGrant' }>) => void) | undefined
    const setMachineBuild = vi.fn()
    const attachUpdateParticipant = vi.fn(
      (
        _machineId: MachineId,
        send: (grant: Extract<ControlMessage, { type: 'updateGrant' }>) => void,
      ) => {
        receive = send
      },
    )
    const detachUpdateParticipant = vi.fn(() => true)
    const onStatus = vi.fn()
    const installTarget = vi.fn(async () => ({ releaseHadMigrations: true }))
    const writePending = vi.fn()
    const restart = vi.fn()
    const connected = vi.fn()
    const participant = startLocalUpdateParticipant({
      machineId,
      appVersion: '0.4.1',
      runtimeDir: '/unused',
      machines: {
        setMachineBuild,
        attachUpdateParticipant,
        detachUpdateParticipant,
      },
      updates: { onStatus },
      installTarget,
      writePending,
      restart,
      connected,
      now: () => 1_700_000_000_000,
    })

    expect(setMachineBuild).toHaveBeenCalledWith(
      machineId,
      expect.objectContaining({ appVersion: '0.4.1', installKind: 'installed' }),
      ['update.delivery.feed'],
      '2023-11-14T22:13:20.000Z',
    )
    expect(attachUpdateParticipant).toHaveBeenCalledOnce()
    expect(connected).toHaveBeenCalledWith(machineId)

    const grant: Extract<ControlMessage, { type: 'updateGrant' }> = {
      type: 'updateGrant',
      grantId: 'grant-1',
      target: {
        version: '0.4.2',
        critical: false,
        artifacts: {
          headless: {
            delivery: 'feed',
            platforms: {
              'linux-x86_64': {
                url: 'https://updates.test/podium.tgz',
                digest: 'digest',
                signature: 'signature',
              },
            },
          },
        },
      },
    }
    receive?.(grant)

    await vi.waitFor(() => expect(restart).toHaveBeenCalledOnce())
    expect(installTarget).toHaveBeenCalledWith(grant.target)
    expect(writePending).toHaveBeenCalledWith(
      expect.objectContaining({ grantId: 'grant-1', targetVersion: '0.4.2' }),
    )
    expect(restart).toHaveBeenCalledWith('0.4.2', { releaseHadMigrations: true })
    expect(onStatus.mock.calls.map(([, status]) => status.state)).toEqual([
      'downloading',
      'restarting',
    ])

    participant.close()
    expect(detachUpdateParticipant).toHaveBeenCalledWith(machineId, receive)
  })

  /**
   * THE COORDINATOR MUST CONVERGE ON WHAT IS INSTALLED, NOT WHAT IT WAS TOLD IT IS.
   *
   * This is the shape that hid the defect for the whole epic, and the reason the
   * test above could never catch it: there `appVersion` and the target differ, so
   * the comparison lands on the right answer for the wrong reason. On a publishing
   * coordinator `PODIUM_APP_VERSION` carries the version it JUST MINTED, so the
   * participant announced the target as its own current version, `planConvergence`
   * compared two equal strings, returned `already-current`, and `applyGrant`
   * returned before `installTarget`. No swap was ever requested. The fleet then
   * showed the machine converged while its install was untouched — verified on a
   * live sandbox: install `VERSION` still 0.1.1-edge.2, empty `runtime/`, no
   * `.old`, parent PID unchanged since boot.
   *
   * ARMED: point `installedVersion` back at `appVersion` and this fails, because
   * `installTarget` is never reached.
   */
  it('converges when the environment claims the target but the install is behind', async () => {
    const machineId = asMachineId('host')
    let receive: ((grant: Extract<ControlMessage, { type: 'updateGrant' }>) => void) | undefined
    const installTarget = vi.fn(async () => ({ releaseHadMigrations: false }))
    const restart = vi.fn()
    const onStatus = vi.fn()
    const participant = startLocalUpdateParticipant({
      machineId,
      // What the process was launched as — the version this host just published.
      appVersion: '0.4.2',
      // What is actually on disk, and therefore what must decide convergence.
      installedVersion: () => '0.4.1',
      runtimeDir: '/unused',
      machines: {
        setMachineBuild: vi.fn(),
        attachUpdateParticipant: vi.fn(
          (
            _machineId: MachineId,
            send: (grant: Extract<ControlMessage, { type: 'updateGrant' }>) => void,
          ) => {
            receive = send
          },
        ),
        detachUpdateParticipant: vi.fn(() => true),
      },
      updates: { onStatus },
      installTarget,
      writePending: vi.fn(),
      restart,
      now: () => 1_700_000_000_000,
    })

    receive?.({
      type: 'updateGrant',
      grantId: 'grant-2',
      target: {
        version: '0.4.2',
        critical: false,
        artifacts: {
          headless: {
            delivery: 'feed',
            platforms: {
              'linux-x86_64': {
                url: 'https://updates.test/podium.tgz',
                digest: 'digest',
                signature: 'signature',
              },
            },
          },
        },
      },
    })

    await vi.waitFor(() => expect(restart).toHaveBeenCalledOnce())
    expect(installTarget).toHaveBeenCalledOnce()
    // Never reported as already at the target while its install says otherwise.
    expect(onStatus.mock.calls.map(([, status]) => status.state)).not.toContain('current')

    participant.close()
  })
})
