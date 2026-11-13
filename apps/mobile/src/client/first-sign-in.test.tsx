/**
 * A PROFILE WRITE AFTER THE PHONE SIGNS IN (POD-6913).
 *
 * Right after a sign-in the native gate writes the saved profile while the
 * app is already on screen: the live socket connects and the follow observer
 * saves the server's installation identity (`saveServerIdentity`). The gate
 * then rebuilds its whole context value, so every callback in it,
 * `updateCredential` included, gets a new identity. The live provider used to
 * fold that identity into the store's tRPC client, so StoreProvider saw a new
 * `api` for the replica it had already opened. It tore the signed-in runtime
 * down during render (React: "Cannot update a component (IssuesScreen) while
 * rendering a different component (StoreProvider)") and built a second one
 * over the same assembly, whose kernel outbox factory may be consumed only
 * once. The release build died with "kernel engine Outbox factory may only be
 * consumed once". The browser build never writes that profile, so it never
 * crashed.
 *
 * The provider here is the production one over a real SQLite file, as in
 * refused-member.test. The gate is a stub with the native gate's shape: one
 * memo over the profile state, so a profile write replaces every callback.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SqlDatabaseLike } from '@podium/sync/adapters/mobile-sqlite'
import { act, cleanup, render, screen } from '@testing-library/react'
import {
  Component,
  createContext,
  type ReactNode,
  StrictMode,
  useContext,
  useMemo,
  useState,
} from 'react'
import { Platform } from 'react-native'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AuthStatus } from './auth'

const state = vi.hoisted(() => ({
  device: new Map<string, string>(),
  sqliteFile: '',
  // biome-ignore lint/suspicious/noExplicitAny: the stubbed gate's context, set per test
  ProfileContext: null as any,
  // biome-ignore lint/suspicious/noExplicitAny: the stub gate's current context value
  gate: null as any,
}))

vi.mock('@react-native-async-storage/async-storage', () => ({
  default: {
    getAllKeys: async () => [...state.device.keys()],
    getItem: async (key: string) => state.device.get(key) ?? null,
    setItem: async (key: string, value: string) => void state.device.set(key, value),
    removeItem: async (key: string) => {
      state.device.delete(key)
    },
  },
}))
vi.mock('./ServerProfileGate', () => ({
  useOptionalServerProfile: () => useContext(state.ProfileContext),
}))
vi.mock('./MobileSyncBoundary', () => ({
  MobileSyncBoundary: ({ children }: { children: ReactNode }) => children,
}))
vi.mock('./mobile-entity-store', async () => {
  const { SqliteSyncStore } = await import('@podium/sync/adapters/mobile-sqlite')
  const open = await realSqlite()
  return {
    openMobileEntityStore: () =>
      SqliteSyncStore.open({
        openDatabase: () => open(state.sqliteFile),
        deleteDatabase: () => {},
        onDegraded: () => {},
      }),
  }
})
async function realSqlite(): Promise<(file: string) => SqlDatabaseLike> {
  for (const [specifier, exportName] of [
    ['bun:sqlite', 'Database'],
    ['node:sqlite', 'DatabaseSync'],
  ] as const) {
    try {
      const module = (await import(/* @vite-ignore */ specifier)) as Record<string, unknown>
      const Database = module[exportName] as (new (file: string) => SqlDatabaseLike) | undefined
      if (typeof Database === 'function') return (file) => new Database(file)
    } catch {}
  }
  throw new Error('no real SQLite in this runtime')
}

class SilentSocket {
  readyState = 0
  send(): void {}
  close(): void {}
  addEventListener(): void {}
  removeEventListener(): void {}
}

const alice: AuthStatus = {
  needsAuth: true,
  authed: true,
  userId: 'user-alice',
  memberId: 'alice',
  syncBoundaryId: 'boundary-a',
} as AuthStatus

class RenderErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null }
  static getDerivedStateFromError(error: Error) {
    return { error }
  }
  render() {
    return this.state.error ? (
      <div data-testid="render-error">{this.state.error.message}</div>
    ) : (
      this.props.children
    )
  }
}

/**
 * Boots the live provider for a profile that has not saved its server's
 * identity yet, then lets that identity arrive as the connected socket
 * delivers it. `memberRecorded: false` is a first sign-in: the boot records
 * the member, which writes the profile and re-runs the boot once before paint.
 */
