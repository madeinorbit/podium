import { asMachineId, asUserId } from '@podium/model'
import { afterEach, describe, expect, it } from 'vitest'
import type { SessionStore } from '../store'
import { openTestStore } from '../test-support/open-test-store'
import type { SealedSecret } from './credentials'

const OWNER = asUserId('user:owner')
const OTHER = asUserId('user:other')
const MACHINE = asMachineId('machine-1')

const sealed = (marker: string): SealedSecret => ({
  ciphertext: Buffer.from(`ciphertext-${marker}`),
  nonce: Buffer.alloc(12, 1),
  keyId: 'dk_test',
})

describe('CredentialsRepository', () => {
  let store: SessionStore | undefined

  afterEach(async () => {
    await store?.close()
    store = undefined
  })

  async function open(): Promise<SessionStore> {
    store = await openTestStore(':memory:')
    return store
  }

  it('inserts, reads, lists, renames and sets the status of a credential', async () => {
    const s = await open()
    const added = await s.credentials.insert({
      ownerUserId: OWNER,
      label: 'Work key',
      type: 'anthropic.api-key',
      identity: { fingerprint: 'fp-1', email: 'someone@example.invalid' },
    })
    expect(added.id).toMatch(/^cred_[0-9a-f-]{36}$/)
    expect(added).toMatchObject({ status: 'ok', label: 'Work key', ownerUserId: OWNER })

    await s.credentials.insert({ ownerUserId: OTHER, label: 'Not mine', type: 'openai.api-key' })
    expect((await s.credentials.listVisibleTo(OWNER)).map((c) => c.id)).toEqual([added.id])

    await s.credentials.rename(added.id, 'Renamed')
    await s.credentials.setStatus(added.id, 'attention', 'expired')
    expect(await s.credentials.get(added.id)).toMatchObject({
      label: 'Renamed',
      status: 'attention',
      statusReason: 'expired',
      identity: { fingerprint: 'fp-1', email: 'someone@example.invalid' },
    })
  })

  it('finds a credential by its legacy id and by its identity', async () => {
    const s = await open()
    const legacy = await s.credentials.insert({
      ownerUserId: OWNER,
      label: 'Old key',
      type: 'anthropic.api-key',
      legacyId: 'managed:anthropic@user:owner',
    })
    const login = await s.credentials.insert({
      ownerUserId: OWNER,
      label: 'Claude',
      type: 'anthropic.claude-login',
      identity: { fingerprint: 'fp-claude' },
    })
    expect((await s.credentials.findByLegacyId('managed:anthropic@user:owner'))?.id).toBe(legacy.id)
    expect(await s.credentials.findByLegacyId('managed:openai@user:owner')).toBeUndefined()
    const keyed = await s.credentials.insert({
      ownerUserId: OWNER,
      label: 'Keyed',
      type: 'openai.api-key',
      legacyId: 'managed:openai@user:owner',
      legacyKey: 'managed:openai',
    })
    expect((await s.credentials.findByLegacyKey(OWNER, 'managed:openai'))?.id).toBe(keyed.id)
    expect(await s.credentials.findByLegacyKey(OTHER, 'managed:openai')).toBeUndefined()
    await expect(
      s.credentials.insert({
        ownerUserId: OWNER,
        label: 'Same key twice',
        type: 'openai.api-key',
        legacyKey: 'managed:openai',
      }),
    ).rejects.toThrow()
    expect(
      (
        await s.credentials.findByIdentity({
          ownerUserId: OWNER,
          type: 'anthropic.claude-login',
          fingerprint: 'fp-claude',
        })
      )?.id,
    ).toBe(login.id)
    expect(
      await s.credentials.findByIdentity({
        ownerUserId: OTHER,
        type: 'anthropic.claude-login',
        fingerprint: 'fp-claude',
      }),
    ).toBeUndefined()
  })

  it('stores secret versions and returns the newest', async () => {
    const s = await open()
    const c = await s.credentials.insert({ ownerUserId: OWNER, label: 'k', type: 'openai.api-key' })
    expect(await s.credentials.latestSecret(c.id)).toBeNull()
    expect(await s.credentials.putSecret(c.id, sealed('v1'), 0)).toBe(1)
    expect(await s.credentials.putSecret(c.id, sealed('v2'), 1)).toBe(2)
    const latest = await s.credentials.latestSecret(c.id)
    expect(latest?.version).toBe(2)
    expect(latest?.sealed.ciphertext.toString()).toBe('ciphertext-v2')
    expect(latest?.sealed.nonce).toEqual(Buffer.alloc(12, 1))
    expect(latest?.sealed.keyId).toBe('dk_test')
  })

  it('refuses a stale expectedVersion with conflict and keeps the stored secret', async () => {
    const s = await open()
    const c = await s.credentials.insert({ ownerUserId: OWNER, label: 'k', type: 'openai.api-key' })
    expect(await s.credentials.putSecret(c.id, sealed('first'), 0)).toBe(1)

    expect(await s.credentials.putSecret(c.id, sealed('stale'), 0)).toBe('conflict')
    expect(await s.credentials.putSecret(c.id, sealed('ahead'), 5)).toBe('conflict')

    const latest = await s.credentials.latestSecret(c.id)
    expect(latest?.version).toBe(1)
    expect(latest?.sealed.ciphertext.toString()).toBe('ciphertext-first')
  })

  it('removes a credential: secrets deleted, record kept as revoked and hidden from lists', async () => {
    const s = await open()
    const c = await s.credentials.insert({ ownerUserId: OWNER, label: 'k', type: 'openai.api-key' })
    await s.credentials.putSecret(c.id, sealed('x'), 0)
    await s.credentials.remove(c.id)
    expect(await s.credentials.latestSecret(c.id)).toBeNull()
    expect((await s.credentials.get(c.id))?.status).toBe('revoked')
    expect(await s.credentials.listVisibleTo(OWNER)).toEqual([])
  })

  it('records placements and machine allowances', async () => {
    const s = await open()
    const c = await s.credentials.insert({
      ownerUserId: OWNER,
      label: 'login',
      type: 'anthropic.claude-login',
    })
    await s.credentials.recordPlacement({ credentialId: c.id, machineId: MACHINE, kind: 'home' })
    await s.credentials.recordPlacement({ credentialId: c.id, machineId: MACHINE, kind: 'home' })
    expect(await s.credentials.listPlacements(c.id)).toEqual([
      expect.objectContaining({ machineId: MACHINE, kind: 'home', state: 'present' }),
    ])
    await s.credentials.setPlacementState(
      { credentialId: c.id, machineId: MACHINE, kind: 'home' },
      'removed',
    )
    expect((await s.credentials.listPlacements(c.id))[0]).toMatchObject({
      state: 'removed',
      removedAt: expect.any(String),
    })

    expect(await s.credentials.isMachineAllowed(c.id, MACHINE)).toBe(false)
    await s.credentials.allowMachine(c.id, MACHINE, OWNER)
    await s.credentials.allowMachine(c.id, MACHINE, OWNER)
    expect(await s.credentials.isMachineAllowed(c.id, MACHINE)).toBe(true)
    await s.credentials.disallowMachine(c.id, MACHINE)
    expect(await s.credentials.isMachineAllowed(c.id, MACHINE)).toBe(false)
  })
})
