import { z } from 'zod'
import { HarnessAgent } from './harness'

// Machine inventory (#222): what a daemon's host can actually run. Built by the
// daemon (packages/agent-bridge buildInventory) and pushed AFTER the handshake
// authenticates — never inside pair/hello, which must stay fast and pre-auth.

/** One agent CLI's install + login status on the daemon's machine. */
export const AgentInventory = z.object({
  kind: HarnessAgent,
  installed: z.boolean(),
  /** Parsed from `<cli> --version`; absent when not installed / parse failed. */
  version: z.string().optional(),
  /** Resolved binary path when installed (may be a bare PATH name). */
  path: z.string().optional(),
  login: z.object({
    /** 'unknown' for kinds with no credential detector (opencode, cursor). */
    state: z.enum(['in', 'out', 'unknown']),
    /** Email / account label when known (claude, codex, grok). */
    account: z.string().optional(),
  }),
})
export type AgentInventory = z.infer<typeof AgentInventory>

/** A non-harness CLI the host may carry. `gh` (#214) is the first consumer:
 *  its credential-propagation form needs to know a machine has gh on PATH. */
export const ToolInventory = z.object({
  name: z.string(),
  installed: z.boolean(),
  /** Parsed from `<name> --version`; absent when not installed / parse failed. */
  version: z.string().optional(),
  /** Resolved binary path when installed (may be a bare PATH name). */
  path: z.string().optional(),
})
export type ToolInventory = z.infer<typeof ToolInventory>

export const Inventory = z.object({
  os: z.enum(['linux', 'darwin']),
  arch: z.enum(['x64', 'arm64']),
  /** Absent until #221 ships `podium --version`. */
  podiumVersion: z.string().optional(),
  /** All 5 HarnessAgent kinds, present or not. */
  agents: z.array(AgentInventory),
  /** Non-harness CLIs (currently just `gh` for #214). Defaulted so an
   *  inventory_json blob persisted before this field parses back cleanly. */
  tools: z.array(ToolInventory).default([]),
})
export type Inventory = z.infer<typeof Inventory>

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
