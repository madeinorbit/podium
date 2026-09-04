import { controlPlaneAvailable, isServerReadiness } from '@podium/model'
import type { ConfigInspection, PodiumConfig } from '@podium/runtime/config'
import { describe, expect, it } from 'vitest'
import { isControlPlanePath, isSetupBootstrapPath } from './readiness-boundary'
import { createServerReadiness } from './server-readiness'

const ok = (config: PodiumConfig): ConfigInspection => ({
  state: 'ok',
  config,
  migrated: [],
})

describe('server readiness derivation', () => {
  it('blocks an unconfigured server, control plane included', () => {
    const readiness = createServerReadiness({
      bootConfig: {},
      inspect: () => ({ state: 'missing', config: {}, migrated: [] }),
      hasLiveAgentMachine: () => false,
    })
    expect(readiness()).toEqual({
      state: 'unconfigured',
      reason: 'setup_required',
      dataPlane: 'blocked',
      // No account exists yet, so there is nothing to log in to; the host-local
      // setup bootstrap is this state's door and stays the only one.
      controlPlane: 'blocked',
    })
    expect(controlPlaneAvailable(readiness())).toBe(false)
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
      // POD-2766: refusing WORK is the intent. Refusing the operator who could
      // press restart was collateral, and this is the bit that ends it.
      controlPlane: 'available',
      stale: ['mode'],
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
      controlPlane: 'available',
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
      controlPlane: 'available',
      stale: ['mode'],
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
    expect(readiness()).toEqual({
      state: 'ready',
      reason: null,
      dataPlane: 'available',
      controlPlane: 'available',
    })
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
      controlPlane: 'available',
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
    // A server may not advertise a control plane its state does not have, in
    // either direction — that combination would let a client open a login screen
    // against an unconfigured box, or withhold one from a recoverable box.
    expect(
      isServerReadiness({
        state: 'unconfigured',
        reason: 'setup_required',
        dataPlane: 'blocked',
        controlPlane: 'available',
      }),
    ).toBe(false)
    expect(
      isServerReadiness({
        state: 'activation_pending',
        reason: 'restart_required',
        dataPlane: 'blocked',
        controlPlane: 'blocked',
      }),
    ).toBe(false)
    // Stale boot fields ARE what activation_pending means; any other state
    // naming them is contradicting itself.
    expect(
      isServerReadiness({
        state: 'ready',
        reason: null,
        dataPlane: 'available',
        stale: ['mode'],
      }),
    ).toBe(false)
    expect(
      isServerReadiness({
        state: 'activation_pending',
        reason: 'restart_required',
        dataPlane: 'blocked',
        stale: ['publicUrl'],
      }),
    ).toBe(false)
  })

  it('reads an older server, which publishes no control plane, as having none', () => {
    // Absence must fail CLOSED. A server that predates the split really did shut
    // login while blocked, so a new client optimistically offering one would put
    // the operator back in front of a login that cannot succeed.
    const legacy = {
      state: 'activation_pending',
      reason: 'restart_required',
      dataPlane: 'blocked',
    } as const
    expect(isServerReadiness(legacy)).toBe(true)
    expect(controlPlaneAvailable(legacy)).toBe(false)
  })
})

