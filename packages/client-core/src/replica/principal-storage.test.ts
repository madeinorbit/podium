import { openLegacyDeviceKeys } from '@podium/client-core/ui'
import { addSink } from '@podium/logger'
import { asUserId } from '@podium/model'
import { describe, expect, it, vi } from 'vitest'
import { asClientPrincipal, principalKey, samePrincipal } from '../principal'
import type { StorageApi } from './contract'
import { createSideCache } from './kernel/side-cache'
import {
  type PrincipalNamespacePolicy,
  parseReplicaNamespaceKey,
  preparePrincipalNamespace,
  principalKeyPrefix,
  replicaNamespaceKey,
} from './principal-storage'

const POLICY: PrincipalNamespacePolicy = {
  signOut: 'erase',
  maxRetainedPrincipals: 2,
  maxInactiveMs: 100,
}

describe('principal replica storage', () => {
  it('a planted foreign ui-state blob is never adopted by another principal', async () => {
    const memory = keyedStorage()
    const alice = preparePrincipalNamespace({
      storage: memory.api,
      enumerateKeys: memory.keys,
      basePrefix: 'podium.replica',
      principal: 'alice',
      now: () => 1,
    })
    const aliceUi = openLegacyDeviceKeys(
      createSideCache({ storage: memory.api, keyPrefix: alice.keyPrefix }).deviceStorage(),
    )
    aliceUi.set('podium.panelMode', '{"s1":"chat"}')
    aliceUi.set('podium.view', 'issueProjections')
    await new Promise((r) => setTimeout(r, 0))
    expect(aliceUi.get('podium.panelMode')).toBe('{"s1":"chat"}')
    expect(memory.api.getItem(`${alice.keyPrefix}.uistate.v1`)).not.toBeNull()

    const bob = preparePrincipalNamespace({
      storage: memory.api,
      enumerateKeys: memory.keys,
      basePrefix: 'podium.replica',
      principal: 'bob',
      now: () => 2,
    })
    const bobUi = openLegacyDeviceKeys(
      createSideCache({ storage: memory.api, keyPrefix: bob.keyPrefix }).deviceStorage(),
    )
    expect(bobUi.get('podium.panelMode')).toBeNull()
    expect(bobUi.get('podium.view')).toBeNull()
    // Alice's namespaced blob remains; Bob has a separate empty collection.
    expect(memory.keys().includes(`${alice.keyPrefix}.uistate.v1`)).toBe(true)
  })

  it('degrades safely when the active marker cannot be persisted', () => {
    // A real sink, not a console spy: the diagnostic travels as a record now.
    // No `minLevel`, so it follows the namespace level as production sinks do.
    const captured: { level: string }[] = []
    const restore = addSink({ name: 'principal-test-capture', write: (r) => captured.push(r) })
    const namespace = preparePrincipalNamespace({
      storage: {
        getItem: () => null,
        setItem: () => {
          throw new Error('quota exceeded')
        },
        removeItem: () => {},
      },
      enumerateKeys: () => [],
      basePrefix: 'podium.replica',
      principal: 'alice',
    })

    expect(namespace.keyPrefix).toBe(principalKeyPrefix('podium.replica', 'alice'))
    expect(namespace.durable).toBe(false)
    expect(namespace.knownPrincipals).toEqual([])
    expect(captured.filter((r) => r.level === 'warn')).toHaveLength(1)
    restore()
  })

  it('sign-out erases only the acting namespace and leaves the raw theme', () => {
    const memory = keyedStorage()
    memory.api.setItem('podium.theme.mode', 'dark')
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
    expect(memory.api.getItem('podium.theme.mode')).toBe('dark')
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
        canEvict: () => true,
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

  it('keeps namespaces without proof that their durable outboxes are empty', () => {
    const memory = keyedStorage()
    for (let index = 0; index < 5; index += 1) {
      const namespace = preparePrincipalNamespace({
        storage: memory.api,
        enumerateKeys: memory.keys,
        basePrefix: 'podium.replica',
        principal: `workspace-${index}`,
        now: () => index * 200,
        policy: POLICY,
      })
      expect(namespace.evictedPrincipals).toEqual([])
      expect(namespace.knownPrincipals).toHaveLength(index + 1)
    }
  })

  it.each([
    ['.outbox.v1', '[{"mutationId":"queued"}]'],
    ['.outbox-awaiting.v1', '[{"mutationId":"awaiting"}]'],
    ['.outbox-dead-letter.v1', '[{"mutationId":"parked"}]'],
    ['.outbox.v1', 'unreadable'],
    ['.uistate.v1', 'unreadable'],
    ['.uistate.v1', JSON.stringify({ 'podium.firstTaskActivation.draft': '{"title":"Unsent"}' })],
    ...[
      { text: 'offline edit', serverRev: 1, editedAt: 1, dirty: true },
      { text: '', serverRev: 1, editedAt: 1, dirty: true },
      { text: 'legacy edit', serverRev: 0, editedAt: 1 },
    ].map((draft): [string, string] => [
      '.uistate.v1',
      JSON.stringify({ 'podium.drafts.v1': JSON.stringify({ s1: draft }) }),
    ]),
  ])('preserves authored work in %s across age and count cleanup (%s)', (suffix, value) => {
    const memory = keyedStorage()
    const open = (principal: string, at: number) =>
      preparePrincipalNamespace({
        storage: memory.api,
        enumerateKeys: memory.keys,
        basePrefix: 'podium.replica',
        principal,
        now: () => at,
        policy: POLICY,
        canEvict: () => true,
      })
    const alice = open('alice', 0)
    const workKey = `${alice.keyPrefix}${suffix}`
    memory.api.setItem(workKey, value)
    open('bob', 50)
    // Alice is the oldest, but only the clean Bob namespace may give way.
    expect(open('carol', 75).evictedPrincipals).toEqual(['bob'])
    expect(open('dana', 200).evictedPrincipals).toEqual(['carol'])
    expect(memory.api.getItem(workKey)).toBe(value)
  })

  it('reclaims confirmed draft caches and preferences, while preserving authored homes', () => {
    const memory = keyedStorage()
    const init = {
      storage: memory.api,
      enumerateKeys: memory.keys,
      basePrefix: 'podium.replica',
      canEvict: () => true,
      policy: { ...POLICY, maxRetainedPrincipals: 1 },
    }
    const alice = preparePrincipalNamespace({ ...init, principal: 'alice', now: () => 1 })
    const draftsKey = `${alice.keyPrefix}.uistate.v1`
    memory.api.setItem(
      draftsKey,
      JSON.stringify({
        'podium.newWork.model': 'default',
        'podium.drafts.v1': JSON.stringify({ s1: { text: 'synced', dirty: false } }),
      }),
    )
    memory.api.setItem(`${alice.keyPrefix}.ui.v1`, '{"view":"worklist"}')
    const bob = preparePrincipalNamespace({ ...init, principal: 'bob', now: () => 2 })
    expect(bob.evictedPrincipals).toEqual(['alice'])
    expect(memory.api.getItem(`${alice.keyPrefix}.ui.v1`)).toBeNull()
    // Retention never deletes the home a concurrent writer may have just updated.
    expect(memory.api.getItem(draftsKey)).not.toBeNull()
  })

  it('keeps a namespace when its settings or outbox eligibility cannot be read', () => {
    const memory = keyedStorage()
    const init = {
      storage: memory.api,
      enumerateKeys: memory.keys,
      basePrefix: 'podium.replica',
      policy: { ...POLICY, maxRetainedPrincipals: 1 },
    }
    const alice = preparePrincipalNamespace({ ...init, principal: 'alice', now: () => 1 })
    const get = memory.api.getItem
    vi.spyOn(memory.api, 'getItem').mockImplementation((key) => {
      if (key === `${alice.keyPrefix}.uistate.v1`) throw new Error('read failed')
      return get(key)
    })
    expect(
      preparePrincipalNamespace({
        ...init,
        principal: 'bob',
        now: () => 200,
        canEvict: () => true,
      }).evictedPrincipals,
    ).toEqual([])
    expect(
      preparePrincipalNamespace({
        ...init,
        principal: 'carol',
        now: () => 400,
        canEvict: () => {
          throw new Error('outbox unreadable')
        },
      }).knownPrincipals,
    ).toEqual(['alice', 'bob', 'carol'])
  })

  it('legacy inputs are consumed once by the acting principal; theme alone remains raw', () => {
    const memory = keyedStorage()
    memory.api.setItem('podium.view', 'issueProjections')
    memory.api.setItem('podium.theme.mode', 'dark')
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
    expect(openLegacyDeviceKeys(alice.deviceStorage()).get('podium.view')).toBe('issueProjections')
    expect(
      alice
        .outboxStorage()
        .load()
        .map((entry) => entry.mutationId),
    ).toEqual(['alice-write'])
    expect(memory.api.getItem('podium.view')).toBeNull()
    expect(memory.api.getItem('podium.outbox.v1')).toBeNull()
    expect(memory.api.getItem('podium.theme.mode')).toBe('dark')

    const bob = createSideCache({
      storage: memory.api,
      enumerateKeys: memory.keys,
      keyPrefix: principalKeyPrefix('podium.kernel-replica', 'bob'),
    })
    expect(openLegacyDeviceKeys(bob.deviceStorage()).get('podium.view')).toBeNull()
    expect(bob.outboxStorage().load()).toEqual([])
    // Theme's one home is the raw pre-auth key: cosmetic, identity-free, and read
    // before sign-in. Neither principal's import takes it into its ui-state
    // (7e4ba6f6c4 deleted that copy), so it survives both.
    expect(openLegacyDeviceKeys(alice.deviceStorage()).get('podium.theme.mode')).toBeNull()
    expect(openLegacyDeviceKeys(bob.deviceStorage()).get('podium.theme.mode')).toBeNull()
    expect(memory.api.getItem('podium.theme.mode')).toBe('dark')
    alice.dispose()
    bob.dispose()
  })
})

describe('quota self-heal (POD-3967)', () => {
  /** A storage with a byte budget: setItem throws QuotaExceededError once the
   *  budget is spent, exactly like a full localStorage. */
  function quotaStorage(budget: number): { api: StorageApi; keys: () => string[] } {
    const values = new Map<string, string>()
    const used = () => [...values.entries()].reduce((n, [k, v]) => n + k.length + v.length, 0)
    return {
      api: {
        getItem: (key) => values.get(key) ?? null,
        setItem: (key, value) => {
          const next = used() - (values.get(key)?.length ?? 0) - (values.has(key) ? key.length : 0)
          if (next + key.length + value.length > budget) {
            const err = new Error('QuotaExceededError')
            err.name = 'QuotaExceededError'
            throw err
          }
          values.set(key, value)
        },
        removeItem: (key) => void values.delete(key),
      },
      keys: () => [...values.keys()],
    }
  }

  it('a full storage under a recent foreign namespace boots: evict it, retry the marker', () => {
    const memory = quotaStorage(400)
    // The old principal's namespace fills the device; its marker is RECENT, so
    // time-based retention alone would keep it.
    const old = preparePrincipalNamespace({
      storage: memory.api,
      enumerateKeys: memory.keys,
      basePrefix: 'podium.replica',
      principal: 'user:sole',
      now: () => 1,
      policy: POLICY,
      canEvict: () => true,
    })
    expect(old.durable).toBe(true)
    memory.api.setItem(`${old.keyPrefix}.blob`, 'x'.repeat(250))
    expect(() => memory.api.setItem('probe', 'y'.repeat(100))).toThrow('QuotaExceededError')

    const successor = preparePrincipalNamespace({
      storage: memory.api,
      enumerateKeys: memory.keys,
      basePrefix: 'podium.replica',
      principal: 'mem_successor',
      now: () => 2,
      policy: POLICY,
      canEvict: () => true,
    })
    expect(successor.durable).toBe(true)
    expect(successor.evictedPrincipals).toEqual(['user:sole'])
    expect(memory.keys().some((key) => key.startsWith(old.keyPrefix))).toBe(false)
    expect(memory.keys()).toContain(`${successor.keyPrefix}.namespace.v1`)
  })

  it('does not sacrifice unsent work when quota recovery has no clean namespace', () => {
    const memory = quotaStorage(500)
    const init = {
      storage: memory.api,
      enumerateKeys: memory.keys,
      basePrefix: 'podium.replica',
      policy: POLICY,
      canEvict: () => true,
    }
    const alice = preparePrincipalNamespace({ ...init, principal: 'alice', now: () => 1 })
    memory.api.setItem(`${alice.keyPrefix}.outbox.v1`, '[{}]')
    memory.api.setItem(`${alice.keyPrefix}.blob`, 'x'.repeat(300))
    const bob = preparePrincipalNamespace({ ...init, principal: 'bob', now: () => 2 })
    expect(bob.durable).toBe(false)
    expect(bob.evictedPrincipals).toEqual([])
    expect(memory.api.getItem(`${alice.keyPrefix}.outbox.v1`)).toBe('[{}]')
    expect(memory.api.getItem(`${alice.keyPrefix}.blob`)).toHaveLength(300)
  })

  it('never evicts the active namespace and stays non-durable when nothing can give way', () => {
    const memory = quotaStorage(60)
    const only = preparePrincipalNamespace({
      storage: memory.api,
      enumerateKeys: memory.keys,
      basePrefix: 'podium.replica',
      principal: 'mem_only',
      now: () => 1,
      policy: POLICY,
    })
    expect(only.durable).toBe(false)
    expect(only.evictedPrincipals).toEqual([])
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

describe('server-authored replica namespace tuples', () => {
  it('is unambiguous even for delimiters and distinguishes members and boundaries', () => {
    const identity = { syncBoundaryId: 'installation:/[%]', memberId: 'member:/[%]' }
    const key = replicaNamespaceKey(identity)
    expect(parseReplicaNamespaceKey(key)).toEqual(identity)
    expect(replicaNamespaceKey({ syncBoundaryId: 'a:b', memberId: 'c' })).not.toBe(
      replicaNamespaceKey({ syncBoundaryId: 'a', memberId: 'b:c' }),
    )
    expect(replicaNamespaceKey({ ...identity, memberId: 'renamed' })).not.toBe(key)
    expect(
      parseReplicaNamespaceKey(replicaNamespaceKey({ ...identity, memberId: 'renamed' }))
        ?.syncBoundaryId,
    ).toBe(identity.syncBoundaryId)
    expect(parseReplicaNamespaceKey('legacy-member')).toBeUndefined()
    expect(() => replicaNamespaceKey({ syncBoundaryId: '', memberId: 'member' })).toThrow()
  })
})

it('rebinds a member when the server boundary changes without changing attribution', () => {
  const first = asClientPrincipal(asUserId('member-a'), 'installation-a')
  const other = asClientPrincipal(asUserId('member-a'), 'installation-b')
  expect(samePrincipal(first, other)).toBe(false)
  expect(samePrincipal(first, asClientPrincipal(asUserId('member-a'), 'installation-a'))).toBe(true)
  expect(principalKey(first)).toBe(
    replicaNamespaceKey({ syncBoundaryId: 'installation-a', memberId: 'member-a' }),
  )
  expect(first.userId).toBe('member-a')
})
