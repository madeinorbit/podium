import {
  adoptServerProfileMove,
  cookieCredentials,
  type ServerProfile,
} from '@podium/client-core/accounts'
import { followHub, type ServerMove } from '@podium/client-core/server-follow'
import { SocketHub, type WebSocketLike } from '@podium/client-core/socket-transport'
import { encode, type ServerMessage } from '@podium/protocol'
import AsyncStorage from '@react-native-async-storage/async-storage'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const stores = vi.hoisted(() => ({
  async: new Map<string, string>(),
  secure: new Map<string, string>(),
}))

vi.mock('@react-native-async-storage/async-storage', () => ({
  default: {
    getItem: async (key: string) => stores.async.get(key) ?? null,
    setItem: async (key: string, value: string) => void stores.async.set(key, value),
  },
}))
vi.mock('expo-secure-store', () => ({
  WHEN_UNLOCKED_THIS_DEVICE_ONLY: 'device-only',
  getItemAsync: async (key: string) => stores.secure.get(key) ?? null,
  setItemAsync: async (key: string, value: string) => void stores.secure.set(key, value),
  deleteItemAsync: async (key: string) => void stores.secure.delete(key),
}))

import { installMobileMetadataStorage } from './mobile-metadata-storage'
import {
  deleteProfileCredential,
  getProfileCredential,
  setProfileCredential,
} from './profile-credentials.native'
import { loadServerProfiles, mobileServerProfiles, saveServerProfiles } from './server-profiles'

const OLD = 'https://old-words.trycloudflare.com'
const NEW = 'https://new-words.trycloudflare.com'
const profile: ServerProfile = {
  id: 'profile-one',
  name: 'old-words.trycloudflare.com',
  httpOrigin: OLD,
  instanceId: 'default',
  mode: 'protected',
  transport: 'trusted-https',
  userId: 'alice',
  memberId: 'alice',
  syncBoundaryId: 'installation-a',
  installationId: `pdm_${'a'.repeat(43)}`,
  installationPublicKey: `ed25519:${'A'.repeat(43)}`,
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
}

const nativeCredentials = {
  delivery: 'native' as const,
  get: getProfileCredential,
  set: setProfileCredential,
  remove: deleteProfileCredential,
}

beforeEach(() => {
  installMobileMetadataStorage(AsyncStorage)
  stores.async.clear()
  stores.secure.clear()
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.resetModules()
})

describe('the phone follows a moved server (POD-5921)', () => {
  it('keeps the identity on the saved profile across a reload', async () => {
    await saveServerProfiles({ activeProfileId: profile.id, profiles: [profile] })
    const raw = JSON.parse(stores.async.get('podium.mobile.server-profiles.v1')!)
    expect(raw.profiles[0]).toMatchObject({
      installationId: profile.installationId,
      installationPublicKey: profile.installationPublicKey,
    })
    expect((await loadServerProfiles()).profiles[0]).toEqual(profile)
  })

  it('moves the same profile, so the same SecureStore bearer key, to the new origin', async () => {
    await saveServerProfiles({ activeProfileId: profile.id, profiles: [profile] })
    await setProfileCredential(profile.id, 'phone-token')
    const keysBefore = [...stores.secure.keys()]
    const { moved } = await adoptServerProfileMove({
      profileId: profile.id,
      origin: NEW,
      profiles: { ...mobileServerProfiles, loadServerProfiles, saveServerProfiles },
      credentials: nativeCredentials,
    })
    expect(moved).toMatchObject({ id: profile.id, httpOrigin: NEW })
    expect((await loadServerProfiles()).profiles).toEqual([moved])
    expect([...stores.secure.keys()]).toEqual(keysBefore)
    expect(stores.secure.get('podium.mobile.profile.profile-one.bearer.v1')).toBe('phone-token')
    expect(await getProfileCredential(profile.id)).toBe('phone-token')
  })

  it('refuses to move onto another installation saved at that origin', async () => {
    const other: ServerProfile = {
      ...profile,
      id: 'profile-two',
      httpOrigin: NEW,
      installationId: `pdm_${'b'.repeat(43)}`,
      installationPublicKey: `ed25519:${'B'.repeat(43)}`,
    }
    await saveServerProfiles({ activeProfileId: profile.id, profiles: [profile, other] })
    await setProfileCredential(other.id, 'other-token')
    await expect(
      adoptServerProfileMove({
        profileId: profile.id,
        origin: NEW,
        profiles: { ...mobileServerProfiles, loadServerProfiles, saveServerProfiles },
        credentials: nativeCredentials,
      }),
    ).rejects.toThrow(/another server is already saved/)
    expect((await loadServerProfiles()).profiles.map((row) => row.httpOrigin)).toEqual([OLD, NEW])
    expect(await getProfileCredential(other.id)).toBe('other-token')
  })

  it('a transfer frame moves the profile instead of reconnecting unauthenticated', async () => {
    class FakeSocket implements WebSocketLike {
      onopen: ((ev: unknown) => void) | null = null
      onmessage: ((ev: { data: unknown }) => void) | null = null
      onclose: ((ev: unknown) => void) | null = null
      onerror: ((ev: unknown) => void) | null = null
      send(): void {}
      close(): void {}
    }
    const urls: string[] = []
    const socket = new FakeSocket()
    const hub = new SocketHub({
      url: 'wss://old-words.trycloudflare.com/client',
      makeSocket: (url) => {
        urls.push(url)
        return socket
      },
    })
    const adopted: ServerMove[] = []
    const stop = followHub(
      hub,
      {
        loadIdentity: () => undefined,
        saveIdentity: () => {},
        adopt: async (move) => {
          adopted.push(move)
        },
      },
      { connectBaseUrl: () => 'https://connect.test' },
    )
    hub.connect()
    socket.onopen?.({})
    const frame: ServerMessage = {
      type: 'serverRelocation',
      transferId: '00000000-0000-4000-8000-000000000001',
      publicUrl: NEW,
      claimToken: 'c'.repeat(64),
    }
    socket.onmessage?.({ data: encode(frame) })
    await Promise.resolve()
    expect(adopted).toEqual([
      { via: 'transfer', origin: NEW, transferId: frame.transferId, claimToken: 'c'.repeat(64) },
    ])
    // The hub did not dial the target by itself, without a credential.
    expect(urls).toEqual(['wss://old-words.trycloudflare.com/client'])
    stop()
    hub.dispose()

    // After the move, the socket login attaches the saved bearer at the NEW origin.
    const calls: unknown[][] = []
    vi.stubGlobal(
      'WebSocket',
      class {
        constructor(...args: unknown[]) {
          calls.push(args)
        }
      },
    )
    const socketAuth = await import('./native-websocket.native')
    const make = socketAuth.makePlatformSocketLogin({
      credentials: { ...cookieCredentials, delivery: 'native' },
      httpOrigin: NEW,
      bearer: () => 'phone-token',
    })
    make('wss://new-words.trycloudflare.com/client')
    expect(calls[0]?.[2]).toEqual({ headers: { Authorization: 'Bearer phone-token' } })
  })
})
