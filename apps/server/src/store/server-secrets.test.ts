import { asUserId } from '@podium/model'
import {
  INSTALLATION_META_KEY,
  INSTALLATION_PRIVATE_KEY,
  mintInstallationIdentity,
} from '@podium/runtime/installation-identity'
import { sql } from 'drizzle-orm'
import { afterEach, describe, expect, it } from 'vitest'
import {
  openPeopleStoreSlice,
  openPeopleStoreSlices,
  type PeopleStoreSlice,
} from '../test-support/people-store-slice'

describe('native login transfer secrets', () => {
  let store: PeopleStoreSlice | undefined

  afterEach(async () => {
    await store?.close()
    store = undefined
  })

  it('is retrievable only by its principal and is absent from presence projections', async () => {
    store = await openPeopleStoreSlice()
    const bundle = {
      kind: 'codex' as const,
      contentBase64: Buffer.from('credential-bytes').toString('base64'),
    }

    const transferId = await store.secrets.putNativeLoginTransfer(asUserId('user:one'), bundle)
    expect(await store.secrets.getNativeLoginTransfer(asUserId('user:one'), transferId)).toEqual(
      bundle,
    )
    expect(
      await store.secrets.getNativeLoginTransfer(asUserId('user:two'), transferId),
    ).toBeUndefined()
    expect(JSON.stringify(await store.secrets.presence())).not.toContain('credential-bytes')

    await store.secrets.clearNativeLoginTransfer(asUserId('user:one'), transferId)
    expect(
      await store.secrets.getNativeLoginTransfer(asUserId('user:one'), transferId),
    ).toBeUndefined()
  })
})

/**
 * A WORKSPACE'S OWN SECRETS (POD-6959 design 2.1, task POD-7013): two workspaces
 * over one database hold their settings secrets and fingerprint keys apart, and
 * share the install's.
 */
describe('secrets of two workspaces', () => {
  let opened: PeopleStoreSlice | undefined

  afterEach(async () => {
    await opened?.close()
    opened = undefined
  })

  async function twoWorkspaces(): Promise<readonly [PeopleStoreSlice, PeopleStoreSlice]> {
    const stores = await openPeopleStoreSlices(['ws_a', 'ws_b'])
    opened = stores[0]
    return stores
  }

  it('holds a Telegram bot token per workspace, with presence and clears of its own', async () => {
    const [a, b] = await twoWorkspaces()
    const at = '2026-11-17T00:00:00.000Z'
    await a.secrets.set('notifications.telegramBotToken', 'token-a', at)
    const present = async (store: PeopleStoreSlice) =>
      (await store.secrets.presence()).find((p) => p.key === 'notifications.telegramBotToken')
        ?.present
    expect(await b.secrets.get('notifications.telegramBotToken')).toBeUndefined()
    expect(await present(b)).toBe(false)
    await b.secrets.set('notifications.telegramBotToken', 'token-b', at)
    expect(await a.secrets.get('notifications.telegramBotToken')).toBe('token-a')
    expect(await b.secrets.get('notifications.telegramBotToken')).toBe('token-b')
    await a.secrets.clear('notifications.telegramBotToken')
    expect(await present(a)).toBe(false)
    expect(await b.secrets.get('notifications.telegramBotToken')).toBe('token-b')
  })

  it('holds a fingerprint key per workspace: imported for the boot workspace, minted once for another', async () => {
    const [a, b] = await twoWorkspaces()
    const keyA = await a.secrets.fingerprintKey()
    const keyB = await b.secrets.fingerprintKey()
    expect(keyA).toHaveLength(32)
    expect(keyB).toHaveLength(32)
    expect(keyB).not.toEqual(keyA)
    // Minted once: a second read returns the same key.
    expect(await b.secrets.fingerprintKey()).toEqual(keyB)
    expect(await a.secrets.fingerprintKey()).toEqual(keyA)
  })

  it('keeps native login transfers in their workspace', async () => {
    const [a, b] = await twoWorkspaces()
    const owner = asUserId('user:one')
    const bundle = {
      kind: 'codex' as const,
      contentBase64: Buffer.from('bytes').toString('base64'),
    }
    const transferId = await a.secrets.putNativeLoginTransfer(owner, bundle)
    expect(await a.secrets.getNativeLoginTransfer(owner, transferId)).toEqual(bundle)
    expect(await b.secrets.getNativeLoginTransfer(owner, transferId)).toBeUndefined()
  })

  it('shares the install secrets: one installation identity and one identity signing secret', async () => {
    const [a, b] = await twoWorkspaces()
    // A whole store imports the installation identity at boot; the slice has no boot,
    // so the two install rows are written as that import writes them.
    const { privateKey, ...metadata } = mintInstallationIdentity()
    await a.run(
      sql`INSERT INTO meta (key, value) VALUES (${INSTALLATION_META_KEY}, ${JSON.stringify(metadata)})`,
    )
    await a.run(
      sql`INSERT INTO server_secrets (key, value, updated_at) VALUES (${INSTALLATION_PRIVATE_KEY}, ${privateKey}, ${metadata.createdAt})`,
    )
    expect(await b.secrets.installationIdentity()).toEqual(await a.secrets.installationIdentity())
    expect(await b.secrets.identitySigningSecret()).toBe(await a.secrets.identitySigningSecret())
  })
})
