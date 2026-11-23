/** Fresh native setup through the real gates, replica and single-use outbox. */
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { useClientRuntime } from '@podium/client-core/react'
import { asUserId } from '@podium/model'
import { CLIENT_WIRE_VERSION } from '@podium/protocol'
import type { SqlDatabaseLike } from '@podium/sync/adapters/mobile-sqlite'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { Component, type ReactNode } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const device = vi.hoisted(() => ({
  metadata: new Map<string, string>(),
  keychain: new Map<string, string>(),
  database: '',
  protected: false,
  failures: [] as Error[],
  runtimes: new Set<unknown>(),
}))

vi.mock('@react-native-async-storage/async-storage', () => ({
  default: {
    getAllKeys: async () => [...device.metadata.keys()],
    getItem: async (key: string) => device.metadata.get(key) ?? null,
    setItem: async (key: string, value: string) => void device.metadata.set(key, value),
    removeItem: async (key: string) => void device.metadata.delete(key),
  },
}))
vi.mock('expo-secure-store', () => ({
  WHEN_UNLOCKED_THIS_DEVICE_ONLY: 'unlocked',
  getItemAsync: async (key: string) => device.keychain.get(key) ?? null,
  setItemAsync: async (key: string, value: string) => void device.keychain.set(key, value),
  deleteItemAsync: async (key: string) => void device.keychain.delete(key),
}))
vi.mock('./profile-credentials', () => vi.importActual('./profile-credentials.native'))
vi.mock('react-native', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-native')>()
  return {
    ...actual,
    Platform: { ...actual.Platform, OS: 'ios' },
    AccessibilityInfo: { ...actual.AccessibilityInfo, announceForAccessibility: vi.fn() },
    Linking: {
      getInitialURL: async () => null,
      addEventListener: () => ({ remove: vi.fn() }),
    },
    TextInput: ({
      accessibilityLabel,
      onChangeText,
      placeholder,
      value,
    }: {
      accessibilityLabel?: string
      onChangeText?(value: string): void
      placeholder?: string
      value?: string
    }) => (
      <input
        aria-label={accessibilityLabel}
        placeholder={placeholder}
        value={value}
        onChange={(event) => onChangeText?.(event.currentTarget.value)}
      />
    ),
  }
})
vi.mock('expo-router', () => ({ router: { replace: vi.fn() } }))
vi.mock('expo-crypto', () => ({}))
vi.mock('expo-haptics', () => ({
  notificationAsync: async () => {},
  NotificationFeedbackType: { Success: 'success' },
}))
vi.mock('./hosted-sign-in-runtime', () => ({
  hostedSignIn: { begin: vi.fn(), cancel: async () => {} },
}))
vi.mock('../components/PairingScanner', () => ({ PairingScanner: () => null }))
vi.mock('../components/KeyboardAvoidingRoot', () => ({
  KeyboardAvoidingRoot: ({ children }: { children: ReactNode }) => children,
}))
vi.mock('../components/PressableScale', () => ({
  PressableScale: ({
    accessibilityLabel,
    children,
    disabled,
    onPress,
  }: {
    accessibilityLabel?: string
    children?: ReactNode
    disabled?: boolean
    onPress?(): void
  }) => (
    <button type="button" aria-label={accessibilityLabel} disabled={disabled} onClick={onPress}>
      {children}
    </button>
  ),
}))
// The test server supplies authentication, not a sync stream. Keep the actual
// store mounted so its real outbox enforces the single-consumer contract.
vi.mock('./MobileSyncBoundary', () => ({
  MobileSyncBoundary: ({ children }: { children: ReactNode }) => children,
}))
vi.mock('./mobile-entity-store', async () => {
  const { SqliteSyncStore } = await import('@podium/sync/adapters/mobile-sqlite')
  const open = await sqlite()
  return {
    openMobileEntityStore: () =>
      SqliteSyncStore.open({
        openDatabase: () => open(device.database),
        deleteDatabase: () => {},
        onDegraded: () => {},
      }),
  }
})

async function sqlite(): Promise<(file: string) => SqlDatabaseLike> {
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
  throw new Error('No SQLite engine is available for the first-sign-in regression')
}

import { AuthGate } from './AuthGate'
import { AuthStatusContext } from './auth-context'
import { MobileClientProvider } from './MobileClientProvider'
import { resetInitialNativeLinkConsumptionForTests, ServerProfileGate } from './ServerProfileGate'
import { ServerProfileContext, type ServerProfileContextValue } from './server-profile-context'
import { loadServerProfiles } from './server-profiles'
import { setActiveServerRuntime } from './trpc'

class SilentSocket {
  readyState = 0
  send(): void {}
  close(): void {}
  addEventListener(): void {}
  removeEventListener(): void {}
}

class FailureBoundary extends Component<{ children: ReactNode }, { failure: Error | null }> {
  state = { failure: null as Error | null }
  static getDerivedStateFromError(failure: Error) {
    return { failure }
  }
  componentDidCatch(failure: Error) {
    device.failures.push(failure)
  }
  render() {
    return this.state.failure ? (
      <div role="alert">{this.state.failure.message}</div>
    ) : (
      this.props.children
    )
  }
}

function Work() {
  device.runtimes.add(useClientRuntime())
  return <div data-testid="work">Work</div>
}

