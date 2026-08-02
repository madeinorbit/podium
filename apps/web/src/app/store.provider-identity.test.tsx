// @vitest-environment happy-dom
// (the ROOT vitest run executes web tests under node; client-core/react pulls
// terminal-client → xterm addons that need a browser-ish global at import time)
import type { PodiumClientApi } from '@podium/client-core/api'
import { ClientRuntime } from '@podium/client-core/engine'
import { asClientPrincipal, type ClientPrincipal } from '@podium/client-core/principal'
import { StoreProvider, useStore, useStoreSelector } from '@podium/client-core/react'
import { createReplica, memoryStorage } from '@podium/client-core/replica'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/** `MemoryStorage` is not on the package's public surface; the observable
 *  key-set seam is what this suite needs, so it is named structurally. */
type MemoryStorage = ReturnType<typeof memoryStorage>

// react-dom/client's createRoot+act path checks this global.
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

// ---------------------------------------------------------------------------
// Provider ↔ runtime identity (#262 review [spec:SP-3fe2], POD-404): the runtime
// lives as long as its (principal, config, api) prop IDENTITIES. The PRINCIPAL
// is the load-bearing one — a change of person must tear down and rebuild
// transport, replica and outbox — while re-renders with the SAME identities
// (and with churning callback identities) must reuse it. The CORE provider is
// exercised directly so the api and principal props can be injected.
// ---------------------------------------------------------------------------

const makeApi = (): PodiumClientApi =>
  ({
    sync: { changesSince: { query: () => new Promise(() => {}) } },
    discovery: { refreshRepos: { mutate: async () => ({ repositories: [], diagnostics: [] }) } },
    pins: { list: { query: async () => ({ panels: [], worktrees: [], repos: [] }) } },
    tabs: { listOrders: { query: async () => ({}) } },
    settings: {
      get: { query: async () => ({ sidebar: { repoSort: 'lastUsed', repoOrder: [] } }) },
    },
  }) as unknown as PodiumClientApi

/** Sockets, observably. A principal switch must CLOSE the previous person's. */
class FakeWS {
  static opened: FakeWS[] = []
  static closed = 0
  onopen: ((ev: unknown) => void) | null = null
  onmessage: ((ev: { data: unknown }) => void) | null = null
  onclose: ((ev: unknown) => void) | null = null
  onerror: ((ev: unknown) => void) | null = null
  constructor() {
    FakeWS.opened.push(this)
  }
  send(_data: string): void {}
  close(): void {
    FakeWS.closed++
  }
}

let lastHub: unknown = null
function Probe(): null {
  lastHub = useStore().hub
  return null
}

let container: HTMLDivElement
let root: Root
let realWS: typeof WebSocket

beforeEach(() => {
  localStorage.clear()
  lastHub = null
  FakeWS.opened = []
  FakeWS.closed = 0
  realWS = globalThis.WebSocket
  globalThis.WebSocket = FakeWS as unknown as typeof WebSocket
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  globalThis.WebSocket = realWS
  vi.restoreAllMocks()
})

const settle = () =>
  act(async () => {
    await new Promise((r) => setTimeout(r, 5))
  })

type Config = { httpOrigin: string; wsClientUrl: string }

const OPERATOR = asClientPrincipal('operator')

async function render(config: Config, api: PodiumClientApi): Promise<void> {
  act(() => {
    root.render(
      // Inline onFatalError ON PURPOSE: callback identity churn must not
      // rebuild the runtime (callbacks are ref-routed, not keyed).
      // `createReplicaFn` is required since POD-1239 — the runtime no longer
      // builds one for itself off ambient localStorage — and takes the
      // principal since POD-404. This suite is about runtime IDENTITY, so it
      // takes a memory replica, and passes it inline for the same reason
      // onFatalError is inline: neither is part of the rebuild key.
      <StoreProvider
        principal={OPERATOR}
        config={config}
        api={api}
        onFatalError={() => {}}
        createReplicaFn={() => createReplica()}
      >
        <Probe />
      </StoreProvider>,
    )
  })
  await settle()
}

