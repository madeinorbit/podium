import { describe, expect, it } from 'vitest'
import { localStorage, manifest } from '../../../runtime/src/fixtures/customer-upgrade'
import type { StorageApi } from '../contract'
import { preparePrincipalNamespace } from '../principal-storage'

function storageFromFixture(): { api: StorageApi; keys: () => string[] } {
  const values = new Map(Object.entries(localStorage))
  let firstMarkerWrite = true
  return {
    api: {
      getItem: (key) => values.get(key) ?? null,
      setItem: (key, value) => {
        if (firstMarkerWrite && key.endsWith('.namespace.v1')) {
          firstMarkerWrite = false
          throw Object.assign(new Error('quota exceeded'), { name: 'QuotaExceededError' })
        }
        values.set(key, value)
      },
      removeItem: (key) => values.delete(key),
    },
    keys: () => [...values.keys()],
  }
}

describe('customer upgrade fixture: client', () => {
  it('boots a full old-principal namespace and writes the successor marker', () => {
    const memory = storageFromFixture()
    const namespace = preparePrincipalNamespace({
      storage: memory.api,
      enumerateKeys: memory.keys,
      basePrefix: 'podium.replica',
      principal: manifest.replacementPrincipal,
      now: () => 3,
    })

    expect(namespace.durable).toBe(true)
    expect(namespace.evictedPrincipals).toContain('user:sole')
    expect(memory.api.getItem(`${namespace.keyPrefix}.namespace.v1`)).toContain(manifest.replacementPrincipal)
    expect(memory.keys().some((key) => key.startsWith(manifest.client.oldNamespace))).toBe(false)
  })
})
