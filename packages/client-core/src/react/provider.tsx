import { allowImperativeRead } from '@podium/mobx-helpers'
import { reaction } from 'mobx'
/** The authenticated React boundary. It creates one ClientRuntime per
 * principal, passes that root through context, and retires it on sign-out.
 * StrictMode stops and restarts its services without replacing its stores. */

import type { JSX } from 'react'
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useSyncExternalStore,
} from 'react'
import type { PodiumClientApi } from '../api'
import { NOOP_NOTICES, type NoticeSink } from '../notices'
import type { OnlineEvents } from '../outbox'
import type { ClientPrincipal } from '../principal'
import { principalKey, samePrincipal } from '../principal'
import type { VisibilitySource } from '../runtime-root/connection/visibility'
import type { CreateEngineOutbox } from '../runtime-root/outbox/wiring'
import type { CreateReplicaForPrincipal } from '../runtime-root/root'
import { type ClientRuntime, createClientRuntime } from '../runtime-root/root'
import { defaultFormatError, type ServerConfig } from '../runtime-root/types'
import type { FeedSinkPort } from '../socket-transport'
import type { RouterWindow } from '../ui-state'
import { RuntimeProvider, useClientRuntime } from './runtime-root'

export type { NoticeSink } from '../notices'
export type { ClientPrincipal } from '../principal'
export type { ServerConfig } from '../runtime-root/types'
export type { UserFocus } from '../ui/types'
// The main-view union lives with the router (URL ↔ view mapping).
export type { MainView } from '../ui-state'
export type { FileTab } from '../values'
export { useClientRuntime } from './runtime-root'

/** The current principal, for DISPLAY only. Never an input to a command. */
const PrincipalCtx = createContext<ClientPrincipal | null>(null)

export interface StoreProviderProps<TApi extends PodiumClientApi> {
  /**
   * WHO THIS CLIENT IS ACTING AS — from the authenticated transport, never
   * from the URL, storage, a payload or a client-supplied name (ADR 3 D7).
   *
   * `null` while authentication has not produced one. The provider then builds
   * NOTHING and renders {@link StoreProviderProps.unauthenticated}.
   */
  principal: ClientPrincipal | null
  config: ServerConfig
  /** The app's typed tRPC client (web: AppRouter-typed; mobile: MobileTrpc). */
  api: TApi
  onFatalError: (message: string) => void
  /** App-flavored error formatting (web: formatAppError). */
  formatError?: (error: unknown, fallback: string) => string
  /** UI notices (web: sonner toasts). Default: silent. */
  notices?: NoticeSink
  /**
   * Replica factory, TAKING THE PRINCIPAL. Mobile injects the AsyncStorage
   * one, web the IndexedDB kernel assembly. Called once per principal.
   *
   * It receives the principal rather than closing over one so that every
   * construction asks "whose store is this?" at the root that can answer it. A
   * root handed a principal it did not open for must THROW: refusing is the
   * fail-closed answer, and returning the store it happens to hold is exactly
   * the cross-principal adoption this seam exists to make impossible.
   */
  createReplicaFn: CreateReplicaForPrincipal
  /** Wire-v2 feed sink (POD-1223). Supplied WITH the kernel-backed
   *  `createReplicaFn` by the platform's composition root; the two are one
   *  principal-scoped assembly and neither half is meaningful alone. */
  feed?: FeedSinkPort
  /** Platform queue factory paired with the replica assembly. */
  createOutboxFn?: CreateEngineOutbox
  /**
   * PLATFORM SEAMS (POD-2055 WP-C). Every one of these has a browser default
   * that is wrong on React Native; the mobile composition root supplies the
   * native answers (AppState, NetInfo) and web passes none of them.
   */
  visibility?: VisibilitySource
  onlineEvents?: OnlineEvents
  isOnline?: () => boolean
  heartbeatIntervalMs?: number
  makeSocket?: import('../socket-transport').SocketHubOptions['makeSocket']
  /** False for a trusted local-only boot whose remote identity has not yet been
   *  revalidated. The runtime opens the replica but starts no socket, boot read,
   *  or outbox drain until its replacement provider enables networking. */
  networkEnabled?: boolean
  /** History surface — mobile passes createMemoryRouterWindow(). Default: window. */
  routerWindow?: RouterWindow
  /** Optional app data layer over THIS runtime. Attached after start; released
   * before disposal, including a principal/config rebuild. StrictMode
   * re-attaches it when the same runtime starts again. */
  attachRuntime?: (runtime: ClientRuntime<TApi>) => () => void
  /** What to paint while there is no principal. Default: nothing. NEVER a
   *  cached world — this branch exists because painting one would be the leak. */
  unauthenticated?: ReactNode
  children: ReactNode
}

