/**
 * THE REACT BINDING — and the client's ONE principal-scoped composition root
 * (#262 [spec:SP-3fe2], POD-404).
 *
 * Two jobs, and deliberately no third:
 *
 *  1. BIND. A thin `useSyncExternalStore` binding over the runtime's
 *     keyed local channels. No transport wiring, no replica hydration, no
 *     outbox drain, no effects beyond one start/dispose pair — all of that is
 *     the non-React modules (`engine/runtime.ts` and the four it coordinates).
 *
 *  2. OWN THE PRINCIPAL LIFECYCLE. This is the only place in the client where a
 *     runtime — and therefore a transport, a replica and an outbox — is
 *     constructed, and it constructs one per principal.
 *
 * ---------------------------------------------------------------------------
 * REBIND ON PRINCIPAL CHANGE. A RE-RENDER IS NOT SUFFICIENT.
 * ---------------------------------------------------------------------------
 *
 * Sign-in, sign-out and user switch TEAR DOWN and RECONSTRUCT. The reason is
 * that each of the three carriers is principal-bound in a way no state reset
 * reaches (docs/multi-user-readiness.md §3.1/§3.2):
 *
 *   - the SOCKET carries a principal (its session cookie), so a frame already in
 *     flight belongs to the previous person;
 *   - the REPLICA carries a per-principal cursor and slice, and a cursor left
 *     behind by someone else makes a cold, empty slice look permanently caught
 *     up — the exact failure `replica/principal-storage.ts` exists to prevent;
 *   - the OUTBOX carries queued writes that belong to one person and that must
 *     be re-authorized at drain time under that person's rights (ADR 3 D8).
 *
 * So the old runtime is `destroy()`ed — irreversibly, poisoning its state choke
 * point — and a new one is built over `createReplicaFn(nextPrincipal)`. Nothing
 * is "cleared": there is no reset path to forget to extend when a module gains
 * a new principal-derived field.
 *
 * ---------------------------------------------------------------------------
 * FAIL CLOSED BEFORE A PRINCIPAL EXISTS
 * ---------------------------------------------------------------------------
 *
 * `principal === null` means authentication has not yet produced one. Then NO
 * runtime is constructed at all, which is what makes "no hydration, no feed
 * subscription, no room subscription, no outbox drain before a principal" a
 * structural property rather than a set of guards someone must remember. The
 * subtree does not render (`unauthenticated`, default nothing) — cold start
 * paints the principal's scoped slice or nothing, never a previously cached
 * world and never another user's namespace.
 *
 * ---------------------------------------------------------------------------
 * IDENTITY IS SUPPLIED, NEVER DERIVED (ADR 3 D7 — the client half)
 * ---------------------------------------------------------------------------
 *
 * `principal` must come from an AUTHENTICATED TRANSPORT ANSWER. This module
 * exposes it to slices and components for DISPLAY (`useCurrentPrincipal`) and
 * nothing may reach around it: not the URL, not storage, not a wire payload, not
 * a name the user typed. `scripts/audit-phase2-client.ts` item 6 enforces that
 * for the whole client tree.
 *
 * ---------------------------------------------------------------------------
 * THE ONE PRE-AUTH STORAGE READ
 * ---------------------------------------------------------------------------
 *
 * The THEME, and only the theme. `ThemeProvider` wraps `StoreProvider` because
 * the first paint must not flash the wrong colours while `/auth/status` is in
 * flight, so its key is read before a principal exists. That is safe precisely
 * because it is cosmetic: it carries no identity, no cursor, no entity and no
 * authored work, so reading it cannot leak one person's data to another. It is
 * routed as `pre-auth-theme` in `ui-state.ts` (POD-403's total routing table)
 * and is the ONLY member of that home — `ui-state.audit.test.ts` fails if a
 * second key joins it. Everything else a client persists lives below the
 * principal namespace and is therefore unreadable until this provider has one.
 */

import type { HostMetricsWire } from '@podium/model'
import type { JSX } from 'react'
import {
  createContext,
  type ReactNode,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useSyncExternalStore,
} from 'react'
import type { PodiumClientApi } from '../api'
import {
  type ClientRuntime,
  type CreateReplicaForPrincipal,
  createClientRuntime,
} from '../engine/runtime'
import {
  defaultFormatError,
  NOOP_NOTICES,
  type Store,
  type StoreNotices,
  type StoreServerConfig,
} from '../engine/types'
import type { VisibilitySource } from '../engine/visibility'
import type { CreateEngineOutbox } from '../engine/wiring'
import type { OnlineEvents } from '../outbox'
import type { ClientPrincipal } from '../principal'
import { principalKey, samePrincipal } from '../principal'
import type { FeedSinkPort } from '../socket-transport'
import type { RouterWindow } from '../ui-state'

// Shared runtime seams (#262): types live with the runtime; re-exported here so
// the react entrypoint's public surface is unchanged.
export type { Store, StoreNotices, StoreServerConfig, UserFocus } from '../engine/types'
export type { ClientPrincipal } from '../principal'
// The main-view union lives with the router (URL ↔ view mapping).
export type { MainView } from '../ui-state'
export type { FileTab } from '../values'

type StoreHandle<TApi extends PodiumClientApi> = ClientRuntime<TApi>

