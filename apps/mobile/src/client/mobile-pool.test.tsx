/**
 * THE MOBILE POOL SWITCH ON THE REAL MOBILE PATH (POD-4976).
 *
 * Every case boots the production `MobileClientProvider`: the AsyncStorage
 * bridge, the shared replica assembly over a real SQLite file, the outbox and
 * the StoreProvider. Only the platform edges are replaced (AsyncStorage's native
 * module, the IndexedDB/SQLite engine choice, the socket and the network) and
 * the cold-sync loading boundary. An
 * "app restart" is a fresh module graph over the SAME storage, because the
 * switch latches once per app load.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ClientRuntime } from '@podium/client-core/engine'
import { MOBX_SIDEBAR_KEY } from '@podium/client-core/ui-state'
import type { SqlDatabaseLike } from '@podium/sync/adapters/mobile-sqlite'
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AuthStatus } from './auth'

const state = vi.hoisted(() => ({
  device: new Map<string, string>(),
  sqliteFile: '',
  /** Every pool the shared host built, with the runtime it was built over. */
  pools: [] as { runtime: unknown; disposed: boolean }[],
}))

vi.mock('@react-native-async-storage/async-storage', () => ({
  default: {
    getAllKeys: async () => [...state.device.keys()],
    getItem: async (key: string) => state.device.get(key) ?? null,
    setItem: async (key: string, value: string) => void state.device.set(key, value),
    removeItem: async (key: string) => void state.device.delete(key),
  },
}))
vi.mock('./ServerProfileGate', () => ({ useOptionalServerProfile: () => null }))
// A fresh replica is cold and this boundary holds routes back until a first
// network sync, which these offline cases never reach. It gates painting only.
vi.mock('./MobileSyncBoundary', () => ({
  MobileSyncBoundary: ({ children }: { children: ReactNode }) => children,
}))
// The engine choice is a platform edge (IndexedDB on web, SQLite on a phone).
// A real SQLite FILE keeps the replica's rows across a modelled restart.
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
// The REAL graph pool over the provider's runtime, observed at its one door.
vi.mock('../../../../packages/client-graph/src/runtime-pool', async (importOriginal) => {
  const real =
    await importOriginal<typeof import('../../../../packages/client-graph/src/runtime-pool')>()
  return {
    ...real,
    createRuntimeWorklistPool: (...args: Parameters<typeof real.createRuntimeWorklistPool>) => {
      const handle = real.createRuntimeWorklistPool(...args)
      const record = { runtime: args[0], disposed: false }
      state.pools.push(record)
      return {
        pool: handle.pool,
        dispose: () => {
          record.disposed = true
          handle.dispose()
        },
      }
    },
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

const status = (member: string): AuthStatus =>
  ({
    needsAuth: true,
    authed: true,
    userId: `user-${member}`,
    memberId: member,
    syncBoundaryId: 'boundary-a',
  }) as AuthStatus

/** One app load: a fresh module graph (a fresh latch) over the device's storage. */
async function launch() {
  vi.resetModules()
  // Everything that holds a React context or the latch comes from the new graph.
  const [
    { MobileClientProvider },
    { useMobilePool, mobileDataLayer },
    { AuthStatusContext },
    { useStoreHandle },
  ] = await Promise.all([
    import('./MobileClientProvider'),
    import('./mobile-pool'),
    import('./auth-context'),
    import('@podium/client-core/react'),
  ])
  const seen: { runtime?: ClientRuntime; pool?: unknown } = {}
  function Probe() {
    seen.runtime = useStoreHandle() as unknown as ClientRuntime
    seen.pool = useMobilePool()
    return <div data-testid="app">{seen.pool ? 'pool' : 'no pool'}</div>
  }
  const tree = (who: AuthStatus): ReactNode => (
    <AuthStatusContext.Provider value={who}>
      <MobileClientProvider>
        <Probe />
      </MobileClientProvider>
    </AuthStatusContext.Provider>
  )
  const view = render(tree(status('alice')))
  await screen.findByTestId('app', undefined, { timeout: 10_000 })
  return {
    seen,
    layer: mobileDataLayer,
    switchUser: async (member: string) => {
      const before = seen.runtime
      view.rerender(tree(status(member)))
      await waitFor(() => expect(seen.runtime).not.toBe(before))
    },
    quit: async () => {
      view.unmount()
      await settle()
    },
  }
}

const settle = () => act(() => new Promise((resolve) => setTimeout(resolve, 20)))

/** "Nothing was built" means nothing even after the lazy graph import could
 * have landed: load that module in this app's graph first, then let any
 * waiting pool construction run. */
async function graphSettled() {
  await act(async () => {
    await import('../../../../packages/client-graph/src/runtime-pool')
  })
  await settle()
}

/** What the Settings toggle does: write the device setting through UI state. */
function toggleSetting(runtime: ClientRuntime | undefined, on: boolean): void {
  if (!runtime) throw new Error('the app has no signed-in store')
  act(() => runtime.ui.set(MOBX_SIDEBAR_KEY, on ? '1' : '0'))
}

let dir = ''
beforeEach(() => {
  ;(globalThis as { WebSocket?: unknown }).WebSocket = SilentSocket
  vi.stubGlobal('fetch', async () => {
    throw new Error('offline in this test')
  })
  dir = mkdtempSync(join(tmpdir(), 'mobile-pool-'))
  state.sqliteFile = join(dir, 'replica.db')
  state.device.clear()
  state.pools.length = 0
})
afterEach(async () => {
  cleanup()
  vi.unstubAllGlobals()
  rmSync(dir, { recursive: true, force: true })
})

describe('mobile pool switch', () => {
  it('is off by default: the app runs with no pool and no graph built', async () => {
    const app = await launch()
    await graphSettled()
    expect(app.layer()).toBe('legacy')
    expect(app.seen.pool).toBeNull()
    expect(screen.getByTestId('app').textContent).toBe('no pool')
    expect(state.pools).toEqual([])
    await app.quit()
  })

  it('applies the saved setting at the next start, not under the running app', async () => {
    const first = await launch()
    toggleSetting(first.seen.runtime, true)
    await graphSettled()
    // Read once: the running app keeps its startup choice.
    expect(first.layer()).toBe('legacy')
    expect(state.pools).toEqual([])
    await first.quit()

    const second = await launch()
    await waitFor(() => expect(second.seen.pool).toBeTruthy())
    expect(second.layer()).toBe('pool')
    // ONE pool, built over the provider's own runtime (and so its replica).
    expect(state.pools).toEqual([{ runtime: second.seen.runtime, disposed: false }])
    expect(screen.getByTestId('app').textContent).toBe('pool')

    // Turning it off is likewise a next-start change.
    toggleSetting(second.seen.runtime, false)
    await settle()
    expect(second.layer()).toBe('pool')
    expect(state.pools.map((pool) => pool.disposed)).toEqual([false])
    await second.quit()
    expect(state.pools.map((pool) => pool.disposed)).toEqual([true])

    const third = await launch()
    await graphSettled()
    expect(third.layer()).toBe('legacy')
    expect(state.pools).toHaveLength(1)
    await third.quit()
  })

  it('disposes the pool with the signed-in user and rebuilds it for the next one', async () => {
    const first = await launch()
    toggleSetting(first.seen.runtime, true)
    await first.quit()

    const app = await launch()
    await waitFor(() => expect(app.seen.pool).toBeTruthy())
    const alice = { runtime: app.seen.runtime, pool: app.seen.pool }

    // Bob has never turned the setting on; the app load keeps its choice.
    await app.switchUser('bob')
    await waitFor(() => expect(app.seen.pool).toBeTruthy())
    expect(app.layer()).toBe('pool')
    expect(state.pools).toHaveLength(2)
    expect(state.pools[0]).toEqual({ runtime: alice.runtime, disposed: true })
    expect(state.pools[1]).toEqual({ runtime: app.seen.runtime, disposed: false })
    expect(app.seen.pool).not.toBe(alice.pool)

    // Sign-out unmounts the signed-in store and takes the pool with it.
    await app.quit()
    expect(state.pools.map((pool) => pool.disposed)).toEqual([true, true])
  })
})