describe('provider runtime identity (#262 review)', () => {
  it('same config/api identities reuse the runtime; a new config object disposes and rebuilds it', async () => {
    const disposeSpy = vi.spyOn(ClientRuntime.prototype, 'dispose')
    const config: Config = { httpOrigin: 'http://x', wsClientUrl: 'ws://x' }
    const api = makeApi()

    await render(config, api)
    const hubA = lastHub
    expect(hubA).not.toBeNull()

    // Re-render with the SAME identities (fresh onFatalError closure): the
    // runtime — and therefore its hub — must be reused, nothing disposed.
    await render(config, api)
    expect(lastHub).toBe(hubA)
    expect(disposeSpy).not.toHaveBeenCalled()

    // A NEW config object (equal values, different identity) replaces the
    // runtime: the old one is disposed, a fresh hub/transport is constructed.
    await render({ ...config }, api)
    expect(disposeSpy).toHaveBeenCalled()
    expect(lastHub).not.toBe(hubA)
  })

  it('a new api identity also disposes and rebuilds the runtime', async () => {
    const disposeSpy = vi.spyOn(ClientRuntime.prototype, 'dispose')
    const config: Config = { httpOrigin: 'http://x', wsClientUrl: 'ws://x' }

    await render(config, makeApi())
    const hubA = lastHub
    await render(config, makeApi())
    expect(disposeSpy).toHaveBeenCalled()
    expect(lastHub).not.toBe(hubA)
  })
})

// ---------------------------------------------------------------------------
// THE PRINCIPAL BOUNDARY (POD-404 AC 3)
//
// The hazard this suite exists for is a VACUOUS PASS: switch principal, assert
// "nothing leaked", and prove nothing because nothing was there to leak. So the
// switch below happens with all four carriers LOADED at that instant —
//
//   a QUEUED WRITE   principal A's layoutSet, persisted in A's namespace
//   a LIVE CURSOR    A's feed cursor, advanced past zero
//   a LIVE SOCKET    A's WebSocket, open
//   a WARM CACHE     a mounted useStoreSelector holding A's selected value
//
// — and each is asserted separately afterwards. The counterfactuals are
// recorded in `docs/architecture/pod-404-provider-principal-binding.md`: which
// single mutation turns which of these red, so that no assertion here is
// decoration riding on another one's failure.
// ---------------------------------------------------------------------------

const ALICE = asClientPrincipal('alice')
const BOB = asClientPrincipal('bob')

/** What the mounted subtree can see, so the assertions read the RENDERED value
 *  rather than the runtime's internals. */
interface Seen {
  hub: unknown
  replica: { getFeedCursor(): unknown } | null
  /** Read through useStoreSelector — this is the CACHE under test. */
  dockTab: string
  outboxSize: number
  setDockTab: (tab: string) => void
}

let seen: Seen

function PrincipalProbe(): null {
  const store = useStore()
  // A SELECTOR with a stable identity across renders, so its per-component
  // cache genuinely survives the switch instead of being reset by a new
  // closure. That is the only version of this assertion that can fail.
  const dockTab = useStoreSelector(selectDockTab)
  seen = {
    hub: store.hub,
    replica: store.replica as unknown as { getFeedCursor(): unknown },
    dockTab,
    outboxSize: store.outboxSize,
    setDockTab: store.setDockTab as unknown as (tab: string) => void,
  }
  return null
}

const selectDockTab = (s: { dockTab: string }): string => s.dockTab

