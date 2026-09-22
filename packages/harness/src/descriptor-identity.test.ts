/**
 * The coverage behind the generated snapshot (POD-4475, POD-4538).
 *
 * Each manifest carries its `descriptor`/`catalog` sections (spec §4.1/§4.5:
 * required Adapter sections) — presentation (labels, brand, icon, login
 * copy, static catalog) the manifest holds beside the behaviour it owns —
 * while client capability flags are DERIVED from the manifests at generation
 * time (`scripts/harness-descriptors.ts`, harness-matrix.ts pattern). This
 * file asserts every registry harness HAS both sections with drawable
 * content; the staleness check (`bun run harness:descriptors:check`, CI)
 * refuses a snapshot that no longer matches the derivation. Drift is
 * impossible rather than merely detected: there is no second statement to
 * compare. A harness added without the sections fails `tsc` on its manifest,
 * not this test — completeness is a typecheck.
 */
import { BUILTIN_HARNESS_KINDS } from '@podium/model'
import { describe, expect, it } from 'vitest'
import { BUNDLED_DESCRIPTORS } from './browser.js'
import { AGENT_MANIFESTS, harnessDisplayName } from './registry.js'
import { buildBundledDescriptors, buildServedDescriptors } from './descriptors.js'
import { quotaAgentLabel } from './inventory/usage.js'
import { installableTargets } from './inventory/install.js'

describe('adapter descriptor sections track their manifests', () => {
  it('every registry harness states a descriptor and a catalog section', () => {
    for (const kind of BUILTIN_HARNESS_KINDS) {
      const manifest = AGENT_MANIFESTS[kind]
      expect(manifest.descriptor.kind, `${kind} descriptor section`).toBe(kind)
      expect(manifest.catalog.kind, `${kind} catalog section`).toBe(kind)
    }
  })

  it('the committed snapshot matches the derivation (in-suite staleness guard)', () => {
    // The CI check (`bun run harness:descriptors:check`) guards the file;
    // this asserts the same invariant inside the suite so a stale snapshot
    // fails here too, naming the harness.
    expect([...BUNDLED_DESCRIPTORS]).toEqual(buildBundledDescriptors())
    expect(AGENT_MANIFESTS).toBeDefined()
  })
  it('sections carry drawable presentation (label, icon, catalog rule) and a provider', () => {
    for (const kind of BUILTIN_HARNESS_KINDS) {
      const data = AGENT_MANIFESTS[kind].descriptor
      expect(data.label.length).toBeGreaterThan(0)
      expect(data.shortLabel.length).toBeGreaterThan(0)
      expect(data.icon.id.length).toBeGreaterThan(0)
      expect(data.icon.viewBox.length).toBeGreaterThan(0)
      expect(data.icon.d.length).toBeGreaterThan(0)
      // POD-4529: the Accounts hub reads the provider off the served
      // descriptor instead of a hand-written table, so every row states one.
      expect(typeof data.provider === 'string' && data.provider.length > 0, `${kind} provider`).toBe(
        true,
      )
    }
    for (const kind of BUILTIN_HARNESS_KINDS) {
      const catalog = AGENT_MANIFESTS[kind].catalog
      expect(catalog.liveMerge.length).toBeGreaterThan(0)
    }
  })

  it('one label statement: host labels read the descriptor shortLabel', () => {
    // POD-4538: `displayName` is gone; quota, install and menu labels read
    // `descriptor.shortLabel` through the manifest — a second spelling would
    // be a second statement of one fact.
    for (const kind of BUILTIN_HARNESS_KINDS) {
      const shortLabel = AGENT_MANIFESTS[kind].descriptor.shortLabel
      expect(harnessDisplayName(kind), `${kind} harnessDisplayName`).toBe(shortLabel)
      expect(quotaAgentLabel(kind), `${kind} quotaAgentLabel`).toBe(shortLabel)
    }
    for (const target of installableTargets()) {
      const shortLabel = AGENT_MANIFESTS[target.kind as keyof typeof AGENT_MANIFESTS].descriptor
        .shortLabel
      expect(target.displayName, `${target.kind} install label`).toBe(shortLabel)
    }
  })

  it('bundled fallback equals the served shape minus machine-varying fields', () => {
    // The two assemblies (bundled in browser.ts, served in descriptors.ts)
    // read the same manifest sections; availability and the matrix derivation are
    // the only differences. An empty inventory stands in for "no machine".
    const served = buildServedDescriptors({ os: 'linux', arch: 'arm64', agents: [], tools: [] })
    const stripped = served.map(({ available: _a, sections: _s, ...rest }) => {
      void _a
      void _s
      return rest
    })
    expect(stripped).toEqual([...BUNDLED_DESCRIPTORS])
  })

  it('only the headed-native harness states a panel intent (POD-4541)', () => {
    // The web "+" menu reads `defaults.panelMode` instead of naming a
    // harness: OpenCode states `native`, every other registry harness omits
    // it (no override — today's rendering).
    const byKind = new Map(BUNDLED_DESCRIPTORS.map((d) => [d.kind, d]))
    expect(byKind.get('opencode')?.defaults?.panelMode).toBe('native')
    for (const [kind, descriptor] of byKind) {
      if (kind === 'opencode') continue
      expect(descriptor.defaults?.panelMode, `${kind} panelMode`).toBeUndefined()
    }
    const served = buildServedDescriptors({ os: 'linux', arch: 'arm64', agents: [], tools: [] })
    expect(served.find((d) => d.kind === 'opencode')?.defaults?.panelMode).toBe('native')
  })
})
