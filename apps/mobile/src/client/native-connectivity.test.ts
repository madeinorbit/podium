import { describe, expect, it } from 'vitest'
import {
  type AppStateLike,
  type AppStateStatus,
  createNativeConnectivity,
  NATIVE_HEARTBEAT_INTERVAL_MS,
  type NativeConnectivityHub,
  nativeClientSeams,
  type NetInfoLike,
  type NetInfoStateLike,
} from './native-connectivity'

/**
 * What the phone knows and the shared client cannot see (POD-2055 WP-C2+C3).
 *
 * Driven through fakes of the two RN modules rather than the modules
 * themselves: the lane has no native runtime, and the controller is where every
 * decision worth testing lives — the RN wrappers around it (`.native.ts`) do
 * nothing but hand it AppState and NetInfo.
 */

function fakeAppState(initial: AppStateStatus = 'active'): AppStateLike & {
  go(state: AppStateStatus): void
  listeners(): number
} {
  const handlers = new Set<(state: AppStateStatus) => void>()
  let current = initial
  return {
    get currentState() {
      return current
    },
    addEventListener: (_type, handler) => {
      handlers.add(handler)
      return { remove: () => handlers.delete(handler) }
    },
    go: (state) => {
      current = state
      for (const handler of [...handlers]) handler(state)
    },
    listeners: () => handlers.size,
  }
}

function fakeNetInfo(initial: NetInfoStateLike = { isConnected: true, isInternetReachable: true }): NetInfoLike & {
  go(state: NetInfoStateLike): void
  listeners(): number
} {
  const handlers = new Set<(state: NetInfoStateLike) => void>()
  let current = initial
  return {
    addEventListener: (handler) => {
      handlers.add(handler)
      handler(current)
      return () => handlers.delete(handler)
    },
    go: (state) => {
      current = state
      for (const handler of [...handlers]) handler(state)
    },
    listeners: () => handlers.size,
  }
}

/** Records the transport calls in order — the order IS the contract. */
function fakeHub(): NativeConnectivityHub & { calls: string[] } {
  const calls: string[] = []
  return {
    calls,
    connectNow: () => calls.push('connectNow'),
    suspend: () => calls.push('suspend'),
  }
}

function setup(
  options: { appState?: ReturnType<typeof fakeAppState>; netInfo?: ReturnType<typeof fakeNetInfo> } = {},
) {
  const appState = options.appState ?? fakeAppState()
  const netInfo = options.netInfo ?? fakeNetInfo()
  const hub = fakeHub()
  const connectivity = createNativeConnectivity({ appState, netInfo })
  // What the engine does with the visibility source: report every change to the
  // server. Recorded through the same log as the transport calls, because
  // "visibility first, then close" is the property under test.
  connectivity.visibility.subscribe(() => {
    hub.calls.push(`visible:${connectivity.visibility.isVisible()}`)
  })
  connectivity.attachHub(hub)
  return { appState, netInfo, hub, connectivity }
}

describe('app lifecycle', () => {
  it('starts visible when the app is already in the foreground', () => {
    const { connectivity } = setup()
    expect(connectivity.visibility.isVisible()).toBe(true)
  })

  it('tells the server it is away BEFORE suspending the transport', () => {
    // Order is the whole point: setVisible(false) is what un-suppresses this
    // person's push notifications, and it has to leave on the socket that
    // suspend is about to close.
    const { appState, hub } = setup()
    appState.go('background')
    expect(hub.calls).toEqual(['visible:false', 'suspend'])
  })

  it('treats iOS inactive as away — it is the step on the way to background', () => {
    const { appState, hub, connectivity } = setup()
    appState.go('inactive')
    expect(connectivity.visibility.isVisible()).toBe(false)
    expect(hub.calls).toEqual(['visible:false', 'suspend'])
  })

  it('comes back on foreground: visible again, and reconnecting at once', () => {
    const { appState, hub } = setup()
    appState.go('background')
    hub.calls.length = 0
    appState.go('active')
    expect(hub.calls).toEqual(['visible:true', 'connectNow'])
  })

  it('ignores a repeat of the state it is already in', () => {
    const { appState, hub } = setup()
    appState.go('active')
    expect(hub.calls).toEqual([])
  })
})

