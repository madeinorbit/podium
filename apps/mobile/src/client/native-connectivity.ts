import type { VisibilitySource } from '@podium/client-core/engine'
import type { OnlineEvents } from '@podium/client-core/outbox'

/**
 * WHAT THE PHONE KNOWS (POD-2055 F4).
 *
 * The shared client was written for a browser and, on a real device, was blind
 * in three ways at once. It never learned the app had been backgrounded, so it
 * kept a 2.5 s heartbeat and a reconnect loop running against sockets iOS was
 * about to kill — and kept telling the server this person was watching, which
 * is what suppresses their ntfy/Telegram push. It never learned the network had
 * come back, so after a tunnel or a Wi-Fi/cellular handover the feed sat out up
 * to 10 s of backoff. And `navigator.onLine` does not exist on React Native, so
 * the outbox believed it was online in airplane mode and retried every 5 s.
 *
 * Two platform modules answer all three: AppState and NetInfo. This is the
 * controller that turns them into the seams the shared client already has —
 * a {@link VisibilitySource}, an {@link OnlineEvents}, an `isOnline` probe —
 * plus the two direct transport calls that have no seam because they are
 * commands, not facts: `connectNow` and `suspend`.
 *
 * It is deliberately free of React Native imports so it can be tested for what
 * it decides. `platform-connectivity.native.ts` supplies the real modules.
 */

export type AppStateStatus = 'active' | 'background' | 'inactive' | 'unknown' | 'extension'

/** The slice of RN's `AppState` this uses. */
export interface AppStateLike {
  readonly currentState: AppStateStatus
  addEventListener(
    type: 'change',
    handler: (state: AppStateStatus) => void,
  ): { remove(): void }
}

/** The slice of a NetInfo state this reads. Both fields are nullable upstream. */
export interface NetInfoStateLike {
  readonly isConnected: boolean | null
  readonly isInternetReachable?: boolean | null
}

/** The slice of `@react-native-community/netinfo` this uses. */
export interface NetInfoLike {
  addEventListener(handler: (state: NetInfoStateLike) => void): () => void
}

/** The transport commands this drives. A subset of `SocketHub`, named here so
 *  the controller does not depend on the whole hub to be tested. */
export interface NativeConnectivityHub {
  connectNow(): void
  suspend(): void
}

export interface NativeConnectivity {
  /** Injected into the engine: visibility from AppState, not from a document. */
  readonly visibility: VisibilitySource
  /** Injected into the outbox: connectivity restores from NetInfo. */
  readonly onlineEvents: OnlineEvents
  /** Injected into the outbox: the last reachability NetInfo reported. */
  isOnline(): boolean
  /** Hand over the engine's transport once it exists (it is built from the
   *  assembly, so it cannot be passed at construction). */
  attachHub(hub: NativeConnectivityHub): void
  dispose(): void
}

/**
 * The native ping cadence (POD-2055 WP-C5). Web keeps the hub's own 2.5 s,
 * which is fast because each ping doubles as its latency probe. On a phone the
 * hub only runs in the foreground now, so what is left to buy with that rate is
 * radio wake-ups; 10 s still bounds half-open detection at 20 s.
 */
export const NATIVE_HEARTBEAT_INTERVAL_MS = 10_000

/** The platform answers a native `StoreProvider` supplies, and nothing at all
 *  where there is no native connectivity — web must keep every DOM default. */
export function nativeClientSeams(connectivity: NativeConnectivity | undefined): {
  visibility?: VisibilitySource
  onlineEvents?: OnlineEvents
  isOnline?: () => boolean
  heartbeatIntervalMs?: number
} {
  if (connectivity === undefined) return {}
  return {
    visibility: connectivity.visibility,
    onlineEvents: connectivity.onlineEvents,
    isOnline: () => connectivity.isOnline(),
    heartbeatIntervalMs: NATIVE_HEARTBEAT_INTERVAL_MS,
  }
}

/**
 * ONLINE, from a NetInfo state.
 *
 * `isInternetReachable` is null while the probe has not finished, and treating
 * that as offline would hold every queued write for the first seconds of each
 * connection. Unknown is therefore optimistic — the same posture the browser
 * probe has always had — and only a definite `false` counts as offline.
 */
function readOnline(state: NetInfoStateLike): boolean {
  if (state.isConnected === false) return false
  return state.isInternetReachable !== false
}

export function createNativeConnectivity(deps: {
  appState: AppStateLike
  netInfo: NetInfoLike
}): NativeConnectivity {
  let visible = deps.appState.currentState === 'active'
  let online = true
  let hub: NativeConnectivityHub | undefined
  let disposed = false
  const visibilityListeners = new Set<() => void>()
  const onlineListeners = new Set<() => void>()

  const appStateSub = deps.appState.addEventListener('change', (state) => {
    if (disposed) return
    // 'inactive' is iOS on its way to (or back from) the background — the app
    // switcher, the notification shade, an incoming call. Treating it as away
    // costs a reconnect on the way back, which foregrounding does immediately
    // anyway, and buys the correct answer for the case that matters: the person
    // who put the phone down is not watching.
    const nextVisible = state === 'active'
    if (nextVisible === visible) return
    visible = nextVisible
    // TELL THE SERVER FIRST. The engine's subscriber turns this into the
    // presence frame that un-suppresses push, and it has to leave on the socket
    // `suspend` is about to close. Both are synchronous, so this ordering holds.
    for (const listener of [...visibilityListeners]) listener()
    if (visible) hub?.connectNow()
    else hub?.suspend()
  })

  const netInfoUnsubscribe = deps.netInfo.addEventListener((state) => {
    if (disposed) return
    const nextOnline = readOnline(state)
    if (nextOnline === online) return
    online = nextOnline
    if (!online) return
    // The queue gets its chance either way: it drains over HTTP, and a
    // backgrounded app may still be granted a moment to finish sending.
    for (const listener of [...onlineListeners]) listener()
    // The socket does NOT, while the app is in the background — re-dialling
    // there would undo the suspend that backgrounding just performed, and the
    // foreground transition reconnects in any case.
    if (visible) hub?.connectNow()
  })

  return {
    visibility: {
      isVisible: () => visible,
      subscribe: (onChange) => {
        visibilityListeners.add(onChange)
        return () => visibilityListeners.delete(onChange)
      },
    },
    onlineEvents: {
      add: (cb) => {
        onlineListeners.add(cb)
      },
      remove: (cb) => {
        onlineListeners.delete(cb)
      },
    },
    isOnline: () => online,
    attachHub: (attached) => {
      hub = attached
    },
    dispose: () => {
      disposed = true
      hub = undefined
      appStateSub.remove()
      netInfoUnsubscribe()
      visibilityListeners.clear()
      onlineListeners.clear()
    },
  }
}
