import { describe, expect, it, vi } from 'vitest'
import {
  adoptServerProfileMove,
  type AccountCredentials,
  createServerProfiles,
  moveServerProfile,
  profileServerIdentity,
  type ServerProfile,
  withPairingIdentity,
  withProfileServerIdentity,
} from './index'

const ID_A = `pdm_${'a'.repeat(43)}`
const ID_B = `pdm_${'b'.repeat(43)}`
const KEY_A = `ed25519:${'A'.repeat(43)}`
const KEY_B = `ed25519:${'B'.repeat(43)}`

const profile: ServerProfile = {
  id: 'server-a',
  name: 'old-words.trycloudflare.com',
  httpOrigin: 'https://old-words.trycloudflare.com',
  instanceId: 'default',
  mode: 'protected',
  transport: 'trusted-https',
  userId: 'alice',
  memberId: 'alice',
  syncBoundaryId: 'installation-a',
  installationId: ID_A,
  installationPublicKey: KEY_A,
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
}

function metadata() {
  const values = new Map<string, string>()
  return {
    values,
    storage: {
      getItem: async (key: string) => values.get(key) ?? null,
      setItem: async (key: string, value: string) => {
        values.set(key, value)
      },
    },
  }
}

const credentials = (): AccountCredentials => ({
  delivery: 'native',
  get: vi.fn(async () => 'token'),
  set: vi.fn(async () => {}),
  remove: vi.fn(async () => {}),
})

describe('moveServerProfile (POD-5921)', () => {
  const NEW = 'https://new-words.trycloudflare.com'

  it('moves the SAME profile — same id, so the same credential handle — to the new origin', () => {
    const state = { activeProfileId: profile.id, profiles: [profile] }
    const { state: next, moved, displaced } = moveServerProfile(state, profile.id, `${NEW}/`, 'now')
    expect(moved).toEqual({
      ...profile,
      httpOrigin: NEW,
      name: 'new-words.trycloudflare.com',
      transport: 'trusted-https',
      updatedAt: 'now',
    })
    expect(next).toEqual({ activeProfileId: profile.id, profiles: [moved] })
    expect(displaced).toEqual([])
  })

  it('keeps a name the person chose', () => {
    const named = { ...profile, name: 'Home' }
    const { moved } = moveServerProfile({ activeProfileId: null, profiles: [named] }, named.id, NEW)
    expect(moved.name).toBe('Home')
  })

  it('displaces a stale duplicate of the same installation at the new origin', () => {
    const duplicate = { ...profile, id: 'server-dup', httpOrigin: NEW }
    const { state, displaced } = moveServerProfile(
      { activeProfileId: duplicate.id, profiles: [profile, duplicate] },
      profile.id,
      NEW,
    )
    expect(displaced).toEqual([duplicate])
    expect(state.profiles.map((row) => row.id)).toEqual([profile.id])
    expect(state.activeProfileId).toBe(profile.id)
  })

  it('refuses to move onto another installation, or one that cannot say', () => {
    const other = { ...profile, id: 'server-b', httpOrigin: NEW, installationId: ID_B, installationPublicKey: KEY_B }
    const state = { activeProfileId: profile.id, profiles: [profile, other] }
    expect(() => moveServerProfile(state, profile.id, NEW)).toThrow(/another server is already saved/)
    const { installationId: _i, installationPublicKey: _k, ...anonymous } = other
    expect(() =>
      moveServerProfile({ ...state, profiles: [profile, anonymous] }, profile.id, NEW),
    ).toThrow(/another server is already saved/)
  })

  it('a profile in another workspace at that origin is not a clash', () => {
    const other = { ...profile, id: 'server-w', httpOrigin: NEW, workspaceId: 'w2', installationId: ID_B }
    const { displaced } = moveServerProfile(
      { activeProfileId: profile.id, profiles: [profile, other] },
      profile.id,
      NEW,
    )
    expect(displaced).toEqual([])
  })

  it('only ever moves onto https', () => {
    const state = { activeProfileId: profile.id, profiles: [profile] }
    expect(() => moveServerProfile(state, profile.id, 'http://new.example')).toThrow(/https/)
    expect(() => moveServerProfile(state, 'missing', NEW)).toThrow(/no such/)
  })
})

