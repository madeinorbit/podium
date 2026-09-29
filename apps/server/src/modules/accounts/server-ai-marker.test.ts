import { asMachineId, Inventory } from '@podium/model'
import { managedAccountId, nativeAccountId, normalizeSettings, resolveRole } from '@podium/runtime'
import { describe, expect, it } from 'vitest'
import type { CodexLoginMachineSource } from '../../codex-machine'
import { assembleCodexServerAiMarker } from './trpc'

function loginListing(id = 'desk'): CodexLoginMachineSource {
  return {
    id: asMachineId(id),
    name: 'Desk',
    revokedAt: null,
    inventory: Inventory.parse({
      os: 'linux',
      arch: 'x64',
      agents: [{ kind: 'codex', installed: true, login: { state: 'in' } }],
    }),
    appVersion: null,
  }
}

const backgroundRole = (accountId: string) =>
  resolveRole(
    normalizeSettings({
      roles: { background: { accountId: accountId as never, model: 'auto', effort: 'auto' } },
    }),
    'background',
  )

const codexRole = () => backgroundRole(nativeAccountId('codex'))
const managedRole = () => backgroundRole(managedAccountId('openrouter'))

describe('assembleCodexServerAiMarker (POD-4805)', () => {
  it('marks the picked machine and carries the background last-error', () => {
    expect(
      assembleCodexServerAiMarker({
        role: codexRole(),
        authorize: () => undefined,
        listings: [loginListing()],
        isOnline: () => true,
        defaultMachineId: asMachineId('desk'),
        lastError: 'codex 400: refused',
      }),
    ).toEqual({
      harness: 'codex',
      machineId: asMachineId('desk'),
      machineName: 'Desk',
      lastError: 'codex 400: refused',
    })
  })

  it('omits lastError when nothing has failed', () => {
    const marker = assembleCodexServerAiMarker({
      role: codexRole(),
      authorize: () => undefined,
      listings: [loginListing()],
      isOnline: () => true,
      defaultMachineId: asMachineId('desk'),
      lastError: undefined,
    })
    expect(marker).toMatchObject({ harness: 'codex', machineName: 'Desk' })
    expect(marker).not.toHaveProperty('lastError')
  })

  it('still reports the last refusal when no login is usable for the viewer', () => {
    expect(
      assembleCodexServerAiMarker({
        role: codexRole(),
        authorize: () => 'you do not have access to use this machine',
        listings: [loginListing()],
        isOnline: () => true,
        defaultMachineId: asMachineId('desk'),
        lastError: 'no connected Codex login is available to you.',
      }),
    ).toEqual({ harness: 'codex', lastError: 'no connected Codex login is available to you.' })
  })

  it('invents no marker when no login is usable and nothing has failed', () => {
    expect(
      assembleCodexServerAiMarker({
        role: codexRole(),
        authorize: () => 'you do not have access to use this machine',
        listings: [loginListing()],
        isOnline: () => true,
        defaultMachineId: asMachineId('desk'),
        lastError: undefined,
      }),
    ).toBeUndefined()
  })

  it('marks nothing for a role that runs on no native login', () => {
    expect(
      assembleCodexServerAiMarker({
        role: managedRole(),
        authorize: () => undefined,
        listings: [loginListing()],
        isOnline: () => true,
        defaultMachineId: asMachineId('desk'),
        lastError: 'codex 400: refused',
      }),
    ).toBeUndefined()
  })
})