// The context carries the runtime HANDLE (stable identity for as long as the
// principal is unchanged), not the value object — so a provider re-render never
// re-renders consumers by itself. Consumers subscribe via useSyncExternalStore
// (useStore / useRuntimeSelector below) and only re-render when the slice they
// read actually changed.
const Ctx = createContext<StoreHandle<PodiumClientApi> | null>(null)
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
  config: StoreServerConfig
  /** The app's typed tRPC client (web: AppRouter-typed; mobile: MobileTrpc). */
  api: TApi
  onFatalError: (message: string) => void
  /** App-flavored error formatting (web: formatAppError). */
  formatError?: (error: unknown, fallback: string) => string
  /** UI notices (web: sonner toasts). Default: silent. */
  notices?: StoreNotices
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
  /** Test seam: runtime timing knobs (e.g. spawnConfirmGraceMs: 0 so a spawn
   *  rollback test doesn't wait out the 2s broadcast-confirm grace). */
  engineOverrides?: { spawnConfirmGraceMs?: number }
  /** Optional app data layer over THIS runtime. Attached after start; released
   * before dispose/destroy, including a principal/config rebuild. StrictMode
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
  engineOverrides,
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
  // runtime is DESTROYED (irreversible — see ClientRuntime.destroy) before the
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
    config: StoreServerConfig
    api: TApi
    networkEnabled: boolean
    runtime: ClientRuntime<TApi>
    detach?: () => void
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
      held.runtime.destroy()
      runtimeRef.current = null
    }
  }
  if (principal !== null && runtimeRef.current === null) {
    runtimeRef.current = {
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
        ...engineOverrides,
      }),
    }
  }
  const owner = runtimeRef.current
  const runtime = owner?.runtime ?? null
  // start/dispose pair, keyed on the runtime: StrictMode's dev double-mount
  // disposes and re-arms the SAME runtime (both are idempotent). dispose() is
  // deliberately the REVERSIBLE half — the irreversible destroy() above is the
  // principal boundary and must not be driven by React's effect scheduling.
  // biome-ignore lint/correctness/useExhaustiveDependencies: The owner changes only with its runtime; detach is its mutable cleanup handle.
  useEffect(() => {
    if (runtime === null || owner === null) return
    runtime.start()
    owner.detach = latest.current.attachRuntime?.(runtime)
    return () => {
      const detach = owner.detach
      owner.detach = undefined
      try {
        detach?.()
      } finally {
        runtime.dispose()
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
      <Ctx.Provider
        key={principalKey(principal)}
        value={runtime as unknown as StoreHandle<PodiumClientApi>}
      >
        <AccountLifetime>{children}</AccountLifetime>
      </Ctx.Provider>
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

/** The read seam itself. Exported for `useSlice` (POD-330), which needs the
 *  HANDLE rather than a snapshot: the slice publisher is keyed on handle
 *  identity so the whole tree shares one, and a new principal — a new handle —
 *  gets a new publisher holding nothing. */
export function useStoreHandle<TApi extends PodiumClientApi>(): StoreHandle<TApi> {
  const s = useContext(Ctx)
  if (!s) throw new Error('useStore outside StoreProvider')
  return s as unknown as StoreHandle<TApi>
}

/** Select actions from their runtime owner and subscribe only to local keys
 * the selector reads. Replica records never enter this binding. */
export function useRuntimeSelector<T, TApi extends PodiumClientApi = PodiumClientApi>(
  selector: (access: Store<TApi>) => T,
  isEqual: (a: T, b: T) => boolean = Object.is,
): T {
  const owner = useStoreHandle<TApi>()
  const current = useRef({ selector, isEqual })
  current.current = { selector, isEqual }
  const view = useMemo(() => {
    let keys: string[] = []
    let selected: { value: T } | undefined
    let readSelector: ((access: Store<TApi>) => T) | undefined
    const localValues = new Map<string, unknown>()
    let stop: (() => void) | undefined
    let listener: (() => void) | undefined
    const arm = () => {
      stop?.()
      stop = listener ? owner.onLocals(keys as import('../engine/keyed-inputs').LocalKey[], listener) : undefined
    }
    const access = new Proxy(owner.access, {
      get(target, key, receiver) {
        const value = Reflect.get(target, key, receiver)
        if (typeof key === 'string' && !Object.hasOwn(owner.services, key)) {
          nextKeys.add(key)
          localValues.set(key, value)
        }
        return value
      },
    })
    let nextKeys = new Set<string>()
    return {
      read() {
        // useSyncExternalStore may read repeatedly between publications. Keep
        // structured selections stable while their addressed locals agree,
        // including the render-to-subscribe gap.
        if (selected && readSelector === current.current.selector && keys.every(key =>
          Object.is(localValues.get(key), owner.readLocal(key as import('../engine/keyed-inputs').LocalKey))))
          return selected.value
        nextKeys = new Set()
        localValues.clear()
        const value = current.current.selector(access)
        readSelector = current.current.selector
        const next = [...nextKeys].sort()
        if (next.join('|') !== keys.join('|')) { keys = next; arm() }
        if (!selected || !current.current.isEqual(selected.value, value)) selected = { value }
        return selected.value
      },
      subscribe(notify: () => void) {
        listener = notify
        arm()
        return () => { listener = undefined; stop?.(); stop = undefined }
      },
    }
  }, [owner])
  return useSyncExternalStore(view.subscribe, view.read)
}

/** Live telemetry subscribes independently of the entity snapshot. */
export function useHostMetrics(): HostMetricsWire[] {
  const { hostMetrics } = useStoreHandle()
  return useSyncExternalStore(hostMetrics.subscribe, hostMetrics.getSnapshot)
}
