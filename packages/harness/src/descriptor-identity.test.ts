/**
 * The identity that lets adapter descriptor rows state client facts without
 * drifting from the manifests (POD-4475, HARNESS_NO_TOOLS shape).
 *
 * `adapters/<harness>/{descriptor,catalog}.ts` restate three facts each
 * manifest already declares (`argvPrompt`, `effortFlag`, `systemPromptFlag`)
 * because the browser entry cannot load a manifest. That is deliberate, and
 * this file is the reason it is safe: every row's stated capabilities are
 * asserted equal to what the served builder derives from the manifest, for
 * every harness — so a manifest that flips without its row fails here and
 * names the harness. The served path itself never reads the stated row (see
 * `descriptors.ts`); the row serves only builds that cannot reach the
 * registry.
 *
 * Also asserts coverage: every registry harness has both rows, keyed by its
 * own kind, so a harness that lands without descriptor data fails here
 * rather than vanishing from pickers silently.
 */
import { BUILTIN_HARNESS_KINDS } from '@podium/model'
import { describe, expect, it } from 'vitest'
import { BUNDLED_DESCRIPTORS } from './browser.js'
import { AGENT_MANIFESTS } from './registry.js'
import { buildServedDescriptors, catalogDataByKind, descriptorDataByKind } from './descriptors.js'

describe('adapter descriptor rows track their manifests', () => {
  it('every registry harness has a descriptor row and a catalog row', () => {
    const descriptors = descriptorDataByKind()
    const catalogs = catalogDataByKind()
    for (const kind of BUILTIN_HARNESS_KINDS) {
      expect(descriptors.get(kind)?.kind, `${kind} descriptor row`).toBe(kind)
      expect(catalogs.get(kind)?.kind, `${kind} catalog row`).toBe(kind)
    }
  })

  it('stated client capabilities equal the manifest derivation', () => {
    const descriptors = descriptorDataByKind()
    for (const [kind, manifest] of Object.entries(AGENT_MANIFESTS)) {
      const stated = descriptors.get(kind)?.capabilities
      expect(stated, `${kind} capabilities row`).toEqual({
        argvPrompt: manifest.capabilities.argvPrompt,
        effort: manifest.capabilities.effortFlag !== 'none',
        systemPrompt: manifest.capabilities.systemPromptFlag,
      })
    }
  })
  it('rows carry drawable presentation (label, icon, catalog rule)', () => {
    for (const data of descriptorDataByKind().values()) {
      expect(data.label.length).toBeGreaterThan(0)
      expect(data.shortLabel.length).toBeGreaterThan(0)
      expect(data.icon.id.length).toBeGreaterThan(0)
      expect(data.icon.viewBox.length).toBeGreaterThan(0)
      expect(data.icon.d.length).toBeGreaterThan(0)
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
