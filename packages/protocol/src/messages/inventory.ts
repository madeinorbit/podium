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
