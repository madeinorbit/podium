import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  activateServerProfile,
  browserProfileMetadataStorage,
  canOpenProfileOffline,
  clearProfileIdentity,
  cookieCredentials,
  createAccountEraser,
  createAuthClient,
  createServerProfiles,
  createSingleServerAccounts,
  CredentialWriteQueue,
  drainProfileCleanups,
  eraseAccountData,
  offlineProfileStatus,
  removeServerProfile,
  resolveOfflinePrincipal,
  type AccountCredentials,
  type ServerProfile,
} from './index'
import { principalKeyPrefix } from '../replica/principal-storage'

const ALICE = JSON.stringify(['installation-a', 'alice'])
const BOB = JSON.stringify(['installation-a', 'bob'])
const status = {
  needsAuth: true,
  authed: true,
  userId: 'alice',
  memberId: 'alice',
  syncBoundaryId: 'installation-a',
}
const profile: ServerProfile = {
  id: 'server-a',
  name: 'A',
  httpOrigin: 'https://a.example',
  instanceId: 'instance-a',
  mode: 'protected',
  transport: 'trusted-https',
  userId: 'alice',
  memberId: 'alice',
  syncBoundaryId: 'installation-a',
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
const nativeCredentials = (): AccountCredentials => ({
  delivery: 'native',
  get: vi.fn(async () => 'token'),
  set: vi.fn(async () => {}),
  remove: vi.fn(async () => {}),
})

describe('browser account metadata storage', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('keeps scoped profiles and cleanup journals separate without clearing UI state', async () => {
    const values = new Map([['podium.view', 'sessions']])
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
    })
    const erase = vi.fn(async () => {})
    const accounts = (metadataPrefix: string) =>
      createSingleServerAccounts({
        httpOrigin: 'https://a.example',
        metadataPrefix,
        storage: browserProfileMetadataStorage,
        erasePrincipal: erase,
      })
    const blue = accounts('podium.accounts.web.blue')
    const green = accounts('podium.accounts.web.green')
    await blue.recordPrincipal(ALICE)
    await green.recordPrincipal(BOB)
    const greenRecord = values.get('podium.accounts.web.green.profiles.v1')
    await blue.remove()
    expect(erase).toHaveBeenCalledExactlyOnceWith(ALICE)
    expect((await blue.profiles.loadServerProfiles()).profiles).toEqual([])
    expect(await blue.profiles.loadPendingProfileCleanups()).toEqual([])
    expect(values.get('podium.accounts.web.blue.cleanups.v1')).toBe('[]')
    expect(values.get('podium.accounts.web.green.profiles.v1')).toBe(greenRecord)
    expect((await green.profiles.loadServerProfiles()).profiles).toMatchObject([
      { memberId: 'bob' },
    ])
    expect(values.get('podium.view')).toBe('sessions')
  })

  it.each([
    'getItem',
    'setItem',
  ] as const)('rejects browser %s failures through the async port', async (method) => {
    vi.stubGlobal('localStorage', {
      [method]: () => {
        throw new Error('storage unavailable')
      },
    })
    const result =
      method === 'getItem'
        ? browserProfileMetadataStorage.getItem('profiles')
        : browserProfileMetadataStorage.setItem('profiles', 'value')
    await expect(result).rejects.toThrow('storage unavailable')
  })
})

