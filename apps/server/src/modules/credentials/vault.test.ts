import { randomBytes } from 'node:crypto'
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { asUserId, firstAdminMemberId, primeFirstAdminMember } from '@podium/model'
import type { SqlDatabase } from '@podium/runtime/sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { SessionStore } from '../../store'
import type { CredentialRecord } from '../../store/credentials'
import { sealCredentialSecret, VaultLockedError, withSecret } from './vault'

/** Obviously fake. Never a real provider key. */
const CANARY = 'FAKE-sk-ant-vault-test-canary-0000'
const OWNER = asUserId('user:owner')

const rawDb = (store: SessionStore): SqlDatabase => (store as unknown as { db: SqlDatabase }).db

function rawRows(store: SessionStore, table: string): string {
  return JSON.stringify(rawDb(store).prepare(`SELECT * FROM ${table}`).all())
}

describe('Vault', () => {
  let store: SessionStore | undefined

  afterEach(async () => {
    await store?.close()
    store = undefined
  })

  /** Open (or reopen) the store at `dbPath` with its vault key at `keyPath`. */
  async function openStore(dbPath: string, keyPath: string): Promise<SessionStore> {
    await store?.close()
    store = await SessionStore.open(dbPath, undefined, { vaultKeyFile: keyPath })
    primeFirstAdminMember(await firstAdminMemberId(store))
    return store
  }

  async function setup(keyPath = join(mkdtempSync(join(tmpdir(), 'vault-')), 'vault.key')) {
    const dbPath = join(mkdtempSync(join(tmpdir(), 'vault-db-')), 'podium.db')
    const s = await openStore(dbPath, keyPath)
    const vault = s.vault
    const credential = await s.credentials.insert({
      ownerUserId: OWNER,
      label: 'Work key',
      type: 'anthropic.api-key',
    })
    return {
      store: s,
      vault,
      keyPath,
      dbPath,
      credential,
      deps: { credentials: s.credentials, vault },
    }
  }

  it('opens a sealed secret to the same bytes; the raw rows do not hold it', async () => {
    const { store: s, vault, credential, deps } = await setup()
    expect(vault.state()).toBe('empty')

    expect(await sealCredentialSecret(deps, credential, CANARY, 0)).toBe(1)
    expect(vault.state()).toBe('ready')

    const latest = await s.credentials.latestSecret(credential.id)
    expect(latest?.openable).toBe(true)
    const binding = { credentialId: credential.id, type: credential.type, version: 1 }
    expect(vault.open(binding, latest!.sealed).toString('utf8')).toBe(CANARY)
    expect(await withSecret(deps, credential.id, async (secret) => secret)).toBe(CANARY)

    // Canary: the search below finds the secret where it is present.
    expect(JSON.stringify({ planted: CANARY })).toContain(CANARY)
    const secrets = rawRows(s, 'credential_secrets')
    expect(secrets).toContain(credential.id)
    expect(secrets).not.toContain(CANARY)
    expect(secrets).not.toContain(Buffer.from(CANARY).toString('base64'))
    expect(rawRows(s, 'vault_key')).not.toContain(CANARY)
  })

  it('does not open a ciphertext moved to another credential, type or version', async () => {
    const { vault, credential, store: s } = await setup()
    const bound = { credentialId: credential.id, type: credential.type, version: 1 }
    const sealed = await vault.seal(bound, Buffer.from(CANARY))
    expect(vault.open(bound, sealed).toString()).toBe(CANARY)

    const other = await s.credentials.insert({
      ownerUserId: OWNER,
      label: 'Other',
      type: 'anthropic.api-key',
    })
    expect(() => vault.open({ ...bound, credentialId: other.id }, sealed)).toThrow()
    expect(() => vault.open({ ...bound, type: 'openai.api-key' }, sealed)).toThrow()
    expect(() => vault.open({ ...bound, version: 2 }, sealed)).toThrow()
  })

  it('creates exactly one data key when two first seals race', async () => {
    const { vault, credential, store: s } = await setup()
    const a = { credentialId: credential.id, type: credential.type, version: 1 }
    const b = { credentialId: credential.id, type: credential.type, version: 2 }
    const [sa, sb] = await Promise.all([
      vault.seal(a, Buffer.from('FAKE-a')),
      vault.seal(b, Buffer.from('FAKE-b')),
    ])
    expect(rawDb(s).prepare('SELECT count(*) AS n FROM vault_key').get()).toEqual({ n: 1 })
    expect(sa.keyId).toBe(sb.keyId)
    expect(vault.open(a, sa).toString()).toBe('FAKE-a')
    expect(vault.open(b, sb).toString()).toBe('FAKE-b')
  })

  describe('when the key file is gone', () => {
    async function lockedSetup() {
      const ready = await setup()
      await sealCredentialSecret(ready.deps, ready.credential, CANARY, 0)
      rmSync(ready.keyPath)
      const reopened = await openStore(ready.dbPath, ready.keyPath)
      const vault = reopened.vault
      return {
        ...ready,
        store: reopened,
        vault,
        deps: { credentials: reopened.credentials, vault },
      }
    }

    it('is locked, cannot open, and refuses to seal naming the expected path', async () => {
      const { vault, credential, keyPath, store: s, deps } = await lockedSetup()
      expect(vault.state()).toBe('locked')
      expect(vault.status()).toMatchObject({ keyPath, state: 'locked' })
      expect(vault.status().problem).toContain(keyPath)

      const latest = await s.credentials.latestSecret(credential.id)
      expect(latest?.openable).toBe(false)
      expect(() =>
        vault.open(
          { credentialId: credential.id, type: credential.type, version: 1 },
          latest!.sealed,
        ),
      ).toThrow(VaultLockedError)
      await expect(withSecret(deps, credential.id, async (secret) => secret)).rejects.toThrow()

      const another = await s.credentials.insert({
        ownerUserId: OWNER,
        label: 'New',
        type: 'openai.api-key',
      })
      const refusal = await sealCredentialSecret(deps, another, 'FAKE-new', 0).catch(
        (error: unknown) => error,
      )
      expect(refusal).toBeInstanceOf(VaultLockedError)
      expect((refusal as Error).message).toContain(keyPath)
      expect(existsSync(keyPath)).toBe(false)
    })

    it('after a reset, adds new credentials and leaves the old ones needing attention', async () => {
      const { vault, credential, keyPath, store: s, deps } = await lockedSetup()
      expect(await vault.reset()).toEqual([credential.id])
      expect(vault.state()).toBe('empty')
      expect(await s.credentials.latestSecret(credential.id)).toBeNull()
      expect(await s.credentials.get(credential.id)).toMatchObject({
        status: 'attention',
        statusReason: 'vault-reset',
      })

      const fresh: CredentialRecord = await s.credentials.insert({
        ownerUserId: OWNER,
        label: 'Fresh',
        type: 'openai.api-key',
      })
      expect(await sealCredentialSecret(deps, fresh, 'FAKE-fresh', 0)).toBe(1)
      expect(await withSecret(deps, fresh.id, async (secret) => secret)).toBe('FAKE-fresh')
      expect(existsSync(keyPath)).toBe(true)
    })
  })

  it('is locked, not ready, when the key file is replaced by another key', async () => {
    const { deps, credential, keyPath, dbPath } = await setup()
    await sealCredentialSecret(deps, credential, CANARY, 0)
    writeFileSync(keyPath, `${randomBytes(32).toString('base64')}\n`)
    chmodSync(keyPath, 0o600)
    const before = readFileSync(keyPath)

    const vault = (await openStore(dbPath, keyPath)).vault
    expect(vault.state()).toBe('locked')
    expect(vault.status().problem).toContain(keyPath)
    await expect(
      vault.seal(
        { credentialId: credential.id, type: credential.type, version: 2 },
        Buffer.from('x'),
      ),
    ).rejects.toThrow(VaultLockedError)
    expect(readFileSync(keyPath)).toEqual(before)
  })

  it('reports a key file others can read, refuses to seal, and still opens', async () => {
    const keyPath = join(mkdtempSync(join(tmpdir(), 'vault-')), 'vault.key')
    writeFileSync(keyPath, `${randomBytes(32).toString('base64')}\n`)
    chmodSync(keyPath, 0o644)
    const { vault, deps, credential } = await setup(keyPath)
    expect(vault.state()).toBe('empty')
    expect(vault.status().problem).toContain(keyPath)
    const refusal = await sealCredentialSecret(deps, credential, 'FAKE-x', 0).catch(
      (error: unknown) => error,
    )
    expect((refusal as Error).message).toContain(keyPath)
  })

  it('withSecret refuses a removed credential and one with no secret', async () => {
    const { deps, credential, store: s } = await setup()
    await expect(withSecret(deps, credential.id, async (x) => x)).rejects.toThrow(
      /no stored secret/,
    )
    await sealCredentialSecret(deps, credential, 'FAKE-y', 0)
    await s.credentials.remove(credential.id)
    await expect(withSecret(deps, credential.id, async (x) => x)).rejects.toThrow(/removed/)
  })
})
