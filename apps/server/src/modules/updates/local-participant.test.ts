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
})
