import { isServerReadiness } from '@podium/model'
import type { ConfigInspection, PodiumConfig } from '@podium/runtime/config'
import { describe, expect, it } from 'vitest'
import { isSetupBootstrapPath } from './readiness-boundary'
import { createServerReadiness } from './server-readiness'

const ok = (config: PodiumConfig): ConfigInspection => ({
  state: 'ok',
  config,
  migrated: [],
})

describe('server readiness derivation', () => {
  it('blocks an unconfigured server', () => {
    const readiness = createServerReadiness({
      bootConfig: {},
      inspect: () => ({ state: 'missing', config: {}, migrated: [] }),
      hasLiveAgentMachine: () => false,
    })
    expect(readiness()).toEqual({
      state: 'unconfigured',
      reason: 'setup_required',
      dataPlane: 'blocked',
    })
  })

  it('blocks persisted setup until a new process activates it', () => {
    const readiness = createServerReadiness({
      bootConfig: {},
      inspect: () => ok({ mode: 'all-in-one', persistence: 'systemd' }),
      hasLiveAgentMachine: () => true,
    })
    expect(readiness()).toEqual({
      state: 'activation_pending',
      reason: 'restart_required',
      dataPlane: 'blocked',
    })
  })

  it('keeps the data plane available but explicitly degraded without an agent machine', () => {
    const readiness = createServerReadiness({
      bootConfig: { mode: 'server' },
      inspect: () => ok({ mode: 'server' }),
      hasLiveAgentMachine: () => false,
    })
    expect(readiness()).toEqual({
      state: 'degraded',
      reason: 'agent_unavailable',
      dataPlane: 'available',
    })
  })

  it('blocks the data plane the instant a live server is told it is now a client', () => {
    // POD-1292, and the reason the desktop's VPS step could not clean up after
    // itself: `setup.connect({mode:'client'})` writes the new mode into the SAME
    // config this running all-in-one server re-reads per request, so every call
    // after it — including the wizard's own checkpoint clear — meets a 503.
    const readiness = createServerReadiness({
      bootConfig: { mode: 'all-in-one' },
      inspect: () => ok({ mode: 'client', serverUrl: 'wss://vps.example.com' }),
      hasLiveAgentMachine: () => true,
    })
    expect(readiness()).toEqual({
      state: 'activation_pending',
      reason: 'restart_required',
      dataPlane: 'blocked',
    })
    // Setup may still finish; ordinary UI state may not, and must not be
    // smuggled in to make the wizard's bookkeeping survive the flip.
    expect(isSetupBootstrapPath('/trpc/setup.connect')).toBe(true)
    expect(isSetupBootstrapPath('/trpc/layout.clear')).toBe(false)
  })

  it('reports ready only after configuration and an agent machine are both live', () => {
    const readiness = createServerReadiness({
      bootConfig: { mode: 'all-in-one', persistence: 'systemd' },
      inspect: () => ok({ mode: 'all-in-one', persistence: 'systemd' }),
      hasLiveAgentMachine: () => true,
    })
    expect(readiness()).toEqual({ state: 'ready', reason: null, dataPlane: 'available' })
  })

  it('keeps an activated server available but explicit when its live config becomes corrupt', () => {
    const readiness = createServerReadiness({
      bootConfig: { mode: 'server' },
      inspect: () => ({ state: 'corrupt', config: {}, migrated: [], error: 'bad json' }),
      hasLiveAgentMachine: () => true,
    })
    expect(readiness()).toEqual({
      state: 'degraded',
      reason: 'configuration_invalid',
      dataPlane: 'available',
    })
  })

  it('rejects contradictory public state combinations', () => {
    expect(isServerReadiness({ state: 'ready', reason: null, dataPlane: 'available' })).toBe(true)
    expect(isServerReadiness({ state: 'ready', reason: null, dataPlane: 'blocked' })).toBe(false)
    expect(
      isServerReadiness({
        state: 'unconfigured',
        reason: 'agent_unavailable',
        dataPlane: 'blocked',
      }),
    ).toBe(false)
  })
})
