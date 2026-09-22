/**
 * Served harness descriptors (POD-4475, spec §4.2/§4.7) — HOST side.
 *
 * The daemon builds one descriptor per registry harness and serves it inside
 * `inventoryReport`; the server forwards it and clients render from it. The
 * presentation and static catalog come from the per-harness
 * `adapters/<harness>/{descriptor,catalog}.ts` data files (the SAME rows the
 * bundled browser fallback reads — one statement, two readers). Everything
 * machine-varying is DERIVED here, never stated:
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
 */

import type { Inventory } from '@podium/model'
import type { HarnessDescriptorWire } from '@podium/protocol'
import { AGENT_MANIFESTS, sectionStatusesOf } from './registry.js'
import type {
  HarnessCatalogData,
  HarnessDescriptorData,
} from './descriptor-types.js'
import type { AgentManifest } from './manifest.js'
import { claudeCodeCatalog } from './adapters/claude-code/catalog.js'
import { claudeCodeDescriptor } from './adapters/claude-code/descriptor.js'
import { codexCatalog } from './adapters/codex/catalog.js'
import { codexDescriptor } from './adapters/codex/descriptor.js'
import { cursorCatalog } from './adapters/cursor/catalog.js'
import { cursorDescriptor } from './adapters/cursor/descriptor.js'
import { grokCatalog } from './adapters/grok/catalog.js'
import { grokDescriptor } from './adapters/grok/descriptor.js'
import { opencodeCatalog } from './adapters/opencode/catalog.js'
import { opencodeDescriptor } from './adapters/opencode/descriptor.js'
import { piCatalog } from './adapters/pi/catalog.js'
import { piDescriptor } from './adapters/pi/descriptor.js'

/** Wire schema version this builder emits. */
export const HARNESS_DESCRIPTOR_SCHEMA_VERSION = 1

const DESCRIPTOR_DATA: readonly HarnessDescriptorData[] = [
  claudeCodeDescriptor,
  codexDescriptor,
  cursorDescriptor,
  grokDescriptor,
  opencodeDescriptor,
  piDescriptor,
]

const CATALOG_DATA: readonly HarnessCatalogData[] = [
  claudeCodeCatalog,
  codexCatalog,
  cursorCatalog,
  grokCatalog,
  opencodeCatalog,
  piCatalog,
]

/** Per-harness presentation by open kind id — keyed off each row's own
 *  `kind`, so adding a harness is adding a row, never editing a key set. */
export function descriptorDataByKind(): ReadonlyMap<string, HarnessDescriptorData> {
  return new Map(DESCRIPTOR_DATA.map((data) => [data.kind as string, data]))
}

/** Per-harness static catalog by open kind id. */
export function catalogDataByKind(): ReadonlyMap<string, HarnessCatalogData> {
  return new Map(CATALOG_DATA.map((data) => [data.kind as string, data]))
}

/**
 * One served descriptor per registry harness: adapter DATA plus
 * machine-varying availability from this inventory. A harness with no
 * descriptor row is skipped rather than invented — an unknown harness is
 * rendered from a NEWER daemon's report, never guessed here.
 */
export function buildServedDescriptors(inventory: Inventory): HarnessDescriptorWire[] {
  const descriptors = descriptorDataByKind()
  const catalogs = catalogDataByKind()
  const out: HarnessDescriptorWire[] = []
  for (const manifest of Object.values(AGENT_MANIFESTS)) {
    const assembled = assembleDescriptor(manifest, descriptors, catalogs)
    if (!assembled) continue
    const agent = inventory.agents.find((candidate) => candidate.kind === manifest.kind)
    out.push({
      ...assembled,
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
  const descriptors = descriptorDataByKind()
  const catalogs = catalogDataByKind()
  const out: HarnessDescriptorWire[] = []
  for (const manifest of Object.values(AGENT_MANIFESTS)) {
    const assembled = assembleDescriptor(manifest, descriptors, catalogs)
    if (assembled) out.push(assembled)
  }
  return out
}

function assembleDescriptor(
  manifest: AgentManifest,
  descriptors: ReadonlyMap<string, HarnessDescriptorData>,
  catalogs: ReadonlyMap<string, HarnessCatalogData>,
): HarnessDescriptorWire | undefined {
  const kind = manifest.kind as string
  const data = descriptors.get(kind)
  const catalog = catalogs.get(kind)
  if (!data || !catalog) return undefined
  return {
    schemaVersion: HARNESS_DESCRIPTOR_SCHEMA_VERSION,
    kind,
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
    ...(data.defaults.model !== null || data.defaults.effort !== null
      ? {
          defaults: {
            ...(data.defaults.model !== null ? { model: data.defaults.model } : {}),
            ...(data.defaults.effort !== null ? { effort: data.defaults.effort } : {}),
          },
        }
      : {}),
  }
}