describe('network reachability', () => {
  it('reads as offline while NetInfo says there is no connection', () => {
    const netInfo = fakeNetInfo({ isConnected: false, isInternetReachable: false })
    const { connectivity } = setup({ netInfo })
    expect(connectivity.isOnline()).toBe(false)
  })

  it('is optimistic when reachability is merely unknown', () => {
    const netInfo = fakeNetInfo({ isConnected: true, isInternetReachable: null })
    const { connectivity } = setup({ netInfo })
    expect(connectivity.isOnline()).toBe(true)
  })

  it('announces the restore to the outbox and reconnects the socket', () => {
    const netInfo = fakeNetInfo({ isConnected: false, isInternetReachable: false })
    const { hub, connectivity } = setup({ netInfo })
    const drains: string[] = []
    connectivity.onlineEvents.add(() => drains.push('drain'))

    netInfo.go({ isConnected: true, isInternetReachable: true })
    expect(connectivity.isOnline()).toBe(true)
    expect(drains).toEqual(['drain'])
    expect(hub.calls).toEqual(['connectNow'])
  })

  it('says nothing on a NetInfo report that changes nothing', () => {
    const netInfo = fakeNetInfo({ isConnected: true, isInternetReachable: true })
    const { hub, connectivity } = setup({ netInfo })
    const drains: string[] = []
    connectivity.onlineEvents.add(() => drains.push('drain'))

    netInfo.go({ isConnected: true, isInternetReachable: true })
    expect(drains).toEqual([])
    expect(hub.calls).toEqual([])
  })

  it('does not wake the transport while the app is in the background', () => {
    // The queued writes still get their chance — that is HTTP, and the OS may
    // grant a moment of background time. Re-dialling the socket would undo the
    // suspend the backgrounding just performed.
    const netInfo = fakeNetInfo({ isConnected: false, isInternetReachable: false })
    const { appState, hub, connectivity } = setup({ netInfo })
    const drains: string[] = []
    connectivity.onlineEvents.add(() => drains.push('drain'))
    appState.go('background')
    hub.calls.length = 0

    netInfo.go({ isConnected: true, isInternetReachable: true })
    expect(drains).toEqual(['drain'])
    expect(hub.calls).toEqual([])
  })
})

describe('teardown', () => {
  it('releases both platform subscriptions', () => {
    const { appState, netInfo, connectivity } = setup()
    expect(appState.listeners()).toBe(1)
    expect(netInfo.listeners()).toBe(1)
    connectivity.dispose()
    expect(appState.listeners()).toBe(0)
    expect(netInfo.listeners()).toBe(0)
  })

  it('stops driving a hub it no longer has', () => {
    const { appState, hub, connectivity } = setup()
    connectivity.dispose()
    appState.go('background')
    expect(hub.calls).toEqual([])
  })
})

describe('the props the store provider is given', () => {
  it('hands over all four platform answers on native', () => {
    const { connectivity, appState } = setup()
    const seams = nativeClientSeams(connectivity)
    expect(seams.visibility).toBe(connectivity.visibility)
    expect(seams.onlineEvents).toBe(connectivity.onlineEvents)
    expect(seams.heartbeatIntervalMs).toBe(NATIVE_HEARTBEAT_INTERVAL_MS)
    // A live probe, not a snapshot of one moment.
    expect(seams.isOnline?.()).toBe(true)
    appState.go('background')
    expect(seams.visibility?.isVisible()).toBe(false)
  })

  it('hands over nothing on web, so every browser default survives', () => {
    // The same provider runs as react-native-web, where the DOM answers are the
    // right ones and this file must not get in their way.
    expect(nativeClientSeams(undefined)).toEqual({})
  })

  it('slows the heartbeat, and only on a phone', () => {
    expect(NATIVE_HEARTBEAT_INTERVAL_MS).toBe(10_000)
  })
})
