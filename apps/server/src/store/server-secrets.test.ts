import { SessionStore } from '../store'

import { afterEach, describe, expect, it } from 'vitest'

describe('native login transfer secrets', () => {
  let store: SessionStore | undefined

  afterEach(() => {
    store?.close()
    store = undefined
  })

  it('is retrievable only by its principal and is absent from presence projections', () => {
    store = new SessionStore(':memory:')
    const bundle = {
      kind: 'codex' as const,
      contentBase64: Buffer.from('credential-bytes').toString('base64'),
    }

    const transferId = store.secrets.putNativeLoginTransfer('user:one', bundle)
    expect(store.secrets.getNativeLoginTransfer('user:one', transferId)).toEqual(bundle)
    expect(store.secrets.getNativeLoginTransfer('user:two', transferId)).toBeUndefined()
    expect(JSON.stringify(store.secrets.presence())).not.toContain('credential-bytes')

    store.secrets.clearNativeLoginTransfer('user:one', transferId)
    expect(store.secrets.getNativeLoginTransfer('user:one', transferId)).toBeUndefined()
  })
})
