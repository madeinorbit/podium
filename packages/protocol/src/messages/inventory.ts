import { Inventory, MachineIdField } from '@podium/model'
import { z } from 'zod'

/**
 * Maximum age of a model list shown in a selector.
 *
 * Shared by the server SWR cache and every web/mobile client so one layer cannot
 * quietly keep a catalog "fresh" longer than another layer promises to recheck it.
 * Probing shells out to every installed harness, so five minutes keeps new models
 * prompt without turning each menu open into a process fan-out.
 */
export const MODEL_CATALOG_MAX_AGE_MS = 5 * 60_000

// AgentInventory / ToolInventory / Inventory live in @podium/model (POD-300),
// inside the per-machine fact group. What stays here is the FRAMES.

/** One selectable model. Mirrors `ModelChoice` in @podium/harness. */
export const ModelChoiceWire = z.object({
  value: z.string(),
  label: z.string(),
  /** Effort levels this model supports when the source reports them
   *  authoritatively; absent = unknown (the web falls back to its agent-level list). */
  efforts: z.array(z.string()).optional(),
})
export type ModelChoiceWire = z.infer<typeof ModelChoiceWire>

// ── Served harness descriptor (POD-4475, spec §4.2/§4.7) ────────────────────
// DATA, never code: label, brand, icon, catalog, login copy and the client
// subset of capability flags. The object strips unknown keys on parse
// (default zod behaviour) so a newer daemon's extra fields never break an
// older client; every field but the identity/capability/catalog core is
// optional so a missing one still renders. `liveMerge` and `schemaVersion`
// are plain data the client matches by value with a documented default — a
// newer spelling parses and renders the fields the client already knows.

/** Chip ground + mark ink as hex/rgba strings (mobile KIND_TONE verbatim). */
export const HarnessDescriptorBrandWire = z.object({
  bg: z.string().min(1),
  fg: z.string().min(1),
})
export type HarnessDescriptorBrandWire = z.infer<typeof HarnessDescriptorBrandWire>

/** Serializable mark: the brand path clients draw with their own svg element. */
export const HarnessDescriptorIconWire = z.object({
  id: z.string().min(1),
  viewBox: z.string().min(1),
  d: z.string().min(1),
})
export type HarnessDescriptorIconWire = z.infer<typeof HarnessDescriptorIconWire>

/**
 * The CLIENT subset of implemented flags (§4.7 fact one). Daemon-internal
 * capabilities (hook layout, observation protocol, driver families) are never
 * served: the client needs to know which controls to draw, not how the
 * machine drives them.
 */
export const HarnessDescriptorCapabilitiesWire = z.object({
  argvPrompt: z.boolean(),
  effort: z.boolean(),
  systemPrompt: z.boolean(),
})
export type HarnessDescriptorCapabilitiesWire = z.infer<typeof HarnessDescriptorCapabilitiesWire>

/** Static catalog + the live-merge rule as data (uniform today, widenable). */
export const HarnessDescriptorCatalogWire = z.object({
  models: z.array(ModelChoiceWire),
  efforts: z.array(z.string()),
  liveMerge: z.string(),
})
export type HarnessDescriptorCatalogWire = z.infer<typeof HarnessDescriptorCatalogWire>

export const HarnessDescriptorLoginWire = z.object({
  command: z.string().nullish(),
  installHint: z.string().nullish(),
  signedOutHint: z.string().nullish(),
})
export type HarnessDescriptorLoginWire = z.infer<typeof HarnessDescriptorLoginWire>

export const HarnessDescriptorDefaultsWire = z.object({
  model: z.string().nullish(),
  effort: z.string().nullish(),
})
export type HarnessDescriptorDefaultsWire = z.infer<typeof HarnessDescriptorDefaultsWire>

/** §4.7 fact two: what THIS machine can provide (installed, logged in). */
export const HarnessDescriptorAvailableWire = z.object({
  installed: z.boolean(),
  loggedIn: z.boolean(),
})
export type HarnessDescriptorAvailableWire = z.infer<typeof HarnessDescriptorAvailableWire>

