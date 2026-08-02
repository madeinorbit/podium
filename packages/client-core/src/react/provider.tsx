/**
 * THE REACT BINDING — and the client's ONE principal-scoped composition root
 * (#262 [spec:SP-3fe2], POD-404).
 *
 * Two jobs, and deliberately no third:
 *
 *  1. BIND. A thin `useSyncExternalStore` binding over the runtime's
 *     subscribe/getSnapshot pair. No transport wiring, no replica hydration, no
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
import type { ClientPrincipal } from '../principal'
import { samePrincipal } from '../principal'
import {
  ClientRuntime,
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
import type { CreateEngineOutbox } from '../engine/wiring'
import type { RouterWindow } from '../ui-state'
import type { FeedSinkPort } from '../socket-transport'

// Shared runtime seams (#262): types live with the runtime; re-exported here so
// the react entrypoint's public surface is unchanged.
export type { Store, StoreNotices, StoreServerConfig, UserFocus } from '../engine/types'
// The main-view union lives with the router (URL ↔ view mapping).
export type { MainView } from '../ui-state'
export type { FileTab } from '../viewmodels'
export type { ClientPrincipal } from '../principal'

/** The read seam the hooks consume — the runtime, structurally. */
interface StoreHandle<TApi extends PodiumClientApi> {
  subscribe(listener: () => void): () => void
  getSnapshot(): Store<TApi>
}

// The context carries the runtime HANDLE (stable identity for as long as the
// principal is unchanged), not the value object — so a provider re-render never
// re-renders consumers by itself. Consumers subscribe via useSyncExternalStore
// (useStore / useStoreSelector below) and only re-render when the slice they
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
  /** History surface — mobile passes createMemoryRouterWindow(). Default: window. */
  routerWindow?: RouterWindow
  /** Test seam: runtime timing knobs (e.g. spawnConfirmGraceMs: 0 so a spawn
   *  rollback test doesn't wait out the 2s broadcast-confirm grace). */
  engineOverrides?: { spawnConfirmGraceMs?: number }
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
  routerWindow,
  engineOverrides,
  unauthenticated = null,
  children,
}: StoreProviderProps<TApi>): JSX.Element {
  // The runtime consults callbacks through this ref, so a parent re-rendering
  // with fresh closure identities (an inline onFatalError, a new notices
  // object) is picked up without reconstructing anything.
  const latest = useRef({ onFatalError, formatError, notices })
  latest.current = { onFatalError, formatError, notices }
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
    runtime: ClientRuntime<TApi>
  } | null>(null)
  const held = runtimeRef.current
  if (
    held !== null &&
    (principal === null ||
      !samePrincipal(held.principal, principal) ||
      held.config !== config ||
      held.api !== api)
  ) {
    // Teardown happens BEFORE the successor is constructed, so there is never a
    // moment when two runtimes for two principals are both live over the same
    // storage — and never a window in which a previous principal's in-flight
    // callback can find a live consumer to publish to.
    held.runtime.destroy()
    runtimeRef.current = null
  }
  if (principal !== null && runtimeRef.current === null) {
    runtimeRef.current = {
      principal,
      config,
      api,
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
        routerWindow,
        ...engineOverrides,
      }),
    }
  }
  const runtime = runtimeRef.current?.runtime ?? null
  // start/dispose pair, keyed on the runtime: StrictMode's dev double-mount
  // disposes and re-arms the SAME runtime (both are idempotent). dispose() is
  // deliberately the REVERSIBLE half — the irreversible destroy() above is the
  // principal boundary and must not be driven by React's effect scheduling.
  useEffect(() => {
    if (runtime === null) return
    runtime.start()
    return () => runtime.dispose()
  }, [runtime])
  if (runtime === null) {
    // FAIL CLOSED: no runtime means no transport, no replica read, no outbox —
    // and no children, because a child that rendered here would necessarily be
    // painting something other than this principal's slice.
    return <PrincipalCtx.Provider value={null}>{unauthenticated}</PrincipalCtx.Provider>
  }
  return (
    <PrincipalCtx.Provider value={principal}>
      <Ctx.Provider value={runtime as unknown as StoreHandle<PodiumClientApi>}>
        {children}
      </Ctx.Provider>
    </PrincipalCtx.Provider>
  )
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
 *
 * ---------------------------------------------------------------------------
 * THE SELECTOR-CACHE DECISION (POD-404 / POD-328): KEEP THIS ONE.
 * ---------------------------------------------------------------------------
 *
 * POD-328 asked whether to replace this hand-rolled cache with the slice
 * mechanism POD-330 will land. The decision is to KEEP IT, and the reason is
 * the multi-user one rather than a preference:
 *
 * Slices now derive over a PARTIAL WORLD (POD-401/POD-1077). The principal's
 * slice can SHRINK when the authority evicts a row — a removal from your VIEW
 * that is not a deletion and moves no row's revision — and can be REBUILT
 * wholesale under a rescope. Any memoization that keys on entity identity, on a
 * dependency set of ids, or on a revision high-water mark is wrong under that,
 * because all three encode "a referenced row I cannot see is merely LATE". Under
 * scoping it may be permanently invisible, and a cache that waits for it paints
 * a stale row forever.
 *
 * This cache encodes none of that. Its key is SNAPSHOT IDENTITY (`c.snap ===
 * snap`) and nothing else. The runtime publishes a fresh snapshot object on any
 * slice change (`ClientRuntime.apply`), so an evict, a rescope and an ordinary
 * update are indistinguishable to it — all three miss, all three re-derive from
 * whatever rows are actually visible now. It cannot hold a row past its
 * visibility because it never remembers rows, only the last answer for the last
 * snapshot.
 *
 * It is also correct across the PRINCIPAL boundary for the same reason: a new
 * principal is a new runtime and therefore a new snapshot object, so the very
 * first read after a switch misses and re-derives. Nothing here needs to know
 * that a switch happened, which is the property that makes it safe — a cache
 * that had to be TOLD about sign-out is a cache that will one day not be.
 *
 * When POD-330 lands its slice mechanism it should be measured against exactly
 * this: it must invalidate on shrink-without-revision-change, not merely on
 * update.
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