describe('which config changes make this process stale [POD-2766]', () => {
  const boot = { mode: 'all-in-one', persistence: 'systemd' } as const

  it('says nothing changed when only a credential, a URL or telemetry moved', () => {
    // THE INCIDENT, INVERTED. `setup.complete` carries a password, a public URL
    // and telemetry answers beside the two boot-relevant fields; none of those
    // three describe the shape of this process, so none may block it.
    const readiness = createServerReadiness({
      bootConfig: boot,
      inspect: () =>
        ok({
          ...boot,
          publicUrl: 'https://podium.example.com',
          telemetry: { usage: 'off', crash: 'off' },
          auth: { openMode: false },
        }),
      hasLiveAgentMachine: () => true,
    })
    expect(readiness()).toMatchObject({ state: 'ready', dataPlane: 'available' })
  })

  it('still trips, and names the field, when persistence changes', () => {
    const readiness = createServerReadiness({
      bootConfig: boot,
      inspect: () => ok({ ...boot, persistence: 'detached' }),
      hasLiveAgentMachine: () => true,
    })
    expect(readiness()).toMatchObject({
      state: 'activation_pending',
      dataPlane: 'blocked',
      stale: ['persistence'],
    })
  })

  it('still trips, and names the field, when mode changes', () => {
    const readiness = createServerReadiness({
      bootConfig: boot,
      inspect: () => ok({ ...boot, mode: 'server' }),
      hasLiveAgentMachine: () => true,
    })
    expect(readiness()).toMatchObject({
      state: 'activation_pending',
      dataPlane: 'blocked',
      stale: ['mode'],
    })
  })

  it('names both when both changed, in the declared order', () => {
    const readiness = createServerReadiness({
      bootConfig: boot,
      inspect: () => ok({ mode: 'server', persistence: 'detached' }),
      hasLiveAgentMachine: () => true,
    })
    expect(readiness()).toMatchObject({ stale: ['mode', 'persistence'] })
  })

  it('treats a persistence answer appearing where there was none as a real change', () => {
    // The exact shape of the incident: a box that recorded no persistence (config
    // v2: "not headless-managed") had `systemd` written over it by a call that
    // meant to set a password. The GUARD is right to trip here — the fix is that
    // the write no longer happens (see applySetup), not that the guard relaxes.
    const readiness = createServerReadiness({
      bootConfig: { mode: 'all-in-one' },
      inspect: () => ok({ mode: 'all-in-one', persistence: 'systemd' }),
      hasLiveAgentMachine: () => true,
    })
    expect(readiness()).toMatchObject({
      state: 'activation_pending',
      stale: ['persistence'],
    })
  })

  it('serves the restart on the control plane and nothing else', () => {
    expect(isControlPlanePath('/trpc/setup.activate')).toBe(true)
    expect(isControlPlanePath('/trpc/sessions.list')).toBe(false)
    // A batch is only control-plane if EVERY member is: one restart must not
    // carry a data-plane call through the boundary beside it.
    expect(isControlPlanePath('/trpc/setup.activate,sessions.list')).toBe(false)
    expect(isControlPlanePath('/readiness')).toBe(false)
  })
})

describe('an env-set mode (PDM-26)', () => {
  const ok = (config: PodiumConfig): ConfigInspection => ({ state: 'ok', config, migrated: [] })

  it('is ready with an EMPTY config file — the container never writes one', () => {
    const readiness = createServerReadiness({
      bootConfig: {},
      envMode: 'server',
      hasLiveAgentMachine: () => true,
      inspect: () => ok({}),
    })
    expect(readiness()).toMatchObject({ state: 'ready', dataPlane: 'available' })
  })

  it('is degraded, never unconfigured, when no agent machine is live', () => {
    const readiness = createServerReadiness({
      bootConfig: {},
      envMode: 'server',
      hasLiveAgentMachine: () => false,
      inspect: () => ok({}),
    })
    expect(readiness()).toMatchObject({
      state: 'degraded',
      reason: 'agent_unavailable',
      dataPlane: 'available',
    })
  })

  it('is not stale when the FILE names a different mode — env is boot-time and wins', () => {
    const readiness = createServerReadiness({
      bootConfig: {},
      envMode: 'server',
      hasLiveAgentMachine: () => true,
      inspect: () => ok({ mode: 'all-in-one' }),
    })
    expect(readiness().state).toBe('ready')
  })

  it('still reports persistence staleness under an env mode', () => {
    const readiness = createServerReadiness({
      bootConfig: { persistence: 'detached' },
      envMode: 'server',
      hasLiveAgentMachine: () => true,
      inspect: () => ok({ persistence: 'systemd' }),
    })
    expect(readiness()).toMatchObject({
      state: 'activation_pending',
      reason: 'restart_required',
      stale: ['persistence'],
    })
  })

  it('a corrupt file is degraded rather than unconfigured — this process has a mode', () => {
    const readiness = createServerReadiness({
      bootConfig: {},
      envMode: 'server',
      hasLiveAgentMachine: () => true,
      inspect: () => ({ state: 'corrupt', config: {}, error: 'bad json', migrated: [] }),
    })
    expect(readiness()).toMatchObject({
      state: 'degraded',
      reason: 'configuration_invalid',
      dataPlane: 'available',
    })
  })

  it('without envMode, nothing changes', () => {
    const readiness = createServerReadiness({
      bootConfig: {},
      hasLiveAgentMachine: () => true,
      inspect: () => ok({}),
    })
    expect(readiness().state).toBe('unconfigured')
  })
})