/** One support-matrix row (§4.7 fact one's derivation, reasons omitted). */
export const HarnessDescriptorSectionWire = z.object({
  section: z.string().min(1),
  supported: z.boolean(),
})
export type HarnessDescriptorSectionWire = z.infer<typeof HarnessDescriptorSectionWire>

export const HarnessDescriptorWire = z.object({
  /** Wire schema version. A plain number (not a literal) so a newer version
   *  still parses — the client renders the fields it knows. */
  schemaVersion: z.number(),
  /** OPEN harness id: a kind this build never heard of still renders. */
  kind: z.string().min(1),
  label: z.string().min(1),
  shortLabel: z.string().min(1),
  icon: HarnessDescriptorIconWire,
  /** Null = neutral chip (inherits the surrounding tone). */
  brand: HarnessDescriptorBrandWire.nullish(),
  capabilities: HarnessDescriptorCapabilitiesWire,
  catalog: HarnessDescriptorCatalogWire,
  login: HarnessDescriptorLoginWire.nullish(),
  defaults: HarnessDescriptorDefaultsWire.nullish(),
  /** Absent = unknown (bundled fallback, no machine connected): render enabled. */
  available: HarnessDescriptorAvailableWire.nullish(),
  /** Served-only matrix derivation; absent offline (still renders). */
  sections: z.array(HarnessDescriptorSectionWire).nullish(),
})
export type HarnessDescriptorWire = z.infer<typeof HarnessDescriptorWire>

// daemon -> server: unsolicited right after auth (and on every reconnect), and
// in reply to an inventoryRequest.
export const InventoryReportMessage = z.object({
  type: z.literal('inventoryReport'),
  machineId: MachineIdField,
  inventory: Inventory,
  /**
   * Served harness descriptors, one per harness this daemon's build knows
   * (POD-4475). Optional so a daemon predating the field keeps parsing: the
   * server forwards what it gets and clients fall back to the bundled copy in
   * `@podium/harness/browser` when a machine (or its daemon) has nothing to
   * say. Carries the first two §4.7 capability facts (implemented + available
   * on this machine); effective-for-this-session is never a descriptor field.
   */
  descriptors: z.array(HarnessDescriptorWire).optional(),
})
export type InventoryReportMessage = z.infer<typeof InventoryReportMessage>

// server -> daemon: on-demand refresh (e.g. `podium doctor`, manual refresh).
export const InventoryRequestMessage = z.object({
  type: z.literal('inventoryRequest'),
})
export type InventoryRequestMessage = z.infer<typeof InventoryRequestMessage>

// ── Live model enumeration (POD-1466). Sibling of the inventory pair above, and
// deliberately shaped differently: inventory is a per-machine fact the daemon
// PUSHES on connect and refreshes on a timer, while the model lists are probed
// only when a client opens a picker — so this pair is REQUEST-CORRELATED
// (`requestId`) and settles through the one daemon-request broker.
//
// Which models a harness offers is a fact about the machine whose CLIs answered,
// so only that machine's daemon can produce it. `machineId` is NOT on the wire:
// the answering machine comes from the authenticated transport (daemon-mux), the
// same rule every other daemon frame follows.

// server -> daemon: "probe your local agent CLIs and tell me what they offer".
export const ModelProbeRequestMessage = z.object({
  type: z.literal('modelProbeRequest'),
  requestId: z.string(),
})
export type ModelProbeRequestMessage = z.infer<typeof ModelProbeRequestMessage>

// daemon -> server: the probe's result, keyed by agent kind. An agent that could
// not be enumerated (CLI absent, not logged in, timeout) is simply absent.
export const ModelProbeResultMessage = z.object({
  type: z.literal('modelProbeResult'),
  requestId: z.string(),
  byAgent: z.record(z.string(), z.array(ModelChoiceWire)),
})
export type ModelProbeResultMessage = z.infer<typeof ModelProbeResultMessage>