describe('one sign-in decision for both credential deliveries', () => {
  it.each([
    'browser',
    'native',
  ] as const)('names a server-authored replica with %s delivery', async (delivery) => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => Response.json(status))
    const client = createAuthClient({ credentials: { ...nativeCredentials(), delivery }, fetch })
    expect(await client.probeAuth('https://a.example', 'token', 'ws_a')).toMatchObject({
      kind: 'ready',
      auth: { kind: 'principal', principal: ALICE },
    })
    const init = fetch.mock.calls[0]![1] as RequestInit
    expect(init.signal).toBeInstanceOf(AbortSignal)
    expect(init.credentials).toBe(delivery === 'browser' ? 'include' : 'omit')
    expect(new Headers(init.headers).get('Authorization')).toBe(
      delivery === 'native' ? 'Bearer token' : null,
    )
    expect(new Headers(init.headers).get('Podium-Workspace-Id')).toBe('ws_a')
  })

  it('checks readiness before showing sign-in for a blocked server', async () => {
    const client = createAuthClient({
      credentials: cookieCredentials,
      fetch: async () =>
        Response.json({ ...status, authed: false, readiness: { dataPlane: 'blocked' } }),
    })
    expect(await client.probeAuth('https://a.example')).toMatchObject({
      kind: 'ready',
      auth: { kind: 'failure', failure: { kind: 'server-starting' } },
    })
  })

  it('shows a workspace refusal only for a recognised, unauthorised account', async () => {
    const client = createAuthClient({
      credentials: cookieCredentials,
      fetch: async () =>
        Response.json({
          ...status,
          authed: false,
          mode: 'cloud',
          providerSignedIn: true,
          deniedReason: 'not a member',
        }),
    })
    expect(await client.probeAuth('https://a.example')).toMatchObject({
      kind: 'membership-denied',
      reason: 'not a member',
    })
  })

  it('does not let a signed-out answer reuse a tuple left in reporting fields', async () => {
    const client = createAuthClient({
      credentials: cookieCredentials,
      fetch: async () => Response.json({ ...status, authed: false }),
    })
    expect(await client.probeAuth('https://a.example')).toMatchObject({ kind: 'login' })
  })

  it.each([400, 401, 403])('keeps HTTP %s authoritative', async (code) => {
    const client = createAuthClient({
      credentials: cookieCredentials,
      fetch: async () => new Response(null, { status: code }),
    })
    expect(await client.probeAuth('https://a.example')).toMatchObject({
      kind: 'ready',
      auth: { kind: 'failure', failure: { kind: code === 400 ? 'auth-insecure' : 'auth-refused' } },
    })
  })

  it.each([
    {},
    null,
    { needsAuth: true, authed: 'yes' },
  ])('refuses an invalid auth envelope %j', async (body) => {
    const client = createAuthClient({
      credentials: cookieCredentials,
      fetch: async () => Response.json(body),
    })
    expect(await client.probeAuth('https://a.example')).toMatchObject({
      kind: 'ready',
      auth: { kind: 'failure', failure: { kind: 'auth-intercepted' } },
    })
  })

  it('lets a transient proxy failure recover but refuses the repeated malformed answer', async () => {
    const client = createAuthClient({
      credentials: cookieCredentials,
      fetch: async () => new Response('<html>proxy</html>'),
    })
    expect(await client.probeAuth('https://a.example')).toMatchObject({
      auth: { kind: 'provisional-failure' },
    })
    await expect(client.fetchAuthStatus('https://a.example')).rejects.toMatchObject({
      failure: { kind: 'auth-intercepted' },
    })
  })

  it('never sends a password or a bearer over native cleartext', async () => {
    const fetch = vi.fn()
    const client = createAuthClient({ credentials: nativeCredentials(), fetch })
    expect(await client.login('http://192.168.1.2', 'secret')).toMatchObject({ ok: false })
    await expect(client.fetchAuthStatus('http://192.168.1.2', 'token')).rejects.toMatchObject({
      failure: { kind: 'auth-insecure' },
    })
    expect(fetch).not.toHaveBeenCalled()
  })

  it('checks a browser login identity before opening the app', async () => {
    const client = createAuthClient({
      credentials: cookieCredentials,
      fetch: async () => Response.json({ ok: true, userId: 'alice' }),
    })
    expect(await client.login('https://a.example', 'secret')).toMatchObject({ ok: false })
  })

  it('uses the local cookie logout route for a local server', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => Response.json({ ok: true }))
    await createAuthClient({ credentials: cookieCredentials, fetch }).logout(
      'https://a.example',
      null,
      undefined,
      'local',
    )
    expect(fetch).toHaveBeenCalledWith(
      'https://a.example/auth/logout',
      expect.objectContaining({ credentials: 'include', method: 'POST' }),
    )
  })

  it('requires a verified native offline profile and unambiguous browser namespace', () => {
    expect(offlineProfileStatus(profile)).toMatchObject(status)
    expect(offlineProfileStatus({ ...profile, instanceId: undefined })).toBeUndefined()
    expect(resolveOfflinePrincipal([ALICE, ALICE, 'legacy-admin'])).toBe(ALICE)
    expect(() => resolveOfflinePrincipal([ALICE, BOB])).toThrow('ambiguous')
    expect(() => resolveOfflinePrincipal([])).toThrow('no authenticated principal')
  })
})

