/**
 * THE MOBILE POOL ON THE REAL MOBILE PATH (POD-4976).
 *
 * Every case boots the production `MobileClientProvider`: the AsyncStorage
 * bridge, the shared replica assembly over a real SQLite file, the outbox and
 * the StoreProvider. Only the platform edges are replaced (AsyncStorage's native
 * module, the IndexedDB/SQLite engine choice, the socket and the network) and
 * the cold-sync loading boundary. An
 * "app restart" is a fresh module graph over the SAME storage, because the
 * provider owns one pool per principal.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ClientRuntime } from '@podium/client-core/engine'
import type { MobxPool } from '@podium/client-graph'
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
  graphGate: null as Promise<void> | null,
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
  if (state.graphGate) await state.graphGate
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

/** One app load: a fresh module graph (a fresh host) over the device's storage. */
async function launch(preferences = false, withRow = false) {
  vi.resetModules()
  // Everything that holds a React context or the host comes from the new graph.
  const [
    { MobileClientProvider },
    { useMobilePool },
    { AuthStatusContext },
    { useStoreHandle },
    { usePersistedUiState },
    { useCollapsed },
    { useCollapsedSet },
  ] = await Promise.all([
    import('./MobileClientProvider'),
    import('./mobile-pool'),
    import('./auth-context'),
    import('@podium/client-core/react'),
    import('../hooks/usePersistedUiState'),
    import('../hooks/useCollapsed'),
    import('../hooks/useCollapsedSet'),
  ])
  const { PoolWorkRowSlot } = withRow ? await import('../screens/WorkListRow') : { PoolWorkRowSlot: () => null }
  const callbacks = { navPending: false, onOpenIssue: () => {}, onOpenSession: () => {}, onLongPress: () => {}, onTuck: () => {} }
  const item = { id: 'attachment-probe-absent', kind: 'issue' as const, listKey: 'attachment-probe-absent' }
  const seen: { runtime?: ClientRuntime; pool?: MobxPool | null; attached: boolean[] } = {
    attached: [],
  }
  const parse = (raw: string | null) => raw ?? 'default'
  const keys = ['repo']
  const storageKeyFor = (key: string) => `podium:sidebar:${key}`
  function Preferences() {
    const [value] = usePersistedUiState('podium.chat.stickyPrompts', parse, String)
    const [collapsed] = useCollapsed('podium:sidebar:task-details-fold', true)
    const folds = useCollapsedSet(keys, storageKeyFor)
    return (
      <output data-testid="preferences">
        {value}:{String(collapsed)}:{String(folds.collapsed.has('repo'))}
      </output>
    )
  }
  function Probe() {
    seen.runtime = useStoreHandle() as unknown as ClientRuntime
    seen.pool = useMobilePool()
    seen.attached.push(seen.pool !== null)
    return (
      <>
        <div data-testid="app">{seen.pool ? 'pool' : 'no pool'}{withRow ? <PoolWorkRowSlot item={item} {...callbacks} /> : null}</div>
        {preferences ? <Preferences /> : null}
      </>
    )
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

/** Let the lazy graph import and provider-owned attachment finish. */
async function graphSettled() {
  await act(async () => {
    await import('../../../../packages/client-graph/src/runtime-pool')
  })
  await settle()
}

function currentRuntime(runtime: ClientRuntime | undefined): ClientRuntime {
  if (!runtime) throw new Error('The app has no signed-in runtime')
  return runtime
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
  state.graphGate = null
})
afterEach(async () => {
  cleanup()
  vi.unstubAllGlobals()
  rmSync(dir, { recursive: true, force: true })
})

describe('mobile pool ownership', () => {
  it('attaches after an already-mounted native row without changing hook order', async () => {
    let release!: () => void
    state.graphGate = new Promise<void>(resolve => { release = resolve })
    const app = await launch(false, true)
    expect(app.seen.pool).toBeNull()
    expect(screen.getByLabelText('Loading work')).toBeTruthy()
    await act(async () => { release(); await new Promise(resolve => setTimeout(resolve, 20)) })
    await waitFor(() => expect(app.seen.pool).toBeTruthy())
    await waitFor(() => expect(screen.queryByLabelText('Loading work')).toBeNull())
    expect(state.pools).toEqual([{ runtime: app.seen.runtime, disposed: false }])
    await app.quit()
  })

  it('builds exactly one pool by default over the signed-in provider runtime', async () => {
    const app = await launch()
    await graphSettled()
    await waitFor(() => expect(app.seen.pool).toBeTruthy())
    expect(screen.getByTestId('app').textContent).toBe('pool')
    expect(state.pools).toEqual([{ runtime: app.seen.runtime, disposed: false }])
    await app.quit()
    expect(state.pools.map(pool => pool.disposed)).toEqual([true])
  })

  it('ignores obsolete saved OFF values through restart and disposes each pool once', async () => {
    // Compatibility input only: this key is no longer a production reader.
    state.device.set('podium.mobxSidebar', '0')
    const first = await launch()
    await waitFor(() => expect(first.seen.pool).toBeTruthy())
    const firstPool = first.seen.pool
    await first.quit()
    const second = await launch()
    await waitFor(() => expect(second.seen.pool).toBeTruthy())
    expect(second.seen.pool).not.toBe(firstPool)
    expect(state.pools.map(pool => pool.disposed)).toEqual([true, false])
    expect(state.pools[1]?.runtime).toBe(second.seen.runtime)
    await second.quit()
    expect(state.pools.map(pool => pool.disposed)).toEqual([true, true])
  })

  it('disposes the pool with the signed-in user and rebuilds it for the next one', async () => {
    const app = await launch()
    await waitFor(() => expect(app.seen.pool).toBeTruthy())
    const alice = { runtime: app.seen.runtime, pool: app.seen.pool }
    await app.switchUser('bob')
    await waitFor(() => expect(app.seen.pool).toBeTruthy())
    expect(state.pools).toEqual([
      { runtime: alice.runtime, disposed: true },
      { runtime: app.seen.runtime, disposed: false },
    ])
    expect(app.seen.pool).not.toBe(alice.pool)
    await app.quit()
    expect(state.pools.map(pool => pool.disposed)).toEqual([true, true])
  })

  it('loads saved phone preferences offline through lazy attachment and isolates the next principal', async () => {
    const errors = vi.spyOn(console, 'error')
    const first = await launch(true)
    const firstRuntime = currentRuntime(first.seen.runtime)
    await waitFor(() => expect(first.seen.pool).toBeTruthy())
    act(() => {
      firstRuntime.ui.set('podium.chat.stickyPrompts', 'saved')
      firstRuntime.ui.set('podium:sidebar:task-details-fold', 'false')
      firstRuntime.ui.set('podium:sidebar:repo', 'true')
    })
    await waitFor(() => expect(screen.getByTestId('preferences').textContent).toBe('saved:false:true'))
    await waitFor(() => expect(firstRuntime.getSnapshot().outboxSize).toBe(2))
    await firstRuntime.replica.flush()
    await first.quit()
    state.pools.length = 0

    const app = await launch(true)
    await waitFor(() => expect(app.seen.pool).toBeTruthy(), { timeout: 10_000 })
    await waitFor(() => expect(screen.getByTestId('preferences').textContent).toBe('saved:false:true'), { timeout: 10_000 })
    expect(app.seen.attached[0]).toBe(false)
    expect(app.seen.attached).toContain(true)
    expect(state.pools).toEqual([{ runtime: app.seen.runtime, disposed: false }])
    const alice = { runtime: currentRuntime(app.seen.runtime), pool: app.seen.pool }
    if (!alice.pool) throw new Error('The mobile pool did not attach')
    expect(alice.pool.preferenceKeys()).toHaveLength(3)
    expect(alice.pool.preferenceKeys().map(key => alice.pool!.row('preference', key))).toMatchObject([
      { key: 'podium.chat.stickyPrompts', value: 'saved' },
      { key: 'podium:sidebar:task-details-fold', value: 'false' },
      { key: 'podium:sidebar:repo', value: 'true' },
    ])
    await app.switchUser('bob')
    await waitFor(() => expect(app.seen.pool).toBeTruthy(), { timeout: 10_000 })
    await waitFor(() => expect(screen.getByTestId('preferences').textContent).toBe('default:true:false'))
    expect(alice.pool.preferenceKeys()).toEqual([])
    act(() => alice.runtime.ui.set('podium.chat.stickyPrompts', 'old-person'))
    await settle()
    expect(screen.getByTestId('preferences').textContent).toBe('default:true:false')
    const bobPool = app.seen.pool
    if (!bobPool) throw new Error('The next principal has no pool')
    await app.quit()
    expect(bobPool.preferenceKeys()).toEqual([])
    expect(errors.mock.calls).toEqual([])
    errors.mockRestore()
  })
})