describe('the principal boundary tears down and rebuilds (POD-404)', () => {
  const config: Config = { httpOrigin: 'http://p', wsClientUrl: 'ws://p' }

  /** One storage per principal — the namespace, modelled. */
  const storages = new Map<string, MemoryStorage>()
  const storageFor = (userId: string): MemoryStorage => {
    let s = storages.get(userId)
    if (!s) {
      s = memoryStorage()
      storages.set(userId, s)
    }
    return s
  }

  /** How many sockets had been closed at the instant each principal's replica
   *  was opened — the ORDERING measurement. Teardown of the previous principal
   *  must complete BEFORE the successor's storage is touched; otherwise there is
   *  a window in which two principals' clients are both live over the device. */
  const closedWhenOpened = new Map<string, number>()

  beforeEach(() => {
    storages.clear()
    closedWhenOpened.clear()
  })

  const renderAs = async (principal: ClientPrincipal, api: PodiumClientApi): Promise<void> => {
    act(() => {
      root.render(
        <StoreProvider
          principal={principal}
          config={config}
          api={api}
          onFatalError={() => {}}
          createReplicaFn={(p) => {
            closedWhenOpened.set(p.userId, FakeWS.closed)
            return createReplica({ storage: storageFor(p.userId) })
          }}
        >
          <PrincipalProbe />
        </StoreProvider>,
      )
    })
    await settle()
  }

  /**
   * ONE SWITCH, ALL FOUR CARRIERS LIVE, then one assertion per carrier.
   *
   * Split into separate cases DELIBERATELY. A single case stops at its first
   * failing expectation, so a mutation that breaks the teardown would turn one
   * assertion red and hide whether the other three ever measured anything.
   * Separate cases make the counterfactual legible: each mutation names exactly
   * the set of cases it kills.
   */
  interface Switched {
    hubAlice: unknown
    replicaAlice: { getFeedCursor(): unknown } | null
    dockTabAlice: string
    torn: ClientRuntime[]
    destroySpy: ReturnType<typeof vi.spyOn>
  }

  const switchAliceToBob = async (): Promise<Switched> => {
    const api = makeApi()
    // Capture the instances that get torn down, so the guard itself — not just
    // the fact that teardown was CALLED — can be measured.
    const torn: ClientRuntime[] = []
    const realDestroy = ClientRuntime.prototype.destroy
    const destroySpy = vi.spyOn(ClientRuntime.prototype, 'destroy').mockImplementation(function (
      this: ClientRuntime,
    ) {
      torn.push(this)
      realDestroy.call(this)
    })

    // ---- ALICE, with all four carriers loaded -----------------------------
    await renderAs(ALICE, api)
    const hubAlice = seen.hub
    const replicaAlice = seen.replica
    // (1) a LIVE CURSOR: alice's replica is caught up to 42.
    ;(replicaAlice as unknown as { setFeedCursor(c: number): void }).setFeedCursor(42)
    // (2) a QUEUED WRITE: a layout command with no server to answer it.
    act(() => seen.setDockTab('git'))
    await settle()
    // (3) a WARM CACHE: the selector held a value across at least one render.
    const dockTabAlice = seen.dockTab

    // The setup is itself asserted: an empty queue, a zero cursor or a socket
    // that never opened would make every claim below vacuously true.
    expect(hubAlice, "alice's transport must actually exist").toBeTruthy()
    expect(seen.outboxSize, "alice's queued write must actually be queued").toBeGreaterThan(0)
    expect(replicaAlice?.getFeedCursor(), "alice's cursor must actually be live").toBe(42)
    expect(dockTabAlice, "alice's cached selection must actually differ from the default").toBe(
      'git',
    )
    // (4) a LIVE SOCKET, opened by the runtime's connect timer.
    expect(FakeWS.opened.length, "alice's socket must actually be open").toBeGreaterThan(0)
    expect(FakeWS.closed, "alice's socket must still be open at the switch").toBe(0)
    expect(
      JSON.stringify(storageFor('alice').snapshot()),
      "alice's queued command must actually be durable",
    ).toContain('layoutSet')

    // ---- THE SWITCH -------------------------------------------------------
    await renderAs(BOB, api)
    return { hubAlice, replicaAlice, dockTabAlice, torn, destroySpy }
  }

  it('destroys the previous principal’s runtime rather than re-rendering it', async () => {
    const { destroySpy, torn } = await switchAliceToBob()
    expect(destroySpy, 'the previous principal’s runtime must be destroyed').toHaveBeenCalled()
    expect(torn[0]?.isDestroyed, 'it must be inert, not merely stopped').toBe(true)
  })

  it('reconstructs the transport, and alice’s socket is already down when bob’s store opens', async () => {
    const { hubAlice } = await switchAliceToBob()
    expect(seen.hub, 'bob must not share alice’s transport').not.toBe(hubAlice)
    expect(FakeWS.closed, 'alice’s socket must be closed').toBeGreaterThan(0)
    // ORDER, not just eventuality. React would run the effect cleanup after the
    // successor renders; the irreversible destroy() runs first, so the previous
    // principal's transport is already down at the moment the next principal's
    // store is opened. Without that there is a window in which one device holds
    // two live principals.
    expect(
      closedWhenOpened.get('bob'),
      'alice’s transport must be torn down before bob’s store is opened',
    ).toBeGreaterThan(0)
  })

  it('does not inherit the previous principal’s replica or cursor', async () => {
    // A cursor of 42 over an empty slice is the "permanently caught up" failure
    // the per-principal namespace exists to prevent: the new principal would
    // never ask for the rows it has never seen.
    const { replicaAlice } = await switchAliceToBob()
    expect(seen.replica, 'bob must not share alice’s replica').not.toBe(replicaAlice)
    expect(seen.replica?.getFeedCursor(), 'bob must not inherit alice’s cursor').not.toBe(42)
  })

  it('does not inherit the previous principal’s queued write, and does not destroy it either', async () => {
    await switchAliceToBob()
    expect(seen.outboxSize, 'bob must not inherit alice’s queued write').toBe(0)
    // Key NAMES are the same in both namespaces by design (the namespace is the
    // storage, not the key text), so the claim is about the WRITE itself.
    // "Not adopted" must not silently mean "discarded": alice's unsent work is
    // still hers, waiting in her namespace.
    expect(
      JSON.stringify(storageFor('alice').snapshot()),
      'alice’s queued command must survive in her own namespace',
    ).toContain('layoutSet')
    expect(
      JSON.stringify(storageFor('bob').snapshot()),
      'bob’s namespace must not contain alice’s queued command',
    ).not.toContain('layoutSet')
  })

  it('does not replay the previous principal’s cached selector value', async () => {
    // The component is NOT remounted by the switch and its selector closure is
    // stable, so its per-component cache is genuinely warm across the boundary.
    // It re-derives because the cache keys on snapshot IDENTITY and the new
    // runtime publishes a new snapshot object.
    const { dockTabAlice } = await switchAliceToBob()
    expect(seen.dockTab, 'the selector cache must not replay alice’s value').not.toBe(dockTabAlice)
  })

  it('publishes nothing from the previous principal’s late callback', async () => {
    // A tRPC promise resolving after the switch, a spawn-confirm grace timer, a
    // component still holding one of alice's action closures: all of them reach
    // the same state choke point, and it refuses. Driven, not assumed — the
    // closure below is invoked AFTER the switch and must move nothing.
    const { torn } = await switchAliceToBob()
    const stale = torn[0]
    expect(stale, 'the switch must have torn down alice’s runtime').toBeDefined()
    const staleSnapshot = stale?.getSnapshot()
    act(() => {
      ;(staleSnapshot as unknown as { setPaletteOpen(v: boolean): void }).setPaletteOpen(true)
    })
    expect(stale?.getSnapshot(), 'a previous principal’s late callback must publish nothing').toBe(
      staleSnapshot,
    )
  })

  it('a re-render with an equal-valued principal object keeps the same runtime', async () => {
    // The counterfactual to the switch above: rebinding is keyed on the
    // principal's VALUE, so a platform gate that re-renders with a fresh
    // `{ userId }` literal must not tear the whole client down for the same
    // person. Without this, "rebuilds on principal change" would be
    // indistinguishable from "rebuilds on every render".
    const api = makeApi()
    await renderAs(ALICE, api)
    const hubA = seen.hub
    await renderAs({ userId: 'alice' }, api)
    expect(seen.hub).toBe(hubA)
  })
})