describe('switching profiles and removing account data', () => {
  async function activation() {
    const { storage } = metadata()
    const profiles = createServerProfiles({ storage })
    await profiles.saveServerProfiles({ activeProfileId: profile.id, profiles: [profile] })
    return {
      profile,
      profiles,
      credentials: nativeCredentials(),
      profileWrites: new CredentialWriteQueue(),
      credentialWrites: new CredentialWriteQueue(),
    }
  }

  it('retires offline identity on sign-out without removing another server profile', async () => {
    const args = await activation()
    const before = await args.profiles.loadServerProfiles()
    const other = { ...profile, id: 'server-b', httpOrigin: 'https://b.example' }
    await args.profiles.saveServerProfiles({ ...before, profiles: [profile, other] })
    const next = await clearProfileIdentity(args.profiles, profile.id, () => true)
    expect(offlineProfileStatus(next.profiles[0]!)).toBeUndefined()
    expect(canOpenProfileOffline(next.profiles[0]!, 'unreachable')).toBe(false)
    expect(next.profiles[0]).toMatchObject({
      signedOut: true,
      userId: 'alice',
      syncBoundaryId: 'installation-a',
      memberId: 'alice',
    })
    expect(await args.profiles.loadServerProfiles()).toEqual(next)
    expect(next.profiles[1]).toEqual(other)
    expect(next.activeProfileId).toBe(profile.id)
  })

  it('erases an expired native account using the retained cleanup identity', async () => {
    const args = await activation()
    await clearProfileIdentity(args.profiles, profile.id, () => true)
    // Removal happens after a new launch, using only persisted metadata.
    const retired = (await args.profiles.loadServerProfiles()).profiles[0]!
    expect(offlineProfileStatus(retired)).toBeUndefined()
    const erase = vi.fn(async (_principal: string) => {})
    await removeServerProfile({ ...args, profile: retired, erasePrincipal: erase })
    expect(erase).toHaveBeenCalledExactlyOnceWith(ALICE)
    expect(args.credentials.remove).toHaveBeenCalledExactlyOnceWith(profile.id)
    expect(await args.profiles.loadPendingProfileCleanups()).toEqual([])
    expect(await args.profiles.loadServerProfiles()).toEqual({
      profiles: [],
      activeProfileId: null,
    })
  })

  it('never reads the saved credential from a replacement server', async () => {
    const args = await activation()
    await expect(
      activateServerProfile({
        ...args,
        preflight: async () => ({
          ok: true,
          httpOrigin: profile.httpOrigin,
          instanceId: 'replacement',
          appVersion: '1',
          mode: 'protected',
          transport: 'trusted-https',
        }),
      }),
    ).rejects.toThrow('replaced')
    expect(args.credentials.get).not.toHaveBeenCalled()
  })

  it('opens a trusted offline profile without releasing its bearer', async () => {
    const args = await activation()
    const opened = await activateServerProfile({
      ...args,
      preflight: async () => ({
        ok: false,
        kind: 'unreachable',
        title: 'offline',
        detail: 'offline',
        transport: 'trusted-https',
      }),
    })
    expect(opened).toMatchObject({ bearer: null, activation: 'offline-cache' })
    expect(args.credentials.get).not.toHaveBeenCalled()
  })

  it('compensates a selection write when its owner changes while persistence is pending', async () => {
    const args = await activation()
    const originalSave = args.profiles.saveServerProfiles
    let current = true
    args.profiles.saveServerProfiles = async (state) => {
      await originalSave(state)
      current = false
    }
    await expect(
      activateServerProfile({
        ...args,
        isCurrent: () => current,
        preflight: async () => ({
          ok: true,
          httpOrigin: profile.httpOrigin,
          instanceId: profile.instanceId!,
          appVersion: '1',
          mode: 'protected',
          transport: 'trusted-https',
        }),
      }),
    ).rejects.toThrow('no longer active')
    expect((await args.profiles.loadServerProfiles()).profiles).toEqual([profile])
  })

  it('hides a removed profile and preserves its cleanup intent when erasure fails', async () => {
    const args = await activation()
    const erase = vi
      .fn()
      .mockRejectedValueOnce(new Error('disk unavailable'))
      .mockResolvedValue(undefined)
    await expect(removeServerProfile({ ...args, erasePrincipal: erase })).rejects.toThrow(
      'disk unavailable',
    )
    expect(await args.profiles.loadServerProfiles()).toEqual({
      profiles: [],
      activeProfileId: null,
    })
    expect(await args.profiles.loadPendingProfileCleanups()).toMatchObject([
      { principal: ALICE, profileId: profile.id },
    ])
    await drainProfileCleanups({ ...args, erasePrincipal: erase })
    expect(await args.profiles.loadPendingProfileCleanups()).toEqual([])
    expect(args.credentials.remove).toHaveBeenCalledTimes(2)
  })

  it('keeps the old profile and credential reachable if the cleanup journal cannot be written', async () => {
    const { storage } = metadata()
    const profiles = createServerProfiles({ storage })
    await profiles.saveServerProfiles({ activeProfileId: profile.id, profiles: [profile] })
    const credentials = nativeCredentials()
    storage.setItem = async () => {
      throw new Error('journal unavailable')
    }
    await expect(removeServerProfile({ profile, profiles, credentials })).rejects.toThrow(
      'journal unavailable',
    )
    expect((await profiles.loadServerProfiles()).profiles).toEqual([profile])
    expect(credentials.remove).not.toHaveBeenCalled()
  })

  it('erases only the removed principal’s side cache and entity rows', async () => {
    const values = new Map([
      [principalKeyPrefix('replica', ALICE) + '.cursor', 'a'],
      [principalKeyPrefix('replica', BOB) + '.cursor', 'b'],
    ])
    const eraseEntities = vi.fn(async () => {})
    await eraseAccountData({
      principal: ALICE,
      basePrefix: 'replica',
      enumerateKeys: () => [...values.keys()],
      eraseEntities,
      storage: {
        getItem: (key) => values.get(key) ?? null,
        setItem: (key, value) => {
          values.set(key, value)
        },
        removeItem: (key) => {
          values.delete(key)
        },
      },
    })
    expect([...values.values()]).toEqual(['b'])
    expect(eraseEntities).toHaveBeenCalledWith(ALICE)
  })

  it('erases a cookie account before binding a different account to the hidden profile', async () => {
    const { storage } = metadata()
    const erase = vi.fn(async () => {})
    const accounts = createSingleServerAccounts({
      httpOrigin: 'http://localhost:8799',
      metadataPrefix: 'browser',
      storage,
      erasePrincipal: erase,
    })
    await accounts.recordPrincipal(ALICE)
    await accounts.recordPrincipal(BOB)
    expect(erase).toHaveBeenCalledWith(ALICE)
    expect((await accounts.profiles.loadServerProfiles()).profiles).toMatchObject([
      { memberId: 'bob' },
    ])
    await accounts.remove()
    expect(erase).toHaveBeenLastCalledWith(BOB)
    expect((await accounts.profiles.loadServerProfiles()).profiles).toEqual([])
  })

  it('waits for a closing replica before erasing its persisted namespace', async () => {
    let closed!: () => void
    const closing = new Promise<void>((resolve) => {
      closed = resolve
    })
    const fallback = vi.fn(async () => {})
    const erasePrincipalData = vi.fn(async () => {})
    const registry = createAccountEraser(fallback)
    const owner = registry.register(ALICE, { erasePrincipalData, dispose: () => closing })
    await registry.erase(ALICE)
    expect(erasePrincipalData).toHaveBeenCalledOnce()
    const disposal = owner.dispose()
    const erasure = registry.erase(ALICE)
    expect(fallback).not.toHaveBeenCalled()
    closed()
    await Promise.all([disposal, erasure])
    expect(fallback).toHaveBeenCalledWith(ALICE)
  })
})
