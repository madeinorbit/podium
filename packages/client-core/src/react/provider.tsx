/**
 * Thin React binding for the Podium client engine (#262 [spec:SP-3fe2]).
 *
 * Everything that used to live here as a 1,400-line god-store — transport
 * wiring, replica hydration, outbox drain, optimistic overlays, the router,
 * ~20 effects — is now the non-React `Engine` (src/engine/engine.ts). This
 * module only:
 *
 *  - constructs the engine once per provider lifetime,
 *  - runs its start()/dispose() lifecycle from the mount effect (StrictMode's
 *    dev double-mount is handled by the engine's idempotent re-startable pair),
 *  - provides the engine's subscribe/getSnapshot handle through context, and
 *  - exposes the `useStore` / `useStoreSelector` hooks over
 *    useSyncExternalStore.
 *
 * The exported surface (StoreProvider props, Store shape, hooks) is unchanged —
 * web and mobile bind exactly as before.
 */

import type { JSX } from 'react'
import {
  createContext,
  type ReactNode,
  useContext,
  useEffect,
  useRef,
  useSyncExternalStore,
} from 'react'
import type { PodiumClientApi } from '../api'
import { createEngine, type Engine } from '../engine/engine'
import {
  defaultFormatError,
  NOOP_NOTICES,
  type Store,
  type StoreNotices,
  type StoreServerConfig,
} from '../engine/types'
import type { Replica } from '../replica/replica'
import type { RouterWindow } from '../router'

// Shared engine seams (#262): types live with the engine; re-exported here so
// the react entrypoint's public surface is unchanged.
export type { Store, StoreNotices, StoreServerConfig, UserFocus } from '../engine/types'
// The main-view union lives with the router (URL ↔ view mapping).
export type { MainView } from '../router'
export type { FileTab } from '../viewmodels'

/** The read seam the hooks consume — the engine, structurally. */
interface StoreHandle<TApi extends PodiumClientApi> {
  subscribe(listener: () => void): () => void
  getSnapshot(): Store<TApi>
}

// The context carries the engine HANDLE (stable identity for the provider's
// lifetime), not the value object — so a provider re-render never re-renders
// consumers by itself. Consumers subscribe via useSyncExternalStore
// (useStore / useStoreSelector below) and only re-render when the slice they
// read actually changed.
const Ctx = createContext<StoreHandle<PodiumClientApi> | null>(null)

export interface StoreProviderProps<TApi extends PodiumClientApi> {
  config: StoreServerConfig
  /** The app's typed tRPC client (web: AppRouter-typed; mobile: MobileTrpc). */
  api: TApi
  onFatalError: (message: string) => void
  /** App-flavored error formatting (web: formatAppError). */
  formatError?: (error: unknown, fallback: string) => string
  /** UI notices (web: sonner toasts). Default: silent. */
  notices?: StoreNotices
  /** Replica factory — mobile injects the AsyncStorage-backed one. Called once. */
  createReplicaFn?: () => Replica
  /** History surface — mobile passes createMemoryRouterWindow(). Default: window. */
  routerWindow?: RouterWindow
  children: ReactNode
}

export function StoreProvider<TApi extends PodiumClientApi>({
  config,
  api,
  onFatalError,
  formatError = defaultFormatError,
  notices = NOOP_NOTICES,
  createReplicaFn,
  routerWindow,
  children,
}: StoreProviderProps<TApi>): JSX.Element {
  // The engine consults callbacks through this ref, so a parent re-rendering
  // with fresh closure identities (an inline onFatalError, a new notices
  // object) is picked up without reconstructing anything.
  const latest = useRef({ onFatalError, formatError, notices })
  latest.current = { onFatalError, formatError, notices }
  // One engine per provider lifetime (matches the old useMemo([]) replica —
  // config/api identity churn after mount is intentionally not observed).
  const engineRef = useRef<Engine<TApi> | null>(null)
  if (engineRef.current === null) {
    engineRef.current = createEngine<TApi>({
      config,
      api,
      onFatalError: (m) => latest.current.onFatalError(m),
      formatError: (e, f) => latest.current.formatError(e, f),
      notices: {
        error: (m) => latest.current.notices.error(m),
        info: (m, d) => latest.current.notices.info(m, d),
      },
      createReplicaFn,
      routerWindow,
    })
  }
  const engine = engineRef.current
  // start/dispose pair: StrictMode's dev double-mount disposes the memoized
  // engine once, and the second mount re-arms it (both are idempotent).
  useEffect(() => {
    engine.start()
    return () => engine.dispose()
  }, [engine])
  return (
    <Ctx.Provider value={engine as unknown as StoreHandle<PodiumClientApi>}>
      {children}
    </Ctx.Provider>
  )
}

function useStoreHandle<TApi extends PodiumClientApi>(): StoreHandle<TApi> {
  const s = useContext(Ctx)
  if (!s) throw new Error('useStore outside StoreProvider')
  return s as unknown as StoreHandle<TApi>
}

/** Compatibility hook: the WHOLE store snapshot. Re-renders whenever any store
 *  field changes — prefer `useStoreSelector` for hot components. */
export function useStore<TApi extends PodiumClientApi = PodiumClientApi>(): Store<TApi> {
  const handle = useStoreHandle<TApi>()
  return useSyncExternalStore(handle.subscribe, handle.getSnapshot)
}

/**
 * Slice subscription: re-renders only when `selector(store)` changes (per
 * `isEqual`, Object.is by default). Selectors may allocate (e.g. pick several
 * fields into an object) as long as `isEqual` is passed accordingly — the hook
 * caches the last selected value per snapshot so getSnapshot stays stable.
 */
export function useStoreSelector<T, TApi extends PodiumClientApi = PodiumClientApi>(
  selector: (s: Store<TApi>) => T,
  isEqual: (a: T, b: T) => boolean = Object.is,
): T {
  const handle = useStoreHandle<TApi>()
  const cache = useRef<{ snap: Store<TApi>; selected: T } | null>(null)
  // A new selector closure (inline arrows capture fresh props each render)
  // must invalidate the cache — but only across renders, never mid-render.
  const selectorRef = useRef(selector)
  if (selectorRef.current !== selector) {
    selectorRef.current = selector
    cache.current = null
  }
  const isEqualRef = useRef(isEqual)
  isEqualRef.current = isEqual
  const getSelected = () => {
    const snap = handle.getSnapshot()
    const c = cache.current
    if (c && c.snap === snap) return c.selected
    const next = selectorRef.current(snap)
    // Keep the previous selected identity when equal, so useSyncExternalStore's
    // Object.is check sees "unchanged" and skips the re-render.
    const selected = c && isEqualRef.current(c.selected, next) ? c.selected : next
    cache.current = { snap, selected }
    return selected
  }
  return useSyncExternalStore(handle.subscribe, getSelected)
}
