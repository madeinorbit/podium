import { asMachineId, asUserId, type UserId } from '@podium/model'
import type { PortableCredentialBundle, PortableCredentialKind } from '@podium/protocol'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SessionStore } from '../../store'
import { openTestStore } from '../../test-support/open-test-store'
import { LOGIN_TRANSFER_MAX_AGE_MS, LoginPropagationService } from './login-propagation'

const owner = asUserId('user:owner')
const other = asUserId('user:other')
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

type ExportFn = (
  kinds: PortableCredentialKind[],
  machineId: string,
  options?: { propagation?: boolean; expectedFingerprint?: string },
) => Promise<{ bundles: PortableCredentialBundle[]; unavailable: PortableCredentialKind[] }>
type InstallFn = (
  bundles: PortableCredentialBundle[],
  machineId: string,
  options?: { propagation?: boolean; expectedFingerprint?: string },
) => Promise<{
  installed: PortableCredentialKind[]
  failed: PortableCredentialKind[]
  preserved?: PortableCredentialKind[]
}>

describe('login propagation coordinator', () => {
  let store: SessionStore | undefined

  afterEach(async () => {
    await store?.close()
    store = undefined
  })

  async function machine(id: string, custodian: UserId, login: 'in' | 'out', fp?: string) {
    if (!store) throw new Error('no store')
    await store.machines.upsertMachine({
      id,
      name: id,
      hostname: id,
      tokenHash: `${id}-token`,
      ownerUserId: custodian,
    })
    await store.machines.setMachineInventory(id, JSON.stringify(inventory(login, fp)))
  }

  /** The owner's donor (logged in as `same-account`) and an empty target. */
  async function fleet(): Promise<SessionStore> {
    store = await openTestStore(':memory:')
    await machine('donor', owner, 'in', 'same-account')
    await machine('target', owner, 'out')
    return store
  }

  function service(
    s: SessionStore,
    opts: { export?: ExportFn; install?: InstallFn; now?: () => number; online?: string[] } = {},
  ) {
    const credentialExport = vi.fn<ExportFn>(
      opts.export ?? (async () => ({ bundles: [bundle], unavailable: [] })),
    )
    const credentialInstall = vi.fn<InstallFn>(
      opts.install ?? (async () => ({ installed: ['codex'], failed: [] })),
    )
    const online = new Set(opts.online ?? ['donor', 'target', 'bobs', 'third'])
    const svc = new LoginPropagationService({
      store: s,
      machines: {
        hasDaemon: (machineId) => online.has(machineId),
        capabilityRejection: async () => undefined,
      },
      rpc: { credentialExport, credentialInstall },
      now: opts.now ?? (() => 1_000),
    })
    return { svc, credentialExport, credentialInstall }
  }

  const tick = async (s: SessionStore, enabled = true, fp = 'same-account', who = owner) =>
    await s.accounts.setOptIn(who, 'codex', fp, enabled, new Date(0).toISOString())

  const toTarget = { targetMachineId: asMachineId('target'), agentKind: 'codex' as const }

  it('copies a ticked login from the owner’s machine as that account, and cleans the transfer row', async () => {
    const s = await fleet()
    await tick(s)
    const { svc, credentialExport, credentialInstall } = service(s)

    await expect(svc.propagate({ ...toTarget, principalUserId: owner })).resolves.toEqual({
      status: 'propagated',
      donorMachineId: 'donor',
      fingerprint: 'same-account',
    })

    expect(credentialExport).toHaveBeenCalledWith(['codex'], 'donor', {
      propagation: true,
      expectedFingerprint: 'same-account',
    })
    expect(credentialInstall).toHaveBeenCalledWith([bundle], 'target', {
      propagation: true,
      expectedFingerprint: 'same-account',
    })
    expect(await s.accounts.transfersFor(owner)).toEqual([
      expect.objectContaining({ machineId: 'target', outcome: 'installed' }),
    ])
    expect(
      (await s.secrets.presence()).every((item) => !JSON.stringify(item).includes('secret-')),
    ).toBe(true)
  })

  it('copies nothing that is not ticked, and nothing after it is unticked', async () => {
    const s = await fleet()
    const { svc, credentialExport } = service(s)
    await expect(svc.propagate(toTarget)).resolves.toEqual({
      status: 'skipped',
      reason: 'no login is ticked for use on all your machines',
    })
    await tick(s)
    await tick(s, false)
    await expect(svc.propagate(toTarget)).resolves.toMatchObject({ status: 'skipped' })
    expect(credentialExport).not.toHaveBeenCalled()
  })

  it('never copies to a machine in someone else’s custody, even one the owner may use', async () => {
    const s = await fleet()
    await tick(s)
    await machine('bobs', other, 'out')
    // The owner holds `use` on Bob's machine: a shared machine, not theirs.
    await s.grants.upsert({
      resourceKind: 'machine',
      resourceId: 'bobs',
      grantee: owner,
      verb: 'use',
      owner: other,
      visibility: 'private',
      createdAt: new Date(0).toISOString(),
      actorKind: 'user',
      actorId: other,
      onBehalfOf: other,
    })
    const { svc, credentialExport } = service(s)
    const bobs = { targetMachineId: asMachineId('bobs'), agentKind: 'codex' as const }
    await expect(svc.propagate({ ...bobs, principalUserId: owner })).resolves.toEqual({
      status: 'skipped',
      reason: 'target owner does not match principal',
    })
    // Without a principal the target's custodian is Bob, who ticked nothing.
    await expect(svc.propagate(bobs)).resolves.toMatchObject({ status: 'skipped' })
    expect(credentialExport).not.toHaveBeenCalled()
  })

  it('keeps a different login on the target and reports it, without exporting', async () => {
    const s = await fleet()
    await tick(s)
    await s.machines.setMachineInventory('target', JSON.stringify(inventory('in', 'someone-else')))
    const { svc, credentialExport } = service(s)
    await expect(svc.propagate({ ...toTarget, force: true })).resolves.toEqual({
      status: 'preserved',
      reason: 'the target is signed in to a different account, which was kept',
    })
    expect(credentialExport).not.toHaveBeenCalled()
    expect(await s.accounts.transfersFor(owner)).toEqual([
      expect.objectContaining({ machineId: 'target', outcome: 'preserved' }),
    ])
  })

  it('reports a login the target daemon kept at install time', async () => {
    const s = await fleet()
    await tick(s)
    const { svc } = service(s, {
      install: async () => ({ installed: [], failed: ['codex'], preserved: ['codex'] }),
    })
    await expect(svc.propagate(toTarget)).resolves.toMatchObject({ status: 'preserved' })
    expect(await s.accounts.transfersFor(owner)).toEqual([
      expect.objectContaining({ machineId: 'target', outcome: 'preserved' }),
    ])
  })

  it('refuses a stale transfer: the choice changed after export', async () => {
    const s = await fleet()
    await tick(s)
    const { svc, credentialInstall } = service(s, {
      export: async () => {
        // Unticked and ticked again while the bytes were in flight.
        await tick(s, false)
        await tick(s, true)
        return { bundles: [bundle], unavailable: [] }
      },
    })
    await expect(svc.propagate(toTarget)).resolves.toEqual({
      status: 'skipped',
      reason: 'stale transfer refused: the choice changed',
    })
    expect(credentialInstall).not.toHaveBeenCalled()
  })

  it('refuses a stale transfer: it waited too long', async () => {
    const s = await fleet()
    await tick(s)
    let now = 1_000
    const { svc, credentialInstall } = service(s, {
      now: () => now,
      export: async () => {
        now += LOGIN_TRANSFER_MAX_AGE_MS + 1
        return { bundles: [bundle], unavailable: [] }
      },
    })
    await expect(svc.propagate(toTarget)).resolves.toEqual({
      status: 'skipped',
      reason: 'stale transfer refused: it waited too long',
    })
    expect(credentialInstall).not.toHaveBeenCalled()
  })

  it('refuses a stale transfer: the target changed hands after export', async () => {
    const s = await fleet()
    await tick(s)
    const { svc, credentialInstall } = service(s, {
      export: async () => {
        await s.machines.setMachineOwner('target', other)
        return { bundles: [bundle], unavailable: [] }
      },
    })
    await expect(svc.propagate(toTarget)).resolves.toEqual({
      status: 'skipped',
      reason: 'stale transfer refused: the target owner changed',
    })
    expect(credentialInstall).not.toHaveBeenCalled()
  })

  it('does not choose between several ticked logins that fit', async () => {
    const s = await fleet()
    await machine('third', owner, 'in', 'second-account')
    await tick(s)
    await tick(s, true, 'second-account')
    const { svc, credentialExport } = service(s)
    await expect(svc.propagate(toTarget)).resolves.toMatchObject({
      status: 'skipped',
      reason: 'several ticked logins fit this machine; Podium does not choose between accounts',
    })
    expect(credentialExport).not.toHaveBeenCalled()
  })

  it('does not cross a principal boundary and caps failed retries with backoff', async () => {
    const s = await fleet()
    await tick(s)
    let now = 0
    const { svc, credentialExport } = service(s, {
      now: () => now,
      export: async () => ({ bundles: [], unavailable: ['codex'] }),
    })

    await expect(svc.propagate({ ...toTarget, principalUserId: other })).resolves.toEqual({
      status: 'skipped',
      reason: 'target owner does not match principal',
    })
    expect(credentialExport).not.toHaveBeenCalled()

    await expect(svc.propagate(toTarget)).resolves.toMatchObject({ status: 'failed' })
    expect(await svc.propagate(toTarget)).toEqual({
      status: 'skipped',
      reason: 'propagation backoff active',
    })
    now = 1_000
    await expect(svc.propagate(toTarget)).resolves.toMatchObject({ status: 'failed' })
    now = 3_001
    await expect(svc.propagate(toTarget)).resolves.toMatchObject({ status: 'failed' })
    await expect(svc.propagate(toTarget)).resolves.toEqual({
      status: 'skipped',
      reason: 'propagation attempt cap reached',
    })
    expect(credentialExport).toHaveBeenCalledTimes(3)
  })

  it('finds no donor once the ticked account left every other machine', async () => {
    const s = await fleet()
    await tick(s)
    await s.machines.setMachineInventory('donor', JSON.stringify(inventory('in', 'replaced')))
    const { svc, credentialExport } = service(s)
    await expect(svc.propagate(toTarget)).resolves.toEqual({
      status: 'failed',
      reason: 'no online donor login found',
    })
    expect(credentialExport).not.toHaveBeenCalled()
  })
})
