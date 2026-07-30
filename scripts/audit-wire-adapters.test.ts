/**
 * THE RUNNING-OBJECT HALF of the wire-adapter audit (POD-308).
 *
 * `scripts/audit-wire-adapters.ts` resolves no modules — it reads source text,
 * which is the only way to claim "nothing outside the allowlist imports this".
 * But an absence claim over source text is satisfied perfectly by a registry
 * that is EMPTY: POD-732's standard. So this half instantiates the real shipped
 * edge and asserts PRESENCE and REFUSAL on the running object — that the window
 * is actually covered, that the v1 adapter is actually registered and actually
 * carries an expiry, and that the registry actually rejects the inversion.
 *
 * Neither half is sufficient. The source half cannot see an object; this half
 * cannot see a file nobody imported.
 */

import {
  MIN_SUPPORTED_VERSION,
  WIRE_VERSION,
  WireVersionAdapterRegistry,
  WireVersionError,
} from '@podium/protocol'
import { describe, expect, it } from 'vitest'
import { LEGACY_WIRE_V1_EXPIRY, LegacyWireV1Adapter } from '../apps/server/src/gateway/legacy-wire-v1-adapter'
import { WireFeedEdge } from '../apps/server/src/gateway/wire-feed-edge'
import { runChecks } from './audit-wire-adapters'

const edge = () => new WireFeedEdge({ diagnostics: () => [] })

describe('the shipped edge, as a running object', () => {
  it('covers the whole advertised window — it would refuse to boot otherwise', () => {
    expect(() => edge()).not.toThrow()
    expect(edge().support()).toEqual({ wire: WIRE_VERSION, min: MIN_SUPPORTED_VERSION })
  })

  it('actually HOLDS a v1 translation, so the absence claims are not vacuous', () => {
    // Without this, "no unexpected call sites" would be equally true of a server
    // that shipped no legacy support at all — and every stale PWA would be
    // silently broken while the gate stayed green.
    const adapter = new LegacyWireV1Adapter({ diagnostics: () => [] })
    expect(adapter.version).toBe(1)
    expect(adapter.expiry).toBe(LEGACY_WIRE_V1_EXPIRY)
    expect(adapter.expiry?.expiresWhenMinSupportedReaches).toBeGreaterThan(MIN_SUPPORTED_VERSION)
  })

  it('reports nothing expired at the shipped floor', () => {
    expect(edge().expiredAdapters()).toEqual([])
  })

  it('rejects the inversion on the real registry class', () => {
    const registry = new WireVersionAdapterRegistry<unknown, unknown, void>()
    expect(() =>
      registry.register({
        version: 1,
        name: 'pretend-permanent-v1',
        expiry: null,
        translate: () => [],
      }),
    ).toThrow(WireVersionError)
  })
})

describe('the source-text half agrees with the tree it ships', () => {
  it('finds nothing on the real repository', () => {
    const findings = runChecks({
      read: (path) => {
        try {
          return require('node:fs').readFileSync(`${import.meta.dirname}/../${path}`, 'utf8')
        } catch {
          return null
        }
      },
      sources: () => [],
    })
    expect(findings).toEqual([])
  })
})
