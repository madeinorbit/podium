// @vitest-environment happy-dom
// (the ROOT vitest run executes web tests under node; client-core/react pulls
// terminal-client → xterm addons that need a browser-ish global at import time)
import type { PodiumClientApi } from '@podium/client-core/api'
import { Engine } from '@podium/client-core/engine'
import { StoreProvider, useStore } from '@podium/client-core/react'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// react-dom/client's createRoot+act path checks this global.
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

// ---------------------------------------------------------------------------
// Provider ↔ engine identity (#262 review [spec:SP-3fe2]): the engine lives as
// long as its (config, api) prop IDENTITIES — the old provider rebuilt
// hub/outbox/actions when those changed, so the engine must be disposed and
// reconstructed too, while re-renders with the SAME identities (and with
// churning callback identities) must reuse it. The CORE provider is exercised
// directly so the api prop can be injected.
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

class FakeWS {
  onopen: ((ev: unknown) => void) | null = null
  onmessage: ((ev: { data: unknown }) => void) | null = null
  onclose: ((ev: unknown) => void) | null = null
  onerror: ((ev: unknown) => void) | null = null
  send(_data: string): void {}
  close(): void {}
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

async function render(config: Config, api: PodiumClientApi): Promise<void> {
  act(() => {
    root.render(
      // Inline onFatalError ON PURPOSE: callback identity churn must not
      // rebuild the engine (callbacks are ref-routed, not keyed).
      <StoreProvider config={config} api={api} onFatalError={() => {}}>
        <Probe />
      </StoreProvider>,
    )
  })
  await settle()
}

describe('provider engine identity (#262 review)', () => {
  it('same config/api identities reuse the engine; a new config object disposes and rebuilds it', async () => {
    const disposeSpy = vi.spyOn(Engine.prototype, 'dispose')
    const config: Config = { httpOrigin: 'http://x', wsClientUrl: 'ws://x' }
    const api = makeApi()

    await render(config, api)
    const hubA = lastHub
    expect(hubA).not.toBeNull()

    // Re-render with the SAME identities (fresh onFatalError closure): the
    // engine — and therefore its hub — must be reused, nothing disposed.
    await render(config, api)
    expect(lastHub).toBe(hubA)
    expect(disposeSpy).not.toHaveBeenCalled()

    // A NEW config object (equal values, different identity) replaces the
    // engine: the old one is disposed, a fresh hub/transport is constructed.
    await render({ ...config }, api)
    expect(disposeSpy).toHaveBeenCalledTimes(1)
    expect(lastHub).not.toBe(hubA)
  })

  it('a new api identity also disposes and rebuilds the engine', async () => {
    const disposeSpy = vi.spyOn(Engine.prototype, 'dispose')
    const config: Config = { httpOrigin: 'http://x', wsClientUrl: 'ws://x' }

    await render(config, makeApi())
    const hubA = lastHub
    await render(config, makeApi())
    expect(disposeSpy).toHaveBeenCalledTimes(1)
    expect(lastHub).not.toBe(hubA)
  })
})
