import AsyncStorage from '@react-native-async-storage/async-storage'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const stores = vi.hoisted(() => ({
  async: new Map<string, string>(),
  secure: new Map<string, string>(),
  asyncSetFailures: [] as Array<Error | undefined>,
  secureSetFailures: [] as Array<{ error: Error; afterWrite?: boolean } | undefined>,
  secureDeleteFailures: [] as Array<Error | undefined>,
  secureSetCalls: 0,
}))

vi.mock('@react-native-async-storage/async-storage', () => ({
  default: {
    getItem: async (key: string) => stores.async.get(key) ?? null,
    setItem: async (key: string, value: string) => {
      const failure = stores.asyncSetFailures.shift()
      if (failure) throw failure
      stores.async.set(key, value)
    },
  },
}))
vi.mock('expo-secure-store', () => ({
  WHEN_UNLOCKED_THIS_DEVICE_ONLY: 'device-only',
  getItemAsync: async (key: string) => stores.secure.get(key) ?? null,
  setItemAsync: async (key: string, value: string) => {
    stores.secureSetCalls += 1
    const failure = stores.secureSetFailures.shift()
    if (failure?.afterWrite) stores.secure.set(key, value)
    if (failure) throw failure.error
    stores.secure.set(key, value)
  },
  deleteItemAsync: async (key: string) => {
    const failure = stores.secureDeleteFailures.shift()
    if (failure) throw failure
    stores.secure.delete(key)
  },
}))

import {
  getProfileCredential,
  purgeOrphanedProfileCredentials,
  setProfileCredential,
} from './profile-credentials.native'
import { installMobileMetadataStorage } from './mobile-metadata-storage'

beforeEach(() => {
  installMobileMetadataStorage(AsyncStorage)
  stores.async.clear()
  stores.secure.clear()
  stores.asyncSetFailures.length = 0
  stores.secureSetFailures.length = 0
  stores.secureDeleteFailures.length = 0
  stores.secureSetCalls = 0
})

describe('native profile credential registry', () => {
  it('rejects URL-shaped override ids before SecureStore sees them', async () => {
    await expect(setProfileCredential('override:https://podium.example', 'token')).rejects.toThrow(
      'invalid secure profile id',
    )
    expect(stores.secure.size).toBe(0)
  })

  it('enumerates and purges credentials abandoned by invalid profile metadata', async () => {
    await setProfileCredential('profile-one', 'one')
    await setProfileCredential('profile-two', 'two')
    await purgeOrphanedProfileCredentials(['profile-two'])

    await expect(getProfileCredential('profile-one')).resolves.toBeNull()
    await expect(getProfileCredential('profile-two')).resolves.toBe('two')
  })

  it('journals the id before attempting a SecureStore write', async () => {
    stores.asyncSetFailures.push(new Error('journal unavailable'))

    await expect(setProfileCredential('profile-one', 'token')).rejects.toThrow(
      'journal unavailable',
    )
    expect(stores.secureSetCalls).toBe(0)
    expect(stores.secure.size).toBe(0)
  })

  it('removes a new journal entry only after failed SecureStore write cleanup succeeds', async () => {
    stores.secureSetFailures.push({ error: new Error('secure write failed') })

    await expect(setProfileCredential('profile-one', 'token')).rejects.toThrow(
      'secure write failed',
    )
    expect(stores.secure.size).toBe(0)
    expect(
      JSON.parse(stores.async.get('podium.mobile.credential-profile-ids.v1') ?? 'null'),
    ).toEqual([])
  })

  it('keeps the journal when an ambiguous SecureStore write cannot be rolled back', async () => {
    stores.secureSetFailures.push({ error: new Error('ambiguous secure write'), afterWrite: true })
    stores.secureDeleteFailures.push(new Error('secure cleanup failed'))

    await expect(setProfileCredential('profile-one', 'token')).rejects.toThrow(
      'ambiguous secure write',
    )
    expect(stores.secure.get('podium.mobile.profile.profile-one.bearer.v1')).toBe('token')
    expect(
      JSON.parse(stores.async.get('podium.mobile.credential-profile-ids.v1') ?? 'null'),
    ).toEqual(['profile-one'])
  })

  it('restores an existing credential while retaining its journal after update failure', async () => {
    await setProfileCredential('profile-one', 'old-token')
    stores.secureSetFailures.push({ error: new Error('replacement write failed') })

    await expect(setProfileCredential('profile-one', 'new-token')).rejects.toThrow(
      'replacement write failed',
    )
    await expect(getProfileCredential('profile-one')).resolves.toBe('old-token')
    expect(
      JSON.parse(stores.async.get('podium.mobile.credential-profile-ids.v1') ?? 'null'),
    ).toEqual(['profile-one'])
  })

  it('leaves a harmless journal id when registry compensation itself fails', async () => {
    stores.asyncSetFailures.push(undefined, new Error('registry rollback failed'))
    stores.secureSetFailures.push({ error: new Error('secure write failed') })

    await expect(setProfileCredential('profile-one', 'token')).rejects.toThrow(
      'secure write failed',
    )
    expect(stores.secure.size).toBe(0)
    expect(
      JSON.parse(stores.async.get('podium.mobile.credential-profile-ids.v1') ?? 'null'),
    ).toEqual(['profile-one'])
  })
})
