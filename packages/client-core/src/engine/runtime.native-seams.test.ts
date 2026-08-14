// @vitest-environment happy-dom
//
// Under a DOM on purpose: every seam below has a browser default, and a test
// with no `document` could not tell "the injected source was used" from "the
// default fell through to the same answer". Here the document says visible and
// the injected source says otherwise, so only one of them can be the one that
// spoke.
/**
 * The platform seams a native client needs from the engine (POD-2055 WP-C).
 *
 * The engine used to read three browser facts directly: `document`'s visibility,
 * `window`'s `online` event, and `navigator.onLine`. On React Native the first
 * is missing (so a phone reports itself permanently on screen, which suppresses
 * its own push notifications), and the other two are absent or a lie. All three
 * become injectable here; the composition root that knows the platform supplies
 * them, and the browser defaults are unchanged.
 */

import { asUserId } from '@podium/model'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { PodiumClientApi } from '../api'
import type { OnlineEvents } from '../outbox'
import { asClientPrincipal } from '../principal'
import { createReplica, memoryStorage } from '../replica/replica'
import type { SocketHub, SocketHubOptions } from '../socket-transport'
import type { VisibilitySource } from './visibility'
import { createClientRuntime } from './runtime'

const settle = (ms = 25): Promise<void> => new Promise((r) => setTimeout(r, ms))

class FakeHub {
  readonly visibility: boolean[] = []
  connectNowCalls = 0
  private handlers = new Map<string, Set<(...a: unknown[]) => void>>()
  on(kind: string, cb: (...a: unknown[]) => void): () => void {
    let set = this.handlers.get(kind)
    if (!set) {
      set = new Set()
      this.handlers.set(kind, set)
    }
    set.add(cb)
    return () => set?.delete(cb)
  }
  connectionHealth(): { status: 'ok' | 'degraded' | 'down'; rttMs: number | null; since: number } {
    return { status: 'down', rttMs: null, since: 0 }
  }
  seedMetadata(): void {}
  connect(): void {}
  connectNow(): void {
    this.connectNowCalls += 1
  }
  dispose(): void {}
  setViewState(): void {}
  setVisible(visible: boolean): void {
    this.visibility.push(visible)
  }
  sendSessionDraft(): void {}
}

/** Just enough surface for boot + the one queued mutation these tests make.
 *  Every other boot fetch rejects and is swallowed, as it is on a cold start. */
function makeApi(): { api: PodiumClientApi; layoutSets: unknown[] } {
  const layoutSets: unknown[] = []
  const api = {
    sync: {
      changesSince: {
        query: async () => ({
          kind: 'snapshot',
          sessions: [],
          issues: [],
          conversations: [],
          diagnostics: [],
          cursor: 0,
        }),
      },
    },
    layout: {
      set: {
        mutate: async (input: unknown) => {
          layoutSets.push(input)
          return {}
        },
      },
    },
  }
  return { api: api as unknown as PodiumClientApi, layoutSets }
}

/** A visibility source the test drives by hand — the shape a native provider
 *  implements over AppState. */
function fakeVisibility(initial: boolean): VisibilitySource & {
  set(visible: boolean): void
  subscribers(): number
} {
  let visible = initial
  const listeners = new Set<() => void>()
  return {
    isVisible: () => visible,
    subscribe: (onChange) => {
      listeners.add(onChange)
      return () => listeners.delete(onChange)
    },
    set: (next) => {
      visible = next
      for (const cb of [...listeners]) cb()
    },
    subscribers: () => listeners.size,
  }
}

function fakeOnlineEvents(): OnlineEvents & { fire(): void; subscribers(): number } {
  const listeners = new Set<() => void>()
  return {
    add: (cb) => listeners.add(cb),
    remove: (cb) => listeners.delete(cb),
    fire: () => {
      for (const cb of [...listeners]) cb()
    },
    subscribers: () => listeners.size,
  }
}

const runtimes: Array<{ dispose(): void; destroy(): void }> = []

