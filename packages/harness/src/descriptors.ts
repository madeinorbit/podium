/**
 * Served harness descriptors (POD-4475, spec §4.2/§4.7) — HOST side.
 *
 * The daemon builds one descriptor per registry harness and serves it inside
 * `inventoryReport`; the server forwards it and clients render from it. The
 * presentation and static catalog come from each manifest's own
 * `descriptor`/`catalog` sections (spec §4.1/§4.5, POD-4538: required Adapter
 * sections stated in `adapters/<harness>/{descriptor,catalog}.ts` and held on
 * the manifest — the SAME rows the bundled browser fallback reads: one
 * statement, two readers). Everything machine-varying is DERIVED here, never
 * stated:
 *
 * - capabilities (implemented, §4.7 fact one): read off the manifest's own
 *   `capabilities` — the adapter's declaration, not a second list;
 * - sections: `sectionStatusesOf(manifest)` — the support-matrix walk, so the
 *   served flags and the matrix can never disagree;
 * - available (§4.7 fact two): this machine's inventory (installed, logged in).
 *
 * Effective-for-this-session (§4.7 fact three) is NEVER a descriptor field:
 * it travels with the live session handle. Composer rules are functions and
 * are NOT served at all — bundled browser CODE stays in the browser entry
 * for harnesses the client build knows, and interpretation is authoritative
 * on the daemon.
 *
 * TOTALITY IS A TYPECHECK. `AgentManifest` requires `descriptor` and
 * `catalog`, so a harness added to the registry without them fails
 * compilation — there is no skip path here and no second enumeration to
 * drift. The fixture harness is excluded by registry design (never in
 * `AGENT_MANIFESTS`), not by a filter here.
 */

import type { Inventory } from '@podium/model'
import type { HarnessDescriptorWire } from '@podium/protocol'
import { AGENT_MANIFESTS, sectionStatusesOf } from './registry.js'
import type { AgentManifest } from './manifest.js'

/** Wire schema version this builder emits. */
export const HARNESS_DESCRIPTOR_SCHEMA_VERSION = 1

/**
 * One served descriptor per registry harness: adapter DATA plus
 * machine-varying availability from this inventory. Total over
 * `AGENT_MANIFESTS` — every manifest carries its descriptor and catalog
 * sections, so nothing is skipped and nothing is invented.
 */
export function buildServedDescriptors(inventory: Inventory): HarnessDescriptorWire[] {
  const out: HarnessDescriptorWire[] = []
  for (const manifest of Object.values(AGENT_MANIFESTS)) {
    const agent = inventory.agents.find((candidate) => candidate.kind === manifest.kind)
    out.push({
      ...assembleDescriptor(manifest),
      available: {
        installed: agent?.installed === true,
        loggedIn: agent?.login.state === 'in',
      },
      sections: sectionStatusesOf(manifest).map(({ section, supported }) => ({
        section,
        supported,
      })),
    })
  }
  return out
}

/**
 * The BUNDLED derivation: the same assembly with no machine — no
 * `available`, no `sections` (both optional; their absence renders).
 * Capabilities are DERIVED from the manifests here, never stated: the
 * generator (`scripts/harness-descriptors.ts`) serialises this function's
 * output into the committed snapshot the browser entry bundles, and the
 * staleness check refuses a snapshot that no longer matches. Drift is
 * impossible rather than merely detected.
 */
export function buildBundledDescriptors(): HarnessDescriptorWire[] {
  return Object.values(AGENT_MANIFESTS).map(assembleDescriptor)
}

function assembleDescriptor(manifest: AgentManifest): HarnessDescriptorWire {
  const data = manifest.descriptor
  const catalog = manifest.catalog
  return {
    schemaVersion: HARNESS_DESCRIPTOR_SCHEMA_VERSION,
    kind: manifest.kind as string,
    // Stated data, never defaulted here: the ONE provider fallback rule for
    // older frames without this field lives in `providerOf` (`browser.ts`,
    // POD-4542) and must stay the single rule.
    provider: data.provider,
    label: data.label,
    shortLabel: data.shortLabel,
    icon: { ...data.icon },
    ...(data.brand ? { brand: { ...data.brand } } : {}),
    capabilities: {
      argvPrompt: manifest.capabilities.argvPrompt,
      effort: manifest.capabilities.effortFlag !== 'none',
      systemPrompt: manifest.capabilities.systemPromptFlag,
    },
    catalog: {
      models: catalog.models.map((model) => ({ ...model })),
      efforts: [...catalog.efforts],
      liveMerge: catalog.liveMerge,
    },
    ...(data.login.command !== null ||
    data.login.installHint !== null ||
    data.login.signedOutHint !== null
      ? {
          login: {
            ...(data.login.command !== null ? { command: data.login.command } : {}),
            ...(data.login.installHint !== null ? { installHint: data.login.installHint } : {}),
            ...(data.login.signedOutHint !== null
              ? { signedOutHint: data.login.signedOutHint }
              : {}),
          },
        }
      : {}),
    ...(data.defaults.model !== null ||
    data.defaults.effort !== null ||
    data.defaults.panelMode !== null
      ? {
          defaults: {
            ...(data.defaults.model !== null ? { model: data.defaults.model } : {}),
            ...(data.defaults.effort !== null ? { effort: data.defaults.effort } : {}),
            ...(data.defaults.panelMode !== null ? { panelMode: data.defaults.panelMode } : {}),
          },
        }
      : {}),
  }
}
