/**
 * THE SERVER REFUSED THIS MEMBER, ON THE PHONE (POD-6297, the phone's half of
 * POD-6293; design §4.5).
 *
 * Alice was disabled, removed or signed out everywhere. The phone's live
 * provider learns it as an expired credential. Her stored data must be erased
 * before the credential is dropped (which is what shows the sign-in again), and
 * only hers: Bob's namespace on the same device stays.
 *
 * The provider is the production one, booted over a real SQLite file and the
 * AsyncStorage bridge, as in mobile-pool.test. The saved server profile is a
 * stub carrying a bearer and an observed `updateCredential`; the refusal is the
 * server answering 401 to the phone's own requests.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { principalKeyPrefix, REPLICA_KEY_PREFIX } from '@podium/client-core/replica'
import type { SqlDatabaseLike } from '@podium/sync/adapters/mobile-sqlite'
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { Platform } from 'react-native'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AuthStatus } from './auth'
import { discardRefusedMember, refusedPrincipal } from './refused-member'

const state = vi.hoisted(() => ({
  device: new Map<string, string>(),
  sqliteFile: '',
  profile: null as unknown,
  events: [] as string[],
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
vi.mock('./ServerProfileGate', () => ({ useOptionalServerProfile: () => state.profile }))
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

const ALICE = JSON.stringify(['boundary-a', 'alice'])
const BOB = JSON.stringify(['boundary-a', 'bob'])
const aliceKey = `${principalKeyPrefix(REPLICA_KEY_PREFIX, ALICE)}.probe`
const bobKey = `${principalKeyPrefix(REPLICA_KEY_PREFIX, BOB)}.probe`

const alice: AuthStatus = {
  needsAuth: true,
  authed: true,
  userId: 'user-alice',
  memberId: 'alice',
  syncBoundaryId: 'boundary-a',
} as AuthStatus

async function bootAsAlice() {
  vi.resetModules()
  const [{ MobileClientProvider }, { AuthStatusContext }, { readServerConfig }] = await Promise.all(
    [import('./MobileClientProvider'), import('./auth-context'), import('./trpc')],
  )
  const updateCredential = vi.fn(async (token: string | null) => {
    state.events.push(`credential:${token}`)
  })
  state.profile = {
    profile: {
      id: 'profile-a',
      httpOrigin: 'https://podium.test',
      syncBoundaryId: 'boundary-a',
      memberId: 'alice',
      userId: 'user-alice',
    },
    profiles: [],
    config: { ...readServerConfig(), httpOrigin: 'https://podium.test' },
    bearer: 'alice-bearer',
    activation: 'verified',
    runtimeKey: 'profile-a',
    isEphemeralOverride: false,
    updateCredential,
    recordUser: async () => {},
    revalidateOfflineProfile: async () => {},
  }
  render(
    <AuthStatusContext.Provider value={alice}>
      <MobileClientProvider>
        <div data-testid="app">app</div>
      </MobileClientProvider>
    </AuthStatusContext.Provider>,
  )
  await screen.findByTestId('app', undefined, { timeout: 10_000 })
  return { updateCredential }
}

/** Every request is refused as unauthorized from here on. */
let refused = false
const refuse = () => {
  refused = true
}

let dir = ''
beforeEach(() => {
  refused = false
  ;(globalThis as { WebSocket?: unknown }).WebSocket = SilentSocket
  vi.stubGlobal('fetch', async () => {
    if (refused) return new Response('{"error":"unauthorized"}', { status: 401 })
    throw new Error('offline in this test')
  })
  dir = mkdtempSync(join(tmpdir(), 'refused-member-'))
  state.sqliteFile = join(dir, 'replica.db')
  state.device.clear()
  state.events.length = 0
})
afterEach(async () => {
  cleanup()
  await act(() => new Promise((resolve) => setTimeout(resolve, 20)))
  vi.unstubAllGlobals()
  rmSync(dir, { recursive: true, force: true })
})

describe('a refused member on the phone (POD-6297)', () => {
  it.each([
    ['phone', 'ios'],
    ['browser build', 'web'],
  ] as const)("the %s erases the refused member's stored data before the sign-in shows", async (_, os) => {
    const originalOS = Platform.OS
    ;(Platform as { OS: string }).OS = os
    try {
      state.device.set(aliceKey, 'alice data')
      state.device.set(bobKey, 'bob data')
      const { updateCredential } = await bootAsAlice()
      const removeItem = state.device.delete.bind(state.device)
      state.device.delete = (key: string) => {
        if (key === aliceKey) state.events.push('erased:alice')
        return removeItem(key)
      }
      // The server now refuses Alice's credential on every request.
      await act(async () => {
        refuse()
      })
      await waitFor(() => expect(updateCredential).toHaveBeenCalledWith(null), { timeout: 15_000 })
      expect(state.device.has(aliceKey)).toBe(false)
      expect(state.device.get(bobKey)).toBe('bob data')
      expect(state.events.indexOf('erased:alice')).toBeGreaterThanOrEqual(0)
      expect(state.events.indexOf('erased:alice')).toBeLessThan(
        state.events.indexOf('credential:null'),
      )
    } finally {
      ;(Platform as { OS: string }).OS = originalOS
    }
  })
})

describe('discardRefusedMember', () => {
  const run = (over: Partial<Parameters<typeof discardRefusedMember>[0]> = {}) => {
    const events: string[] = []
    const args = {
      principal: ALICE,
      web: false,
      erase: vi.fn(async (p: string) => void events.push(`erase:${p}`)),
      removeWebPrincipal: vi.fn(async (p: string) => void events.push(`remove:${p}`)),
      clearCredential: vi.fn(async () => void events.push('credential')),
      report: vi.fn(),
      ...over,
    }
    return { args, events, done: discardRefusedMember(args) }
  }

  it('drops the credential even when the erase fails, and reports the failure', async () => {
    const failure = new Error('disk busy')
    const { args, done } = run({ erase: vi.fn(async () => Promise.reject(failure)) })
    await done
    expect(args.report).toHaveBeenCalledWith(failure)
    expect(args.clearCredential).toHaveBeenCalledOnce()
  })

  it('with no known member still drops the credential and erases nothing', async () => {
    const { args, done } = run({ principal: undefined })
    await done
    expect(args.erase).not.toHaveBeenCalled()
    expect(args.clearCredential).toHaveBeenCalledOnce()
  })

  it('names the member from the open replica, else from the saved profile', () => {
    expect(refusedPrincipal(ALICE, { syncBoundaryId: 'boundary-a', memberId: 'bob' })).toBe(ALICE)
    expect(refusedPrincipal(undefined, { syncBoundaryId: 'boundary-a', memberId: 'bob' })).toBe(BOB)
    expect(refusedPrincipal('legacy-user', undefined)).toBeUndefined()
  })
})
