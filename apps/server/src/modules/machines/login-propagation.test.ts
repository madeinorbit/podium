import { asMachineId, asUserId, type UserId } from '@podium/model'
import type { PortableCredentialBundle, PortableCredentialKind } from '@podium/protocol'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SessionStore } from '../../store'
import { captureLogs } from '../../test-support/capture-logs'
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
    opts: {
      export?: ExportFn
      install?: InstallFn
      now?: () => number
      online?: string[]
      capable?: string[]
      /** Machines the server judged connected over a plain link. */
      plain?: string[]
    } = {},
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
        daemonSupports: (machineId) => (opts.capable ?? [...online]).includes(machineId),
        // As MachinesService.loginLinkUnsafe: offline, or a plain link, is unsafe.
        loginLinkUnsafe: (machineId) =>
          !online.has(machineId)
            ? 'no daemon is connected'
            : (opts.plain ?? []).includes(machineId)
              ? 'its connection is not encrypted'
              : undefined,
      },
      rpc: { credentialExport, credentialInstall },
      now: opts.now ?? (() => 1_000),
    })
    return { svc, credentialExport, credentialInstall }
  }

  const tick = async (s: SessionStore, enabled = true, fp = 'same-account', who = owner) =>
    await s.accounts.setOptIn(who, 'codex', fp, enabled, new Date(0).toISOString())

  const toTarget = { targetMachineId: asMachineId('target'), agentKind: 'codex' as const }

  it('records a propagated-file placement on the credential that names the copied login (Task 13)', async () => {
    const s = await fleet()
    await tick(s)
    const credential = await s.credentials.insert({
      ownerUserId: owner,
      label: 'ChatGPT login',
      type: 'openai.chatgpt-login',
      identity: { fingerprint: 'same-account' },
    })
    const unrelated = await s.credentials.insert({
      ownerUserId: owner,
      label: 'Another login',
      type: 'openai.chatgpt-login',
      identity: { fingerprint: 'another-account' },
    })
    const { svc } = service(s)
    await expect(svc.propagate(toTarget)).resolves.toMatchObject({ status: 'propagated' })
    expect(await s.credentials.listPlacements(credential.id)).toEqual([
      expect.objectContaining({
        machineId: 'target',
        kind: 'propagated-file',
        state: 'present',
      }),
    ])
    expect(await s.credentials.listPlacements(unrelated.id)).toEqual([])
  })

  it('records one propagated-file placement per copy: one per machine, none again for a repeat (Task 9 item 7)', async () => {
    const s = await fleet()
    await machine('third', owner, 'out')
    await tick(s)
    const credential = await s.credentials.insert({
      ownerUserId: owner,
      label: 'ChatGPT login',
      type: 'openai.chatgpt-login',
      identity: { fingerprint: 'same-account' },
    })
    const { svc } = service(s)
    await expect(svc.propagate(toTarget)).resolves.toMatchObject({ status: 'propagated' })
    await expect(
      svc.propagate({ targetMachineId: asMachineId('third'), agentKind: 'codex' }),
    ).resolves.toMatchObject({ status: 'propagated' })
    // The same copy made again is the same placement.
    await s.machines.setMachineInventory('target', JSON.stringify(inventory('out')))
    await svc.propagate({ ...toTarget, force: true })
    const placements = await s.credentials.listPlacements(credential.id)
    expect(placements.map((p) => [p.machineId, p.kind, p.state]).sort()).toEqual([
      ['target', 'propagated-file', 'present'],
      ['third', 'propagated-file', 'present'],
    ])
  })

  it('a propagated login no credential names records no placement', async () => {
    const s = await fleet()
    await tick(s)
    const { svc } = service(s)
    await expect(svc.propagate(toTarget)).resolves.toMatchObject({ status: 'propagated' })
    expect(await s.credentials.listPendingPlacementsOn(asMachineId('target'))).toEqual([])
  })

  it('resumes after upgrading an incapable peer without getting stuck in the retry budget', async () => {
    const s = await fleet()
    await tick(s)
    const capable = ['target']
    const { svc } = service(s, { capable })
    await expect(svc.propagate(toTarget)).resolves.toMatchObject({ status: 'failed' })
    capable.push('donor')
    await expect(svc.propagate(toTarget)).resolves.toMatchObject({ status: 'propagated' })
  })

  it('refuses a target that reconnects as an older peer while export is pending', async () => {
    const s = await fleet()
    await tick(s)
    const capable = ['donor', 'target']
    const { svc, credentialInstall } = service(s, {
      capable,
      export: async () => {
        capable.splice(capable.indexOf('target'), 1)
        return { bundles: [bundle], unavailable: [] }
      },
    })
    await expect(svc.propagate(toTarget)).resolves.toMatchObject({
      status: 'failed',
      reason: expect.stringMatching(/upgrade.*target|target.*upgrade/i),
    })
    expect(credentialInstall).not.toHaveBeenCalled()
  })

  it('refuses an older donor whose login changed after inventory and ignores expectedFingerprint', async () => {
    const s = await fleet()
    await tick(s)
    const wrongBundle = {
      ...bundle,
      contentBase64: Buffer.from('another-account').toString('base64'),
    }
    const { svc, credentialExport, credentialInstall } = service(s, {
      capable: ['target'],
      // An old peer exports the new login despite the stale expected fingerprint.
      export: async () => ({ bundles: [wrongBundle], unavailable: [] }),
    })
    await expect(svc.propagate(toTarget)).resolves.toMatchObject({
      status: 'failed',
      reason: expect.stringMatching(/upgrade.*donor|donor.*upgrade/i),
    })
    expect(credentialExport).not.toHaveBeenCalled()
    expect(credentialInstall).not.toHaveBeenCalled()
  })

  it('refuses an older target that acquired a different expired login after inventory', async () => {
    const s = await fleet()
    await tick(s)
    let login = 'different-expired-account'
    const { svc, credentialInstall } = service(s, {
      capable: ['donor'],
      // Old installers ignore expectedFingerprint and overwrite an expired login.
      install: async () => {
        login = 'same-account'
        return { installed: ['codex'], failed: [] }
      },
    })
    await expect(svc.propagate(toTarget)).resolves.toMatchObject({
      status: 'failed',
      reason: expect.stringMatching(/upgrade.*target|target.*upgrade/i),
    })
    expect(login).toBe('different-expired-account')
    expect(credentialInstall).not.toHaveBeenCalled()
  })

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

  /**
   * A LOGIN FILE CROSSES ONLY A SAFE LINK (credential management §8; POD-6906
   * S2). POD-6906's repro, inverted: a capable donor or target the server judged
   * plain was asked for, or sent, the login file.
   */
  describe('over a plain link', () => {
    it('refuses a plain donor: a log line, no export, no install', async () => {
      const s = await fleet()
      await tick(s)
      const { svc, credentialExport, credentialInstall } = service(s, { plain: ['donor'] })
      const logs = captureLogs()
      try {
        await expect(svc.propagate(toTarget)).resolves.toEqual({
          status: 'skipped',
          reason: 'login not copied over the donor link (donor): its connection is not encrypted',
        })
        expect(logs.at('warn')).toContainEqual(
          expect.objectContaining({
            msg: expect.stringContaining('login propagation refused'),
            role: 'donor',
            machineId: 'donor',
          }),
        )
        expect(logs.text()).not.toContain(bundle.contentBase64)
      } finally {
        logs.restore()
      }
      expect(credentialExport).not.toHaveBeenCalled()
      expect(credentialInstall).not.toHaveBeenCalled()
      expect(await s.accounts.transfersFor(owner)).toEqual([])
    })

    it('refuses a plain target before anything is exported', async () => {
      const s = await fleet()
      await tick(s)
      const { svc, credentialExport, credentialInstall } = service(s, { plain: ['target'] })
      const logs = captureLogs()
      try {
        await expect(svc.propagate(toTarget)).resolves.toMatchObject({
          status: 'skipped',
          reason: expect.stringContaining('target link (target)'),
        })
        expect(logs.at('warn')).toContainEqual(
          expect.objectContaining({ role: 'target', machineId: 'target' }),
        )
      } finally {
        logs.restore()
      }
      expect(credentialExport).not.toHaveBeenCalled()
      expect(credentialInstall).not.toHaveBeenCalled()
    })

    it('refuses a target that reconnects over a plain link while export is pending', async () => {
      const s = await fleet()
      await tick(s)
      const plain: string[] = []
      const { svc, credentialInstall } = service(s, {
        plain,
        export: async () => {
          plain.push('target')
          return { bundles: [bundle], unavailable: [] }
        },
      })
      await expect(svc.propagate(toTarget)).resolves.toMatchObject({
        status: 'skipped',
        reason: expect.stringContaining('not encrypted'),
      })
      expect(credentialInstall).not.toHaveBeenCalled()
      // The exported bytes did not outlive the refusal on the server.
      expect(
        (await s.secrets.presence()).every((item) => !JSON.stringify(item).includes('secret-')),
      ).toBe(true)
    })

    it('copies from a donor on a safe link when another holder of the login is plain', async () => {
      const s = await fleet()
      await machine('third', owner, 'in', 'same-account')
      await tick(s)
      for (const plain of [['donor'], ['third']]) {
        const { svc, credentialExport } = service(s, { plain })
        const safe = plain[0] === 'donor' ? 'third' : 'donor'
        await expect(svc.propagate(toTarget)).resolves.toMatchObject({
          status: 'propagated',
          donorMachineId: safe,
        })
        expect(credentialExport).toHaveBeenCalledWith(['codex'], safe, expect.anything())
      }
    })
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
