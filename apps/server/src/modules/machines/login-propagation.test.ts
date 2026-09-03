import { asMachineId, asUserId } from '@podium/model'
import type { PortableCredentialBundle, PortableCredentialKind } from '@podium/protocol'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SessionStore } from '../../store'
import { openTestStore } from '../../test-support/open-test-store'
import { LoginPropagationService } from './login-propagation'

const owner = 'user:owner'
const bundle = {
  kind: 'codex' as const,
  contentBase64: Buffer.from(
    JSON.stringify({ tokens: { access_token: 'secret-access', refresh_token: 'secret-refresh' } }),
  ).toString('base64'),
}

function inventory(login: 'in' | 'out', fingerprint?: string) {
  return {
    os: 'linux',
    arch: 'x64',
    podiumVersion: 'test',
    agents: [
      {
        kind: 'codex',
        installed: true,
        login: {
          state: login,
          ...(fingerprint ? { identity: { fingerprint, providerAccountId: 'acct' } } : {}),
        },
      },
    ],
    tools: [],
  }
}

describe('login propagation coordinator', () => {
  let store: SessionStore | undefined

  afterEach(() => {
    store?.close()
    store = undefined
  })

  it('selects the first owned online catalog donor and cleans the server transfer row', async () => {
    store = openTestStore(':memory:')
    store.machines.upsertMachine({
      id: 'donor',
      name: 'donor',
      hostname: 'donor',
      tokenHash: 'donor-token',
      ownerUserId: asUserId(owner),
    })
    store.machines.upsertMachine({
      id: 'target',
      name: 'target',
      hostname: 'target',
      tokenHash: 'target-token',
      ownerUserId: asUserId(owner),
    })
    store.machines.setMachineInventory('donor', JSON.stringify(inventory('in', 'same-account')))
    store.machines.setMachineInventory('target', JSON.stringify(inventory('out')))

    const credentialExport = vi.fn(
      async (
        _kinds: PortableCredentialKind[],
        machineId: string,
        _options?: { propagation?: boolean },
      ) => ({
        bundles: [bundle],
        unavailable: [],
        machineId,
      }),
    )
    const credentialInstall = vi.fn(
      async (
        _bundles: PortableCredentialBundle[],
        _machineId: string,
        _options?: { propagation?: boolean },
      ) => ({
        installed: ['codex' as const],
        failed: [],
      }),
    )
    const service = new LoginPropagationService({
      store,
      machines: {
        hasDaemon: (machineId) => machineId === 'donor' || machineId === 'target',
        capabilityRejection: () => undefined,
      },
      rpc: { credentialExport, credentialInstall },
      now: () => 1_000,
    })

    await expect(
      service.propagate({
        targetMachineId: asMachineId('target'),
        agentKind: 'codex',
        principalUserId: asUserId(owner),
      }),
    ).resolves.toEqual({ status: 'propagated', donorMachineId: 'donor' })

    expect(credentialExport).toHaveBeenCalledWith(['codex'], 'donor', { propagation: true })
    expect(credentialInstall).toHaveBeenCalledWith([bundle], 'target', { propagation: true })
    expect(
      store.secrets.getNativeLoginTransfer(asUserId(owner), 'not-the-transfer'),
    ).toBeUndefined()
    expect(
      store.secrets.presence().every((item) => !JSON.stringify(item).includes('secret-')),
    ).toBe(true)
  })

  it('does not cross a principal boundary and caps failed retries with backoff', async () => {
    store = openTestStore(':memory:')
    store.machines.upsertMachine({
      id: 'donor',
      name: 'donor',
      hostname: 'donor',
      tokenHash: 'donor-token',
      ownerUserId: asUserId(owner),
    })
    store.machines.upsertMachine({
      id: 'target',
      name: 'target',
      hostname: 'target',
      tokenHash: 'target-token',
      ownerUserId: asUserId(owner),
    })
    store.machines.setMachineInventory('donor', JSON.stringify(inventory('in', 'same-account')))
    store.machines.setMachineInventory('target', JSON.stringify(inventory('out')))

    let now = 0
    const credentialExport = vi.fn(async () => ({
      bundles: [],
      unavailable: ['codex' as const],
    }))
    const service = new LoginPropagationService({
      store,
      machines: { hasDaemon: () => true, capabilityRejection: () => undefined },
      rpc: {
        credentialExport,
        credentialInstall: async () => ({ installed: ['codex' as const], failed: [] }),
      },
      now: () => now,
    })

    await expect(
      service.propagate({
        targetMachineId: asMachineId('target'),
        agentKind: 'codex',
        principalUserId: asUserId('user:other'),
      }),
    ).resolves.toEqual({ status: 'skipped', reason: 'target owner does not match principal' })
    expect(credentialExport).not.toHaveBeenCalled()

    const input = { targetMachineId: asMachineId('target'), agentKind: 'codex' as const }
    await expect(service.propagate(input)).resolves.toMatchObject({ status: 'failed' })
    expect(await service.propagate(input)).toEqual({
      status: 'skipped',
      reason: 'propagation backoff active',
    })
    now = 1_000
    await expect(service.propagate(input)).resolves.toMatchObject({ status: 'failed' })
    now = 3_001
    await expect(service.propagate(input)).resolves.toMatchObject({ status: 'failed' })
    await expect(service.propagate(input)).resolves.toEqual({
      status: 'skipped',
      reason: 'propagation attempt cap reached',
    })
    expect(credentialExport).toHaveBeenCalledTimes(3)
  })
})