export function StoreProvider<TApi extends PodiumClientApi>({
  principal,
  config,
  api,
  onFatalError,
  formatError = defaultFormatError,
  notices = NOOP_NOTICES,
  createReplicaFn,
  feed,
  createOutboxFn,
  visibility,
  onlineEvents,
  isOnline,
  heartbeatIntervalMs,
  makeSocket,
  networkEnabled,
  routerWindow,
  attachRuntime,
  unauthenticated = null,
  children,
}: StoreProviderProps<TApi>): JSX.Element {
  // The runtime consults callbacks through this ref, so a parent re-rendering
  // with fresh closure identities (an inline onFatalError, a new notices
  // object) is picked up without reconstructing anything.
  const latest = useRef({ onFatalError, formatError, notices, attachRuntime })
  latest.current = { onFatalError, formatError, notices, attachRuntime }
  // ONE RUNTIME PER (principal, config, api) IDENTITY. The principal is the
  // load-bearing key: a change to it is a different person, so the previous
  // runtime is disposed before the
  // successor exists, and nothing it still holds can publish afterwards.
  //
  // config/api keep their #262 behaviour: the pre-split provider rebuilt
  // hub/outbox/actions when those changed. Both current consumers pass stable
  // identities (web: useState config + useMemo trpc; mobile: useMemo both), so
  // for them this never fires after mount — pass MEMOIZED props: an inline
  // object literal would tear the whole client down every render. Callback
  // props stay ref-routed above; their identity churn must NOT rebuild anything.
  const runtimeRef = useRef<{
    principal: ClientPrincipal
    config: ServerConfig
    api: TApi
    networkEnabled: boolean
    runtime: ClientRuntime<TApi>
    detach?: () => void
    generation: number
  } | null>(null)
  const held = runtimeRef.current
  if (
    held !== null &&
    (principal === null ||
      !samePrincipal(held.principal, principal) ||
      held.config !== config ||
      held.api !== api ||
      held.networkEnabled !== (networkEnabled ?? true))
  ) {
    // Teardown happens BEFORE the successor is constructed, so there is never a
    // moment when two runtimes for two principals are both live over the same
    // storage — and never a window in which a previous principal's in-flight
    // callback can find a live consumer to publish to.
    const detach = held.detach
    held.detach = undefined
    try {
      detach?.()
    } finally {
      held.runtime.dispose({
        eraseUi: principal === null || !samePrincipal(held.principal, principal),
      })
      runtimeRef.current = null
    }
  }
  if (principal !== null && runtimeRef.current === null) {
    runtimeRef.current = {
      generation: 0,
      principal,
      config,
      api,
      networkEnabled: networkEnabled ?? true,
      runtime: createClientRuntime<TApi>({
        principal,
        config,
        api,
        onFatalError: (m) => latest.current.onFatalError(m),
        formatError: (e, f) => latest.current.formatError(e, f),
        notices: {
          error: (m) => latest.current.notices.error(m),
          info: (m, d) => latest.current.notices.info(m, d),
        },
        createReplicaFn,
        feed,
        createOutboxFn,
        visibility,
        onlineEvents,
        isOnline,
        heartbeatIntervalMs,
        makeSocket,
        networkEnabled,
        routerWindow,
      }),
    }
  }
  const owner = runtimeRef.current
  const runtime = owner?.runtime ?? null
  // React stops and restarts services; principal changes dispose the root.
  // biome-ignore lint/correctness/useExhaustiveDependencies: The owner changes only with its runtime; detach is its mutable cleanup handle.
  useEffect(() => {
    if (runtime === null || owner === null) return
    owner.generation++
    runtime.start()
    owner.detach = latest.current.attachRuntime?.(runtime)
    return () => {
      const detach = owner.detach
      owner.detach = undefined
      try {
        detach?.()
      } finally {
        runtime.stop()
        const generation = ++owner.generation
        // StrictMode re-arms this owner synchronously. A real unmount leaves
        // its generation unchanged and releases the whole root.
        queueMicrotask(() => {
          if (owner.generation === generation && !runtime.isDisposed) runtime.dispose()
        })
      }
    }
  }, [runtime])
  if (runtime === null || principal === null) {
    // FAIL CLOSED: no runtime means no transport, no replica read, no outbox —
    // and no children, because a child that rendered here would necessarily be
    // painting something other than this principal's slice.
    return <PrincipalCtx.Provider value={null}>{unauthenticated}</PrincipalCtx.Provider>
  }
  return (
    <PrincipalCtx.Provider value={principal}>
      {/* Account-owned hooks must retire with their principal. Replacing only the
          context value leaves mount-stable callbacks, refs and memoized readers
          holding the previous account's render scope. Ordinary rerenders keep
          this key, including reconnects and same-principal runtime rebuilds. */}
      <RuntimeProvider key={principalKey(principal)} runtime={runtime}>
        <AccountLifetime>{children}</AccountLifetime>
      </RuntimeProvider>
    </PrincipalCtx.Provider>
  )
}

