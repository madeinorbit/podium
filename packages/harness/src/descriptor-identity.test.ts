/**
 * The coverage behind the generated snapshot (POD-4475).
 *
 * `adapters/<harness>/{descriptor,catalog}.ts` state presentation (labels,
 * brand, icon, login copy, static catalog) — facts no manifest declares —
 * while client capability flags are DERIVED from the manifests at generation
 * time (`scripts/harness-descriptors.ts`, harness-matrix.ts pattern). This
 * file asserts every registry harness HAS both rows with drawable content;
 * the staleness check (`bun run harness:descriptors:check`, CI) refuses a
 * snapshot that no longer matches the derivation. Drift is impossible
 * rather than merely detected: there is no second statement to compare.
 */
import { BUILTIN_HARNESS_KINDS } from '@podium/model'
import { describe, expect, it } from 'vitest'
import { BUNDLED_DESCRIPTORS } from './browser.js'
import { AGENT_MANIFESTS } from './registry.js'
import {
  buildBundledDescriptors,
  buildServedDescriptors,
  catalogDataByKind,
  descriptorDataByKind,
} from './descriptors.js'

describe('adapter descriptor rows track their manifests', () => {
  it('every registry harness has a descriptor row and a catalog row', () => {
    const descriptors = descriptorDataByKind()
    const catalogs = catalogDataByKind()
    for (const kind of BUILTIN_HARNESS_KINDS) {
      expect(descriptors.get(kind)?.kind, `${kind} descriptor row`).toBe(kind)
      expect(catalogs.get(kind)?.kind, `${kind} catalog row`).toBe(kind)
    }
  })

  it('the committed snapshot matches the derivation (in-suite staleness guard)', () => {
    // The CI check (`bun run harness:descriptors:check`) guards the file;
    // this asserts the same invariant inside the suite so a stale snapshot
    // fails here too, naming the harness.
    expect([...BUNDLED_DESCRIPTORS]).toEqual(buildBundledDescriptors())
    expect(AGENT_MANIFESTS).toBeDefined()
  })
  it('rows carry drawable presentation (label, icon, catalog rule) and a provider', () => {
    for (const data of descriptorDataByKind().values()) {
      expect(data.label.length).toBeGreaterThan(0)
      expect(data.shortLabel.length).toBeGreaterThan(0)
      expect(data.icon.id.length).toBeGreaterThan(0)
      expect(data.icon.viewBox.length).toBeGreaterThan(0)
      expect(data.icon.d.length).toBeGreaterThan(0)
      // POD-4529: the Accounts hub reads the provider off the served
      // descriptor instead of a hand-written table, so every row states one.
      const provider = (data as { provider?: unknown }).provider
      expect(typeof provider === 'string' && provider.length > 0, `${data.kind} provider`).toBe(
        true,
      )
    }
    for (const catalog of catalogDataByKind().values()) {
      expect(catalog.liveMerge.length).toBeGreaterThan(0)
    }
  })

  it('bundled fallback equals the served shape minus machine-varying fields', () => {
    // The two assemblies (bundled in browser.ts, served in descriptors.ts)
    // read the same adapter rows; availability and the matrix derivation are
    // the only differences. An empty inventory stands in for "no machine".
    const served = buildServedDescriptors({ os: 'linux', arch: 'arm64', agents: [], tools: [] })
    const stripped = served.map(({ available: _a, sections: _s, ...rest }) => {
      void _a
      void _s
      return rest
    })
    expect(stripped).toEqual([...BUNDLED_DESCRIPTORS])
  })
})
