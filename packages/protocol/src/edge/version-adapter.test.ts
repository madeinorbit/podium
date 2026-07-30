/**
 * THE PERMANENT SURFACE, TESTED AS PERMANENT.
 *
 * The asymmetry POD-308 exists to get right is easy to state and easy to invert:
 * the MECHANISM outlives every release, the concrete adapters do not. So the
 * tests here are mostly about what the registry REFUSES, and each refusal is
 * checked against a positive control in the same block — a suite that only ever
 * asserts rejection is the defect class this run has paid for five times
 * (POD-351, POD-391, POD-732, POD-306, POD-311), because it passes just as well
 * against a registry that refuses everything.
 */

import { describe, expect, it } from 'vitest'
import { MIN_SUPPORTED_VERSION, SUPPORTED_WIRE_VERSIONS, WIRE_VERSION } from '../version'
import {
  isUpgradeRequired,
  upgradeRequired,
  type WireVersionAdapter,
  WireVersionAdapterRegistry,
  WireVersionError,
} from './version-adapter'

type Frame = { kind: string }

const adapter = (over: Partial<WireVersionAdapter<Frame, string>>): WireVersionAdapter<Frame, string> => ({
  version: 2,
  name: 'identity-v2',
  expiry: null,
  translate: (frame) => [frame.kind],
  ...over,
})

const legacy = (over: Partial<WireVersionAdapter<Frame, string>> = {}) =>
  adapter({
    version: 1,
    name: 'legacy-v1',
    expiry: {
      expiresWhenMinSupportedReaches: 2,
      deleteByPhase: 'POD-279 Phase 7',
      rationale: 'translates the pre-rewrite wire for cached PWA builds',
    },
    ...over,
  })

const window2 = { wire: 2, min: 1, versions: [1, 2] }

describe('the window is covered or the server does not boot', () => {
  it('passes when every advertised version has an adapter — it can say YES', () => {
    const registry = new WireVersionAdapterRegistry<Frame, string>(window2)
      .register(adapter({}))
      .register(legacy())
    expect(() => registry.assertCoversWindow()).not.toThrow()
    expect(registry.versions()).toEqual([1, 2])
  })

  it('refuses at the composition root when an advertised version has nothing', () => {
    const registry = new WireVersionAdapterRegistry<Frame, string>(window2).register(adapter({}))
    // The failure this replaces: the handshake ACCEPTS a v1 peer (the window
    // says 1 is fine) and then serves it nothing, which from the peer's side is
    // indistinguishable from a broken deploy.
    expect(() => registry.assertCoversWindow()).toThrow(/version\(s\) 1 with no adapter/)
  })

  it('refuses two adapters for one version', () => {
    const registry = new WireVersionAdapterRegistry<Frame, string>(window2).register(legacy())
    expect(() => registry.register(legacy({ name: 'legacy-v1-again' }))).toThrow(WireVersionError)
  })
})

describe('the mechanism is permanent and the concrete adapters are not', () => {
  it('lets the CURRENT version declare itself permanent', () => {
    // The identity path is not a translation and outlives every one of them.
    expect(() =>
      new WireVersionAdapterRegistry<Frame, string>(window2).register(adapter({})),
    ).not.toThrow()
  })

  it('refuses a legacy translator that declares itself permanent', () => {
    // The exact inversion of the asymmetry, refused at registration rather than
    // left for a reviewer to notice.
    expect(() =>
      new WireVersionAdapterRegistry<Frame, string>(window2).register(
        legacy({ expiry: null }),
      ),
    ).toThrow(/declares itself PERMANENT/)
  })

  it('refuses an expiry on the current wire version', () => {
    expect(() =>
      new WireVersionAdapterRegistry<Frame, string>(window2).register(
        adapter({ expiry: legacy().expiry }),
      ),
    ).toThrow(/schedule the deletion of the wire itself/)
  })

  it('refuses an expiry condition that can never arrive', () => {
    // `expiresWhenMinSupportedReaches: 1` on a v1 adapter is satisfied the day it
    // is written and never again — a condition shaped so it cannot fire is a
    // comment wearing a gate's clothes.
    expect(() =>
      new WireVersionAdapterRegistry<Frame, string>(window2).register(
        legacy({ expiry: { ...legacy().expiry!, expiresWhenMinSupportedReaches: 1 } }),
      ),
    ).toThrow(/can never arrive/)
  })
})

describe('expiry is mechanical: the floor rising is what fires it', () => {
  const registry = () =>
    new WireVersionAdapterRegistry<Frame, string>(window2).register(adapter({})).register(legacy())

  it('reports nothing expired while the floor is still below the condition', () => {
    expect(registry().expired(1)).toEqual([])
  })

  it('reports the legacy adapter the moment the floor reaches its condition', () => {
    expect(registry().expired(2).map((a) => a.name)).toEqual(['legacy-v1'])
  })

  it('never reports the current version’s identity adapter', () => {
    expect(registry().expired(99).map((a) => a.name)).toEqual(['legacy-v1'])
  })
})

describe('426 is the backstop beyond the window', () => {
  it('resolves an in-window peer to its adapter', () => {
    const registry = new WireVersionAdapterRegistry<Frame, string>(window2)
      .register(adapter({}))
      .register(legacy())
    const resolved = registry.resolve(1)
    expect(isUpgradeRequired(resolved)).toBe(false)
    expect((resolved as WireVersionAdapter<Frame, string>).name).toBe('legacy-v1')
  })

  it('answers 426 with the window for a peer below it', () => {
    const registry = new WireVersionAdapterRegistry<Frame, string>(window2).register(adapter({}))
    const resolved = registry.resolve(0)
    expect(isUpgradeRequired(resolved)).toBe(true)
    expect(resolved).toMatchObject({ status: 426, offered: 0, support: { min: 1, wire: 2 } })
  })

  it('answers 426 for a peer ABOVE the window too', () => {
    // A newer client against an un-updated server. Same refusal, and the message
    // must say which direction — "update and reconnect" is wrong advice here.
    expect(upgradeRequired(9, { wire: 2, min: 1 }).message).toMatch(/too new/)
    expect(upgradeRequired(0, { wire: 2, min: 1 }).message).toMatch(/too old/)
  })
})

describe('the shipped window', () => {
  it('is derived once, not re-derived by callers', () => {
    expect(SUPPORTED_WIRE_VERSIONS).toEqual([1, 2])
    expect(SUPPORTED_WIRE_VERSIONS.at(0)).toBe(MIN_SUPPORTED_VERSION)
    expect(SUPPORTED_WIRE_VERSIONS.at(-1)).toBe(WIRE_VERSION)
  })
})