let directory = ''
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'mobile-first-sign-in-'))
  device.database = join(directory, 'replica.db')
  device.metadata.clear()
  device.keychain.clear()
  device.failures.length = 0
  device.runtimes.clear()
  resetInitialNativeLinkConsumptionForTests()
  setActiveServerRuntime(undefined, null)
  vi.stubGlobal('WebSocket', SilentSocket)
  vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input))
    if (url.pathname === '/version') {
      return Response.json({
        wireVersion: CLIENT_WIRE_VERSION,
        minSupportedVersion: CLIENT_WIRE_VERSION,
        instanceId: 'fresh-server',
      })
    }
    if (url.pathname === '/auth/status') {
      const authed =
        !device.protected ||
        new Headers(init?.headers).get('Authorization') === 'Bearer first-token'
      return Response.json({
        needsAuth: device.protected,
        authed,
        userId: authed ? 'first-member' : null,
        ...(authed ? { memberId: 'first-member', syncBoundaryId: 'fresh-boundary' } : {}),
      })
    }
    if (url.pathname === '/auth/login') {
      return Response.json({
        ok: true,
        delivery: 'native',
        token: 'first-token',
        userId: 'first-member',
        expiresAt: '2099-01-01T00:00:00.000Z',
      })
    }
    throw new Error('No sync server in the first-sign-in test')
  })
})
afterEach(async () => {
  cleanup()
  await act(() => new Promise((resolve) => setTimeout(resolve, 20)))
  setActiveServerRuntime(undefined, null)
  vi.unstubAllGlobals()
  rmSync(directory, { recursive: true, force: true })
})

it.each([
  'open',
  'protected',
] as const)('opens Work on the first %s sign-in with empty native storage and no outbox double-consumption', async (mode) => {
  device.protected = mode === 'protected'
  expect(device.metadata.size).toBe(0)
  expect(device.keychain.size).toBe(0)
  expect(existsSync(device.database)).toBe(false)
  render(
    <FailureBoundary>
      <ServerProfileGate>
        <AuthGate>
          <MobileClientProvider>
            <Work />
          </MobileClientProvider>
        </AuthGate>
      </ServerProfileGate>
    </FailureBoundary>,
  )
  fireEvent.click(await screen.findByLabelText('Enter server address'))
  fireEvent.change(screen.getByPlaceholderText('https://podium.example'), {
    target: { value: 'https://first.example' },
  })
  fireEvent.click(screen.getByLabelText('Check server'))
  fireEvent.click(await screen.findByLabelText('Connect'))
  if (device.protected) {
    fireEvent.change(await screen.findByLabelText('Password'), { target: { value: 'test-only' } })
    fireEvent.click(screen.getByLabelText('Log in'))
  }
  expect(await screen.findByTestId('work', undefined, { timeout: 10_000 })).toBeTruthy()
  await waitFor(async () => {
    const stored = await loadServerProfiles()
    expect(stored.profiles).toHaveLength(1)
    expect(stored.profiles[0]).toMatchObject({
      userId: 'first-member',
      memberId: 'first-member',
      syncBoundaryId: 'fresh-boundary',
    })
  })
  // Recording the principal updates the gate and rechecks auth. Let those
  // updates commit before judging whether the first store survived.
  await act(() => new Promise((resolve) => setTimeout(resolve, 20)))
  expect(screen.getByTestId('work')).toBeTruthy()
  expect(device.failures).toEqual([])
  expect([...device.keychain.values()]).toEqual(device.protected ? ['first-token'] : [])
})

it('opens a new outbox when the first bearer reaches an already-booted clean profile', async () => {
  device.protected = true
  const noOperation = async () => {}
  const profile: ServerProfileContextValue = {
    profile: {
      id: 'first-profile',
      name: 'First server',
      httpOrigin: 'https://first.example',
      mode: 'protected',
      transport: 'trusted-https',
      createdAt: '2026-11-13T00:00:00.000Z',
      updatedAt: '2026-11-13T00:00:00.000Z',
    },
    profiles: [],
    config: {
      httpOrigin: 'https://first.example',
      wsClientUrl: 'wss://first.example/client',
      override: false,
    },
    bearer: null,
    activation: 'verified',
    runtimeKey: 'first-profile:0',
    isEphemeralOverride: false,
    beginAddServer: () => {},
    switchProfile: noOperation,
    renameProfile: noOperation,
    removeProfile: noOperation,
    updateCredential: noOperation,
    recordUser: noOperation,
    revalidateOfflineProfile: noOperation,
  }
  const status = {
    needsAuth: true,
    authed: true,
    userId: asUserId('first-member'),
    memberId: 'first-member',
    syncBoundaryId: 'fresh-boundary',
  }
  setActiveServerRuntime(profile.config, null)
  const tree = (bearer: string | null) => (
    <FailureBoundary>
      <ServerProfileContext.Provider value={{ ...profile, bearer }}>
        <AuthStatusContext.Provider value={status}>
          <MobileClientProvider>
            <Work />
          </MobileClientProvider>
        </AuthStatusContext.Provider>
      </ServerProfileContext.Provider>
    </FailureBoundary>
  )
  expect(existsSync(device.database)).toBe(false)
  const view = render(tree(null))
  await screen.findByTestId('work', undefined, { timeout: 10_000 })
  expect(device.runtimes.size).toBe(1)

  // Native credential publication can replace the API while React still
  // holds the first replica. The old outbox must never see that new API.
  view.rerender(tree('first-token'))
  await waitFor(() => expect(device.runtimes.size).toBe(2))
  expect(screen.getByTestId('work')).toBeTruthy()
  expect(device.failures).toEqual([])
})
