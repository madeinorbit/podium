/**
 * Model harness slices pinned to the manifests (POD-4540, 4.R deviation D3).
 *
 * `packages/model/src/entities/agent.ts` holds one closed set of harness names
 * plus short per-purpose slices of it (COST, HANDOFF, CLOUD, USAGE,
 * OBSERVATION_PROVIDER, PORTABLE_CREDENTIAL, AGENT_CHOICE). Each slice restates
 * a capability fact the adapters already declare — and agent.ts is the file the
 * vendor-boundary lint EXEMPTS, so a restatement there is invisible to the
 * ratchet. This file is the identity check that closes the hole: for every
 * slice, the member set must equal the set DERIVED from `AGENT_MANIFESTS`, so
 * flipping a manifest without the slice fails here and names the harness.
 *
 * The pattern is `browser.test.ts` (the HARNESS_NO_TOOLS identity test):
 * import the registry from a TEST is fine; nothing here ships to a bundle.
 *
 * Derivation per slice (each `it` names its own):
 * - COST / USAGE — the `usage` section is supported. Cost transcripts are the
 *   usage harvest read back, so both slices restate the same section fact;
 *   they stay separate consts (per agent.ts: capability membership evolves per
 *   concern) and so get one `it` each over the same derivation.
 * - HANDOFF — `capabilities.handoff === true`, via harnessSupportsHandoff.
 * - CLOUD — `capabilities.cloud === true`, via harnessSupportsCloud. "Runs in
 *   the cloud" IS a capability the manifests state, so this pins like the
 *   others rather than hiding as policy (coordinator note, tenth slice).
 * - OBSERVATION_PROVIDER — a causal provider is declared, i.e.
 *   `capabilities.observationProvider !== 'none'`, via
 *   harnessObservationProvider. The `instrumentation` section coincides today
 *   (supported exactly for the same three) but answers a different question
 *   (hook wiring, not provider identity), so the provider fact is the pin.
 * - PORTABLE_CREDENTIAL — the `credentials` section is supported: the slice is
 *   the harness members of the portable-credential BUNDLE kinds (read by
 *   `PortableCredentialKind`), and grok ships a bundle. It is NOT the
 *   propagation predicate: `harnessSupportsCredentialPropagation` answers the
 *   narrower "may this file cross machines" (per-file `propagatable`; grok
 *   declares false), so deriving the slice from it would fail on grok today —
 *   and rightly so, because the bundle exists even where it never propagates.
 * - AGENT_CHOICE — POLICY, not capability: the closed set minus the explicit
 *   exclusion below. `pi` is deliberately unoffered (a product decision, per
 *   the slice docblock), so the test states the exclusion as data beside the
 *   assertion rather than deriving it.
 *
 * `COST_FULL_ATTRIBUTION_HARNESS` (a singleton, not a slice) is out of scope:
 * cost-attribution completeness is a cost-layer measurement claim with no
 * manifest field; `agent.test.ts` pins its value.
 */

import {
  AGENT_CHOICE_HARNESS_KINDS,
  BUILTIN_HARNESS_KINDS,
  type BuiltinHarnessKind,
  CLOUD_HARNESS_KINDS,
  COST_HARNESS_KINDS,
  HANDOFF_HARNESS_KINDS,
  OBSERVATION_PROVIDER_KINDS,
  PORTABLE_CREDENTIAL_HARNESS_KINDS,
  USAGE_HARNESS_KINDS,
} from '@podium/model'
import { describe, expect, it } from 'vitest'
import { declaredValue } from './manifest.js'
import {
  AGENT_MANIFESTS,
  harnessObservationProvider,
  harnessSupportsCloud,
  harnessSupportsHandoff,
} from './registry.js'

/** The closed set in registry order, for filtering into derived sets. */
function allKinds(): BuiltinHarnessKind[] {
  return Object.keys(AGENT_MANIFESTS) as BuiltinHarnessKind[]
}

/** Harnesses whose manifest supports the `usage` section (COST + USAGE pin). */
function usageSupportedKinds(): BuiltinHarnessKind[] {
  return allKinds().filter((kind) => declaredValue(AGENT_MANIFESTS[kind].usage) !== undefined)
}

/** Harnesses whose manifest supports the `credentials` section (PORTABLE pin). */
function credentialsSupportedKinds(): BuiltinHarnessKind[] {
  return allKinds().filter(
    (kind) => declaredValue(AGENT_MANIFESTS[kind].credentials) !== undefined,
  )
}

/**
 * The AGENT_CHOICE policy exclusion, stated as data (POD-4540 Goal): `pi` is
 * deliberately NOT offered by the "which harness starts a generic new agent"
 * preference — adding it is a product decision, not a registry sync.
 */
const AGENT_CHOICE_POLICY_EXCLUSION: readonly BuiltinHarnessKind[] = ['pi']

describe('model harness slices pinned to the manifests (POD-4540)', () => {
  it('COST_HARNESS_KINDS equals the harnesses with a supported usage section', () => {
    expect([...COST_HARNESS_KINDS].sort()).toEqual(usageSupportedKinds().sort())
  })

  it('HANDOFF_HARNESS_KINDS equals the harnesses with capabilities.handoff', () => {
    const fromManifests = allKinds().filter((kind) => harnessSupportsHandoff(kind))
    expect([...HANDOFF_HARNESS_KINDS].sort()).toEqual(fromManifests.sort())
  })

  it('CLOUD_HARNESS_KINDS equals the harnesses with capabilities.cloud', () => {
    const fromManifests = allKinds().filter((kind) => harnessSupportsCloud(kind))
    expect([...CLOUD_HARNESS_KINDS].sort()).toEqual(fromManifests.sort())
  })

  it('USAGE_HARNESS_KINDS equals the harnesses with a supported usage section', () => {
    expect([...USAGE_HARNESS_KINDS].sort()).toEqual(usageSupportedKinds().sort())
  })

  it('OBSERVATION_PROVIDER_KINDS equals the harnesses declaring a causal provider', () => {
    const fromManifests = allKinds().filter(
      (kind) => harnessObservationProvider(kind) !== undefined,
    )
    expect([...OBSERVATION_PROVIDER_KINDS].sort()).toEqual(fromManifests.sort())
  })

  it('PORTABLE_CREDENTIAL_HARNESS_KINDS equals the harnesses with a supported credentials section', () => {
    expect([...PORTABLE_CREDENTIAL_HARNESS_KINDS].sort()).toEqual(
      credentialsSupportedKinds().sort(),
    )
  })

  it('AGENT_CHOICE_HARNESS_KINDS equals the closed set minus the pi policy exclusion', () => {
    const excluded = new Set<string>(AGENT_CHOICE_POLICY_EXCLUSION)
    const fromPolicy = [...BUILTIN_HARNESS_KINDS].filter((kind) => !excluded.has(kind))
    expect([...AGENT_CHOICE_HARNESS_KINDS].sort()).toEqual(fromPolicy.sort())
  })
})
