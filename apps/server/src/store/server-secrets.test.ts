import { asUserId } from '@podium/model'
import { afterEach, describe, expect, it } from 'vitest'
import type { SessionStore } from '../store'
import { openTestStore } from '../test-support/open-test-store'

describe('native login transfer secrets', () => {
  let store: SessionStore | undefined

  afterEach(() => {
    store?.close()
    store = undefined
  })

  it('is retrievable only by its principal and is absent from presence projections', async () => {
    store = await openTestStore(':memory:')
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
