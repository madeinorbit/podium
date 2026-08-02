import { Inventory } from '@podium/model'
import { z } from 'zod'

// AgentInventory / ToolInventory / Inventory live in @podium/model (POD-300),
// inside the per-machine fact group. What stays here is the FRAMES.

// daemon -> server: unsolicited right after auth (and on every reconnect), and
// in reply to an inventoryRequest.
export const InventoryReportMessage = z.object({
  type: z.literal('inventoryReport'),
  machineId: z.string(),
  inventory: Inventory,
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

/** One selectable model. Mirrors `ModelChoice` in @podium/harness. */
export const ModelChoiceWire = z.object({
  value: z.string(),
  label: z.string(),
  /** Effort levels this model supports when the source reports them
   *  authoritatively; absent = unknown (the web falls back to its agent-level list). */
  efforts: z.array(z.string()).optional(),
})
export type ModelChoiceWire = z.infer<typeof ModelChoiceWire>

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