function makeEngine(
  init: {
    visibility?: VisibilitySource
    onlineEvents?: OnlineEvents
    isOnline?: () => boolean
    heartbeatIntervalMs?: number
    hub?: FakeHub
    api?: PodiumClientApi
  } = {},
): { engine: ReturnType<typeof createClientRuntime>; hub: FakeHub; hubOptions: SocketHubOptions[] } {
  const hub = init.hub ?? new FakeHub()
  const hubOptions: SocketHubOptions[] = []
  const engine = createClientRuntime({
    principal: asClientPrincipal(asUserId('operator')),
    config: { httpOrigin: 'http://x', wsClientUrl: 'ws://x' },
    api: init.api ?? makeApi().api,
    onFatalError: () => {},
    createReplicaFn: () => createReplica({ storage: memoryStorage() }),
    createHub: (options) => {
      hubOptions.push(options)
      return hub as unknown as SocketHub
    },
    ...(init.visibility ? { visibility: init.visibility } : {}),
    ...(init.onlineEvents ? { onlineEvents: init.onlineEvents } : {}),
    ...(init.isOnline ? { isOnline: init.isOnline } : {}),
    ...(init.heartbeatIntervalMs !== undefined
      ? { heartbeatIntervalMs: init.heartbeatIntervalMs }
      : {}),
  })
  runtimes.push(engine)
  return { engine, hub, hubOptions }
}

afterEach(() => {
  for (const runtime of runtimes.splice(0)) runtime.destroy()
  vi.restoreAllMocks()
})

describe('visibility comes from the injected source', () => {
  it('reports the source, not the document', () => {
    // happy-dom says this client is on screen. The source says it is not, and
    // the source is the one the server hears — which is the whole fix: a
    // backgrounded phone that keeps claiming to be watching never gets its
    // own push notifications.
    expect(document.visibilityState).toBe('visible')
    const { engine, hub } = makeEngine({ visibility: fakeVisibility(false) })
    engine.start()
    expect(hub.visibility.at(-1)).toBe(false)
  })

  it('re-reports when the source says it changed', () => {
    const visibility = fakeVisibility(false)
    const { engine, hub } = makeEngine({ visibility })
    engine.start()
    visibility.set(true)
    expect(hub.visibility.at(-1)).toBe(true)
  })

  it('reconnects the moment the client is looked at again', () => {
    // The other half of WP-B's foreground nudge, now reached through the
    // injected source rather than through `visibilitychange` — which is what
    // makes a phone returning from the background get it too.
    const visibility = fakeVisibility(false)
    const { engine, hub } = makeEngine({ visibility })
    engine.start()
    const before = hub.connectNowCalls
    visibility.set(true)
    expect(hub.connectNowCalls).toBe(before + 1)
    visibility.set(false)
    expect(hub.connectNowCalls).toBe(before + 1)
  })

  it('unsubscribes from the source when the runtime is torn down', () => {
    const visibility = fakeVisibility(true)
    const { engine } = makeEngine({ visibility })
    engine.start()
    expect(visibility.subscribers()).toBe(1)
    engine.dispose()
    expect(visibility.subscribers()).toBe(0)
  })

  it('still follows the document when nothing is injected', () => {
    const { engine, hub } = makeEngine()
    engine.start()
    expect(hub.visibility.at(-1)).toBe(true)
  })
})

describe('the outbox takes its connectivity from the injected seams', () => {
  it('holds a queued write while the injected probe says offline, and drains on the injected event', async () => {
    const { api, layoutSets } = makeApi()
    const onlineEvents = fakeOnlineEvents()
    const { engine } = makeEngine({ api, onlineEvents, isOnline: () => false })
    engine.start()
    engine.getSnapshot().setDockTab('git')
    await settle()
    expect(engine.outbox.pending()).toHaveLength(1)
    expect(layoutSets).toHaveLength(0)

    onlineEvents.fire()
    await settle()
    expect(layoutSets).toHaveLength(1)
    expect(engine.outbox.pending()).toHaveLength(0)
  })

  it('releases the injected subscription on dispose', () => {
    const onlineEvents = fakeOnlineEvents()
    const { engine } = makeEngine({ onlineEvents, isOnline: () => false })
    engine.start()
    expect(onlineEvents.subscribers()).toBe(1)
    engine.destroy()
    expect(onlineEvents.subscribers()).toBe(0)
  })
})

describe('heartbeat cadence', () => {
  it('hands the hub the interval the platform asked for', () => {
    const { hubOptions } = makeEngine({ heartbeatIntervalMs: 10_000 })
    expect(hubOptions.at(0)?.heartbeatIntervalMs).toBe(10_000)
  })

  it('says nothing when the platform has no opinion, so the hub keeps its own default', () => {
    const { hubOptions } = makeEngine()
    expect(hubOptions.at(0)?.heartbeatIntervalMs).toBeUndefined()
  })
})
