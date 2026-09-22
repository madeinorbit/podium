/**
 * `packages/harness/src/descriptor-types.ts` — the DESCRIPTOR DATA SHAPES (POD-4475).
 *
 * Mechanism-free leaf (same shape as `transcript-types.ts`): pure types, no
 * runtime imports, so BOTH sides may hold it — the per-harness
 * `adapters/<harness>/{descriptor,catalog}.ts` data files, the host-side
 * served builder (`descriptors.ts`), and the browser entry (`browser.ts`).
 * Nothing here names a process, a socket, or a file: the wire descriptor is
 * DATA and the bundled browser CODE (composer rules) is not served.
 *
 * The wire results (`HarnessDescriptorWire` in `@podium/protocol`) are the
 * serialised form of these; the adapter files are the per-harness statements
 * the bundled fallback and the served builder both read, so web and mobile
 * never keep a second copy.
 */

import type { BuiltinHarnessKind } from '@podium/model'

/** One static model entry: what the CLI accepts before any live probe. */
export interface StaticModelEntry {
  value: string
  label: string
  /**
   * Per-model effort levels from an authoritative source, mirroring the live
   * `ModelChoiceWire.efforts`: `[]` = the model supports no effort,
   * `undefined` = unknown (the client falls back to the harness ladder).
   */
  efforts?: string[]
}

/** Chip ground + mark ink (mobile KIND_TONE values, verbatim). */
export interface HarnessBrandTone {
  bg: string
  fg: string
}

/** Serializable mark: the brand path; clients draw it with their own element. */
export interface HarnessIconData {
  id: string
  viewBox: string
  d: string
}

/** Sign-in copy shown when a harness is missing or signed out. */
export interface HarnessLoginCopy {
  /** One-line sign-in command, copied to the clipboard. Null = sign-in is
   *  inside the TUI (no command to show). */
  command: string | null
  /** Missing-CLI hint. Null = the generic readiness copy applies. */
  installHint: string | null
  /** Installed-but-signed-out hint. Null = the generic copy applies. */
  signedOutHint: string | null
}

/**
 * Per-harness PRESENTATION (browser-safe): everything a client needs to draw
 * a harness it has never heard of, except the machine-varying availability
 * the served report overlays and the implemented flags the registry derives
 * at generation time. `capabilities` are deliberately NOT stated here: the
 * bundled snapshot is GENERATED from the manifests (scripts/
 * harness-descriptors.ts, harness-matrix.ts pattern), so drift is impossible
 * rather than merely detected. `label` is the picker label, `shortLabel`
 * the menu label (`New ${shortLabel}`).
 */
export interface HarnessDescriptorData {
  kind: BuiltinHarnessKind
  /** Vendor backend label the Accounts hub reads (POD-4529, spec §4.4): the
   *  single-backend CLIs name their vendor; harnesses that route to many
   *  backends name themselves. Podium API-key policy (`MANAGED_KEY_PROVIDERS`
   *  in apps/server) is separate — this is Descriptor knowledge (lane 4.1). */
  provider: string
  label: string
  shortLabel: string
  icon: HarnessIconData
  /** Null = neutral chip (inherits the surrounding tone). */
  brand: HarnessBrandTone | null
  login: HarnessLoginCopy
  defaults: { model: string | null; effort: string | null }
}

/**
 * Per-harness STATIC CATALOG (browser-safe): the fallback lists a picker
 * shows before any live probe answers, plus the live-merge rule as data.
 * Uniform today (`live-wins-when-non-empty`: a non-empty live list replaces
 * the static one); spelled per harness so the rule can vary without a
 * schema change.
 */
export interface HarnessCatalogData {
  kind: BuiltinHarnessKind
  models: StaticModelEntry[]
  /** Reasoning-effort ladder values (labels come from the shared table in
   *  the browser entry — effort spellings are not vendor behaviour). */
  efforts: string[]
  liveMerge: string
}

/** The one live-merge rule clients implement today. */
export const LIVE_MERGE_LIVE_WINS_WHEN_NON_EMPTY = 'live-wins-when-non-empty'