// ---------------------------------------------------------------------------
// FAIL CLOSED BEFORE A PRINCIPAL EXISTS (POD-404 AC 4)
// ---------------------------------------------------------------------------

describe('no principal, no client (POD-404)', () => {
  const config: Config = { httpOrigin: 'http://p', wsClientUrl: 'ws://p' }

  it('builds no replica, opens no socket and renders no children before authentication', async () => {
    let replicaBuilds = 0
    const api = makeApi()
    act(() => {
      root.render(
        <StoreProvider
          principal={null}
          config={config}
          api={api}
          onFatalError={() => {}}
          createReplicaFn={() => {
            replicaBuilds++
            return createReplica({ storage: memoryStorage() })
          }}
          unauthenticated={<span data-testid="gate">signing in</span>}
        >
          <Probe />
        </StoreProvider>,
      )
    })
    await settle()

    // No replica hydration, no feed subscription, no socket, no outbox drain —
    // because there is no runtime at all, which is what makes this structural
    // rather than a list of guards someone must remember to add.
    expect(replicaBuilds, 'no replica may be opened before a principal exists').toBe(0)
    expect(FakeWS.opened.length, 'no socket may be opened before a principal exists').toBe(0)
    // Cold start paints the principal's scoped slice OR NOTHING — never a
    // previously cached world. `Probe` would have thrown had it rendered.
    expect(container.textContent).toBe('signing in')
    expect(lastHub).toBeNull()
  })

  it('starts the client the moment a principal arrives', async () => {
    // The arm that must say YES: without it, the refusal above could be a
    // provider that never works rather than one that fails closed.
    const api = makeApi()
    const storage = memoryStorage()
    const renderWith = async (principal: ClientPrincipal | null) => {
      act(() => {
        root.render(
          <StoreProvider
            principal={principal}
            config={config}
            api={api}
            onFatalError={() => {}}
            createReplicaFn={() => createReplica({ storage })}
          >
            <Probe />
          </StoreProvider>,
        )
      })
      await settle()
    }
    await renderWith(null)
    expect(lastHub).toBeNull()
    await renderWith(asClientPrincipal('carol'))
    expect(lastHub).not.toBeNull()
  })
})
