import { hasDomWindow } from '../platform-globals'
import type { SocketHub, WireSkew } from '../socket-transport'

/** An outage edge, not a health poll: degraded alone never replaces a server. */
export function onReconnect(
  subscribe: (listener: (health: { status: 'ok' | 'degraded' | 'down' }) => void) => () => void,
  reconnected: () => void,
): () => void {
  let wasDown = false
  return subscribe((health) => {
    if (health.status === 'down') {
      wasDown = true
      return
    }
    if (health.status !== 'ok' || !wasDown) return
    wasDown = false
    reconnected()
  })
}

export interface WakeSource {
  subscribe(hidden: () => void, shown: () => void): () => void
}

/** Browser lifecycle plug for the mobile web build's zombie Safari socket. */
export function browserWakeSource(): WakeSource | undefined {
  if (!hasDomWindow() || typeof document === 'undefined') return undefined
  return {
    subscribe: (hidden, shown) => {
      const visibility = (): void => {
        if (document.visibilityState === 'hidden') hidden()
        else shown()
      }
      window.addEventListener('pagehide', hidden)
      window.addEventListener('pageshow', shown)
      document.addEventListener('visibilitychange', visibility)
      return () => {
        window.removeEventListener('pagehide', hidden)
        window.removeEventListener('pageshow', shown)
        document.removeEventListener('visibilitychange', visibility)
      }
    },
  }
}

export interface LiveConnectionObservers {
  connectivity?: { attachHub(hub: Pick<SocketHub, 'connectNow' | 'suspend'>): void | (() => void) }
  wakeSource?: WakeSource
  onDisconnected?: () => void
  onWireSkew?: (skew: WireSkew) => void
  onReconnect?: () => void
}

/** Both roots use this attachment. It owns subscriptions, not the hub or store;
 * hiding a page must never close its replica. Disposal is StrictMode-safe. */
export function observeLiveConnection(
  hub: SocketHub,
  options: LiveConnectionObservers,
): () => void {
  const stops: (() => void)[] = []
  const detach = options.connectivity?.attachHub(hub)
  if (detach) stops.push(detach)
  if (options.onWireSkew) stops.push(hub.onWireSkew(options.onWireSkew))
  if (options.onReconnect)
    stops.push(onReconnect(hub.onConnectionHealth.bind(hub), options.onReconnect))
  if (options.onDisconnected) {
    let observedInitialHealth = false
    stops.push(
      hub.onConnectionHealth(() => {
        if (observedInitialHealth && !hub.connected) options.onDisconnected?.()
        observedInitialHealth = true
      }),
    )
  }
  if (options.wakeSource) {
    let hidden = false
    stops.push(
      options.wakeSource.subscribe(
        () => {
          hidden = true
        },
        () => {
          if (!hidden) return
          hidden = false
          hub.wake()
        },
      ),
    )
  }
  return () => {
    for (const stop of stops.splice(0).reverse()) stop()
  }
}