async function bootSignedIn(options: { memberRecorded: boolean; strict?: boolean }) {
  vi.resetModules()
  state.ProfileContext = createContext(null)
  const [{ MobileClientProvider }, { AuthStatusContext }, { readServerConfig }] = await Promise.all(
    [import('./MobileClientProvider'), import('./auth-context'), import('./trpc')],
  )
  const config = { ...readServerConfig(), httpOrigin: 'https://podium.test' }
  const recorded: string[] = []
  function StubGate({ children }: { children: ReactNode }) {
    const [profile, setProfile] = useState({
      id: 'profile-a',
      httpOrigin: 'https://podium.test',
      ...(options.memberRecorded
        ? { userId: 'alice', syncBoundaryId: 'boundary-a', memberId: 'alice' }
        : {}),
    } as Record<string, unknown>)
    // As in ServerProfileGate: one memo over the profile state, so every
    // profile write hands out new callbacks.
    const value = useMemo(
      () => ({
        profile,
        profiles: [profile],
        config,
        bearer: 'alice-bearer',
        activation: 'verified',
        runtimeKey: 'profile-a',
        isEphemeralOverride: false,
        updateCredential: async () => {},
        recordUser: async (userId: string, identity: Record<string, string>) => {
          recorded.push(userId)
          if (profile.memberId === identity.memberId) return
          setProfile({ ...profile, userId, ...identity })
        },
        revalidateOfflineProfile: async () => {},
        // What the follow observer calls once the live socket has connected.
        saveServerIdentity: async (identity: Record<string, string>) => {
          setProfile((current) => ({ ...current, ...identity }))
        },
      }),
      [profile],
    )
    state.gate = value
    return <state.ProfileContext.Provider value={value}>{children}</state.ProfileContext.Provider>
  }
  const tree = (
    <RenderErrorBoundary>
      <StubGate>
        <AuthStatusContext.Provider value={alice}>
          <MobileClientProvider>
            <div data-testid="app">app</div>
          </MobileClientProvider>
        </AuthStatusContext.Provider>
      </StubGate>
    </RenderErrorBoundary>
  )
  render(options.strict ? <StrictMode>{tree}</StrictMode> : tree)
  await screen.findByTestId('app', undefined, { timeout: 10_000 })
  // The boot settles first (recording a new member re-runs it once).
  await act(() => new Promise((resolve) => setTimeout(resolve, 500)))
  // The socket connected: the server's identity lands on the saved profile
  // while the signed-in app is on screen.
  await act(async () => {
    await state.gate.saveServerIdentity({
      installationId: 'installation-1',
      installationPublicKey: 'key-1',
    })
  })
  await act(() => new Promise((resolve) => setTimeout(resolve, 100)))
  return { recorded }
}

let dir = ''
let consoleErrors: string[] = []
let originalOS: string
beforeEach(() => {
  originalOS = Platform.OS
  ;(Platform as { OS: string }).OS = 'android'
  ;(globalThis as { WebSocket?: unknown }).WebSocket = SilentSocket
  vi.stubGlobal('fetch', async () => {
    throw new Error('offline in this test')
  })
  consoleErrors = []
  const error = console.error
  vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
    consoleErrors.push(args.map(String).join(' '))
    error(...args)
  })
  dir = mkdtempSync(join(tmpdir(), 'first-sign-in-'))
  state.sqliteFile = join(dir, 'replica.db')
  state.device.clear()
})
afterEach(async () => {
  cleanup()
  await act(() => new Promise((resolve) => setTimeout(resolve, 20)))
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  ;(Platform as { OS: string }).OS = originalOS
  rmSync(dir, { recursive: true, force: true })
})

describe('a profile write after the phone signs in (POD-6913)', () => {
  it.each([
    ['a profile that already names its member', true],
    ['a first sign-in that records the member', false],
  ] as const)('keeps the signed-in app for %s', async (_, memberRecorded) => {
    const { recorded } = await bootSignedIn({ memberRecorded })
    expect(recorded).toContain('alice')
    expect(screen.queryByTestId('render-error')).toBeNull()
    expect(screen.getByTestId('app')).toBeTruthy()
    expect(consoleErrors.filter((line) => line.includes('Cannot update a component'))).toEqual([])
  })

  it('boots once under StrictMode double render and effect replay', async () => {
    await bootSignedIn({ memberRecorded: false, strict: true })
    expect(screen.queryByTestId('render-error')).toBeNull()
    expect(screen.getByTestId('app')).toBeTruthy()
  })
})