/** End native focus while the departing account DOM is still attached. The
 * principal key preserves focus during same-account runtime rebuilds.
 *
 * React can retain a removed field in its selection-event cache until another
 * field receives real focusin. Chromium 153 warmed controls for POD-5402 retained
 * nine retired runtime/pool parts before that focus and zero afterwards. Leave
 * selection events to the browser rather than synthesizing a private cache reset. */
function AccountLifetime({ children }: { children: ReactNode }): JSX.Element {
  useLayoutEffect(() => {
    return () => {
      if (typeof document === 'undefined') return
      const focused = document.activeElement
      if (focused && 'blur' in focused && typeof focused.blur === 'function') focused.blur()
    }
  }, [])
  return <>{children}</>
}

/**
 * The principal this subtree is bound to — for DISPLAY (whose workspace am I
 * looking at, whose avatar goes in the corner).
 *
 * It is NOT an authorization input and NOT a command field: attribution is
 * transport-derived server-side, and a command payload naming an actor is inert
 * by contract (ADR 3 D7, POD-402). Returns null only outside a bound provider,
 * which is the pre-authentication state.
 */
export function useCurrentPrincipal(): ClientPrincipal | null {
  return useContext(PrincipalCtx)
}

/** Screen state belongs to this device's MobX UiStore. Read fields in observers. */
export function useUi(): import('../ui/ui-store').UiStore {
  return useClientRuntime().ui
}
export function useDeviceState(): import('../ui-state').RoutedUiState {
  return useClientRuntime().deviceState
}

/** Bind one MobX screen field for a leaf that is not an observer. */
export function useUiValue<K extends keyof import('../ui/ui-store').UiStore>(
  key: K,
): import('../ui/ui-store').UiStore[K] {
  const ui = useUi()
  const read = useCallback(() => allowImperativeRead(() => ui[key]), [ui, key])
  const subscribe = useCallback((notify: () => void) => reaction(read, notify), [read])
  return useSyncExternalStore(subscribe, read)
}
