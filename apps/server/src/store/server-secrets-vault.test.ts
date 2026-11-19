import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { firstAdminMemberId, primeFirstAdminMember } from '@podium/model'
import { openDatabase } from '@podium/runtime/sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { VaultLockedError } from '../modules/credentials/vault'
import { SELF_HOSTED_WORKSPACE_ID } from '../self-hosted-workspace'
import { SessionStore } from '../store'

/** Obviously fake values. */
const LINEAR = 'FAKE-lin_api_vault_canary_0001'
const TELEGRAM = 'FAKE-123456:telegram-vault-canary-0002'
const OLD_STAMP = '2026-01-02T03:04:05.000Z'

describe('the Linear and Telegram secrets in the vault', () => {
  const open: SessionStore[] = []

  afterEach(async () => {
    for (const store of open.splice(0)) await store.close()
  })

  function place() {
    const dir = mkdtempSync(join(tmpdir(), 'secrets-vault-'))
    return { dbPath: join(dir, 'podium.db'), keyPath: join(dir, 'config', 'vault.key') }
  }

  async function openAt(dbPath: string, keyPath: string): Promise<SessionStore> {
    const store = await SessionStore.open(dbPath, undefined, { vaultKeyFile: keyPath })
    primeFirstAdminMember(await firstAdminMemberId(store))
    open.push(store)
    return store
  }

  async function close(store: SessionStore): Promise<void> {
    open.splice(open.indexOf(store), 1)
    await store.close()
  }

  function rawSecrets(dbPath: string): { key: string; value: string; updated_at: string }[] {
    const db = openDatabase(dbPath)
    try {
      return db.prepare('SELECT key, value, updated_at FROM workspace_secrets').all() as {
        key: string
        value: string
        updated_at: string
      }[]
    } finally {
      db.close()
    }
  }

  function plantPlain(dbPath: string, key: string, value: string): void {
    const db = openDatabase(dbPath)
    try {
      db.prepare(
        `INSERT OR REPLACE INTO workspace_secrets (workspace_id, key, value, updated_at) VALUES ('${SELF_HOSTED_WORKSPACE_ID}', ?, ?, ?)`,
      ).run(key, value, OLD_STAMP)
    } finally {
      db.close()
    }
  }

  it('seals plain values at start; reads return the original values', async () => {
    const { dbPath, keyPath } = place()
    await close(await openAt(dbPath, keyPath))
    plantPlain(dbPath, 'integrations.linearApiKey', LINEAR)
    plantPlain(dbPath, 'notifications.telegramBotToken', TELEGRAM)
    plantPlain(dbPath, 'apiKeys.openai', 'FAKE-sk-plain-openai')
    // Canary: the search finds the planted values before the start that seals them.
    expect(JSON.stringify(rawSecrets(dbPath))).toContain(LINEAR)
    expect(JSON.stringify(rawSecrets(dbPath))).toContain(TELEGRAM)

    const store = await openAt(dbPath, keyPath)
    expect(await store.secrets.get('integrations.linearApiKey')).toBe(LINEAR)
    expect(await store.secrets.getOrEmpty('notifications.telegramBotToken')).toBe(TELEGRAM)
    await close(store)

    const raw = rawSecrets(dbPath)
    const text = JSON.stringify(raw)
    expect(text).not.toContain(LINEAR)
    expect(text).not.toContain(TELEGRAM)
    expect(text).not.toContain(Buffer.from(LINEAR).toString('base64'))
    const byKey = new Map(raw.map((r) => [r.key, r]))
    expect(byKey.get('integrations.linearApiKey')?.value).toMatch(/^vault:v1:/)
    expect(byKey.get('integrations.linearApiKey')?.updated_at).toBe(OLD_STAMP)
    // A provider key is not a sealed server secret: it becomes a credential, and
    // its old row goes once the credential reads back (Task 21).
    expect(byKey.has('apiKeys.openai')).toBe(false)
    expect(text).not.toContain('FAKE-sk-plain-openai')

    // A second start changes nothing and still reads the same values.
    const again = await openAt(dbPath, keyPath)
    expect(await again.secrets.get('integrations.linearApiKey')).toBe(LINEAR)
    expect(rawSecrets(dbPath)).toEqual(raw)
  })

  it('seals a value written through set and does not keep it in plain text', async () => {
    const { dbPath, keyPath } = place()
    const store = await openAt(dbPath, keyPath)
    await store.secrets.set('integrations.linearApiKey', LINEAR, new Date().toISOString())
    expect(await store.secrets.get('integrations.linearApiKey')).toBe(LINEAR)
    expect(JSON.stringify(rawSecrets(dbPath))).not.toContain(LINEAR)
    await store.secrets.set('integrations.linearApiKey', '', new Date().toISOString())
    expect(await store.secrets.get('integrations.linearApiKey')).toBeUndefined()
  })

  it('a sealed value reads as absent while the vault is locked, and a write is refused', async () => {
    const { dbPath, keyPath } = place()
    const first = await openAt(dbPath, keyPath)
    await first.secrets.set('notifications.telegramBotToken', TELEGRAM, OLD_STAMP)
    await close(first)
    const before = rawSecrets(dbPath)
    rmSync(keyPath)

    const store = await openAt(dbPath, keyPath)
    expect(store.vault.state()).toBe('locked')
    expect(await store.secrets.get('notifications.telegramBotToken')).toBeUndefined()
    expect(
      (await store.secrets.presence()).find((p) => p.key === 'notifications.telegramBotToken')
        ?.present,
    ).toBe(true)
    const refusal = await store.secrets
      .set('integrations.linearApiKey', LINEAR, OLD_STAMP)
      .catch((error: unknown) => error)
    expect(refusal).toBeInstanceOf(VaultLockedError)
    expect((refusal as Error).message).toContain(keyPath)
    expect(existsSync(keyPath)).toBe(false)
    await close(store)
    expect(rawSecrets(dbPath)).toEqual(before)
  })

  it('a vault reset deletes the sealed server secrets', async () => {
    const { dbPath, keyPath } = place()
    const first = await openAt(dbPath, keyPath)
    await first.secrets.set('notifications.telegramBotToken', TELEGRAM, OLD_STAMP)
    await close(first)
    rmSync(keyPath)
    const store = await openAt(dbPath, keyPath)
    await store.vault.reset()
    expect(
      (await store.secrets.presence()).find((p) => p.key === 'notifications.telegramBotToken')
        ?.present,
    ).toBe(false)
    await store.secrets.set('notifications.telegramBotToken', TELEGRAM, OLD_STAMP)
    expect(await store.secrets.get('notifications.telegramBotToken')).toBe(TELEGRAM)
  })
})
