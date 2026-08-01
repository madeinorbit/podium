import { describe, expect, it, vi } from 'vitest'
import { createSideCache } from './kernel/side-cache'
import {
  preparePrincipalNamespace,
  principalKeyPrefix,
  type PrincipalNamespacePolicy,
} from './principal-storage'
import { createReplica } from './replica'
import type { StorageApi, StorageEventApi } from './contract'

const POLICY: PrincipalNamespacePolicy = {
  signOut: 'erase',
  maxRetainedPrincipals: 2,
  maxInactiveMs: 100,
}

describe('principal replica storage', () => {
  it('a planted foreign cursor and collection are never adopted', async () => {
    const memory = keyedStorage()
    const alice = preparePrincipalNamespace({
      storage: memory.api,
      enumerateKeys: memory.keys,
      basePrefix: 'podium.replica',
      principal: 'alice',
      now: () => 1,
    })
    const aliceReplica = createReplica({ storage: memory.api, keyPrefix: alice.keyPrefix })
    aliceReplica.applySnapshot('sessions', [
      { sessionId: 'alice-session', name: 'Alice', cwd: '/alice' } as never,
    ])
    aliceReplica.setCursor(41)
    await aliceReplica.flush()

    const bob = preparePrincipalNamespace({
      storage: memory.api,
      enumerateKeys: memory.keys,
      basePrefix: 'podium.replica',
      principal: 'bob',
      now: () => 2,
    })
    const bobReplica = createReplica({ storage: memory.api, keyPrefix: bob.keyPrefix })
    expect(bobReplica.getCursor()).toBeNull()
    expect(bobReplica.rows('sessions')).toEqual([])
    expect(memory.keys().some((key) => key.startsWith(alice.keyPrefix))).toBe(true)
    expect(memory.keys().some((key) => key.startsWith(bob.keyPrefix))).toBe(true)
  })

  it('sign-out erases only the acting namespace and leaves the raw theme', () => {
    const memory = keyedStorage()
    memory.api.setItem('podium.theme.preset', 'superade')
    const alice = preparePrincipalNamespace({
      storage: memory.api,
      enumerateKeys: memory.keys,
      basePrefix: 'podium.replica',
      principal: 'alice',
    })
    const bob = preparePrincipalNamespace({
      storage: memory.api,
      enumerateKeys: memory.keys,
      basePrefix: 'podium.replica',
      principal: 'bob',
    })
    memory.api.setItem(`${alice.keyPrefix}.cursor.v1`, '41')
    memory.api.setItem(`${alice.keyPrefix}.outbox.v1`, '[]')
    memory.api.setItem(`${bob.keyPrefix}.cursor.v1`, '9')

    alice.erase()

    expect(memory.keys().some((key) => key.startsWith(`${alice.keyPrefix}.`))).toBe(false)
    expect(memory.api.getItem(`${bob.keyPrefix}.cursor.v1`)).toBe('9')
    expect(memory.api.getItem('podium.theme.preset')).toBe('superade')
  })

  it('bounds retained principals by age and LRU count', () => {
    const memory = keyedStorage()
    const open = (principal: string, at: number) =>
      preparePrincipalNamespace({
        storage: memory.api,
        enumerateKeys: memory.keys,
        basePrefix: 'podium.replica',
        principal,
        now: () => at,
        policy: POLICY,
      })
    const alice = open('alice', 0)
    memory.api.setItem(`${alice.keyPrefix}.cursor.v1`, '1')
    const bob = open('bob', 50)
    memory.api.setItem(`${bob.keyPrefix}.cursor.v1`, '2')
    const carol = open('carol', 75)
    expect(carol.evictedPrincipals).toEqual(['alice'])
    expect(memory.keys().some((key) => key.startsWith(alice.keyPrefix))).toBe(false)
    expect(memory.keys().some((key) => key.startsWith(bob.keyPrefix))).toBe(true)

    const dana = open('dana', 200)
    expect(new Set(dana.evictedPrincipals)).toEqual(new Set(['bob', 'carol']))
    expect(dana.knownPrincipals).toEqual(['dana'])
  })

  it('legacy inputs are consumed once by the acting principal; theme alone remains raw', () => {
    const memory = keyedStorage()
    memory.api.setItem('podium.view', 'issues')
    memory.api.setItem('podium.theme.preset', 'superade')
    memory.api.setItem(
      'podium.outbox.v1',
      JSON.stringify([{ mutationId: 'alice-write', kind: 'rename', input: {}, queuedAt: 1 }]),
    )
    const alicePrefix = principalKeyPrefix('podium.kernel-replica', 'alice')
    const alice = createSideCache({
      storage: memory.api,
      enumerateKeys: memory.keys,
      keyPrefix: alicePrefix,
    })
    expect(alice.uiState().get('podium.view')).toBe('issues')
    expect(
      alice
        .outboxStorage()
        .load()
        .map((entry) => entry.mutationId),
    ).toEqual(['alice-write'])
    expect(memory.api.getItem('podium.view')).toBeNull()
    expect(memory.api.getItem('podium.outbox.v1')).toBeNull()
    expect(memory.api.getItem('podium.theme.preset')).toBe('superade')

    const bob = createSideCache({
      storage: memory.api,
      enumerateKeys: memory.keys,
      keyPrefix: principalKeyPrefix('podium.kernel-replica', 'bob'),
    })
    expect(bob.uiState().get('podium.view')).toBeNull()
    expect(bob.outboxStorage().load()).toEqual([])
    // Theme is mirrored deliberately: cosmetic, identity-free, and pre-auth.
    expect(bob.uiState().get('podium.theme.preset')).toBe('superade')
    alice.dispose()
    bob.dispose()
  })

  it('cross-tab storage events never cross principal keys, and dispose detaches', () => {
    const memory = keyedStorage()
    const events = storageEvents()
    const alice = createSideCache({
      storage: memory.api,
      enumerateKeys: memory.keys,
      storageEventApi: events.api,
      keyPrefix: principalKeyPrefix('podium.kernel-replica', 'alice'),
    })
    const changed = vi.fn()
    alice.uiState().subscribe(changed)

    events.fire(principalKeyPrefix('podium.kernel-replica', 'bob') + '.uistate.v1')
    expect(changed).not.toHaveBeenCalled()
    events.fire(principalKeyPrefix('podium.kernel-replica', 'alice') + '.uistate.v1')
    expect(changed).toHaveBeenCalledTimes(1)
    alice.dispose()
    events.fire(principalKeyPrefix('podium.kernel-replica', 'alice') + '.uistate.v1')
    expect(changed).toHaveBeenCalledTimes(1)
  })
})

function keyedStorage(): { api: StorageApi; keys: () => string[] } {
  const values = new Map<string, string>()
  return {
    api: {
      getItem: (key) => values.get(key) ?? null,
      setItem: (key, value) => void values.set(key, value),
      removeItem: (key) => void values.delete(key),
    },
    keys: () => [...values.keys()],
  }
}

function storageEvents(): {
  api: StorageEventApi
  fire(key: string): void
} {
  const listeners = new Set<(event: StorageEvent) => void>()
  return {
    api: {
      addEventListener: (_type, listener) => listeners.add(listener),
      removeEventListener: (_type, listener) => listeners.delete(listener),
    },
    fire: (key) => {
      const event = { key } as StorageEvent
      for (const listener of [...listeners]) listener(event)
    },
  }
}