describe('adoptServerProfileMove persists the move', () => {
  it('keeps the credential, removes only a displaced duplicate’s, and never erases the shared replica', async () => {
    const { storage } = metadata()
    const profiles = createServerProfiles({ storage })
    const duplicate = { ...profile, id: 'server-dup', httpOrigin: 'https://new.example' }
    await profiles.saveServerProfiles({ activeProfileId: profile.id, profiles: [profile, duplicate] })
    const creds = credentials()
    const erase = vi.fn(async () => {})
    const { state, moved } = await adoptServerProfileMove({
      profileId: profile.id,
      origin: 'https://new.example',
      profiles,
      credentials: creds,
      erasePrincipal: erase,
    })
    expect(moved.id).toBe(profile.id)
    expect(await profiles.loadServerProfiles()).toEqual(state)
    expect(state.profiles).toEqual([moved])
    expect(creds.remove).toHaveBeenCalledExactlyOnceWith('server-dup')
    expect(erase).not.toHaveBeenCalled()
    expect(await profiles.loadPendingProfileCleanups()).toEqual([])
  })
})

describe('the stored identity', () => {
  it('survives a reload; half an identity reads as none without dropping the profile', async () => {
    const { storage, values } = metadata()
    const profiles = createServerProfiles({ storage })
    await profiles.saveServerProfiles({ activeProfileId: profile.id, profiles: [profile] })
    expect(profileServerIdentity((await profiles.loadServerProfiles()).profiles[0]!)).toEqual({
      installationId: ID_A,
      installationPublicKey: KEY_A,
    })
    const half = { ...profile, installationPublicKey: 'ed25519:short' }
    values.set('podium.accounts.server-profiles.v1', JSON.stringify({ activeProfileId: profile.id, profiles: [half] }))
    const loaded = (await profiles.loadServerProfiles()).profiles[0]!
    expect(loaded.id).toBe(profile.id)
    expect(profileServerIdentity(loaded)).toBeUndefined()
    expect(loaded.installationId).toBeUndefined()
  })

  it('is overwritten by a later authenticated login, and untouched when unchanged', () => {
    const state = { activeProfileId: profile.id, profiles: [profile] }
    expect(withProfileServerIdentity(state, profile.id, { installationId: ID_A, installationPublicKey: KEY_A })).toBe(state)
    const next = withProfileServerIdentity(state, profile.id, { installationId: ID_B, installationPublicKey: KEY_B })
    expect(profileServerIdentity(next.profiles[0]!)).toEqual({ installationId: ID_B, installationPublicKey: KEY_B })
  })

  it('comes from the pairing envelope, when the envelope names one', () => {
    const preflight = {
      ok: true as const,
      httpOrigin: 'https://a.example',
      instanceId: 'default',
      appVersion: 'dev',
      mode: 'protected' as const,
      transport: 'trusted-https' as const,
    }
    const envelope = {
      v: 2 as const,
      kind: 'mobile-client' as const,
      mode: 'open' as const,
      serverUrl: 'https://a.example',
      instanceId: 'default',
      installationId: ID_A,
      installationPublicKey: KEY_A,
    }
    expect(withPairingIdentity(preflight, envelope)).toEqual({
      ...preflight,
      installationId: ID_A,
      installationPublicKey: KEY_A,
    })
    const { installationId: _i, installationPublicKey: _k, ...older } = envelope
    expect(withPairingIdentity(preflight, older)).toBe(preflight)
    expect(withPairingIdentity(preflight, null)).toBe(preflight)
  })
})
