/**
 * THE FRONT DOOR (ADR 12 D2 steps 1–3 and D8; POD-6273, POD-6360).
 *
 * Every command a transport hands the server passes the same three checks, in
 * this order, whichever path it then takes: the sync write entry point
 * (`sync-write/entry.ts`) for writes to synced data, or the plain path
 * (`plain-command/entry.ts`) for the few commands with no synced effect.
 *
 *   1. the principal, from the transport (the adapter passes it in);
 *   2. the COARSE permission check — may this principal use this command at all,
 *      over this transport (exposure, role floor, the action's role)? It reads
 *      only the contract and the principal, never the input, so it runs BEFORE
 *      parsing and a refused caller learns nothing from validation errors (ADR 3
 *      `errorConsistency`);
 *   3. the input, parsed with the contract's schema.
 *
 * One function per step, shared, so the two paths cannot drift into two answers
 * to "may this caller do this".
 */

import {
  type AnyCommandContract,
  type CommandAction,
  type CommandDef,
  isExposedOn,
  type RoleFloor,
} from '@podium/commands'
import { authorize } from '@podium/model'
import type { z } from 'zod'
import type { CommandPrincipal } from '../command-principal'

/** The transports with an adapter onto a front door. Each literal is spelled the
 *  same in both declaration formats' transport vocabularies. */
export type FrontDoorTransport = 'trpc' | 'cli' | 'mcp' | 'relay'

/** What the coarse check reads of a command: its contract's authority facts. */
export interface FrontDoorCommand {
  readonly action: CommandAction
  readonly roleFloor: RoleFloor
  exposedOn(transport: FrontDoorTransport): boolean
}

/** The front-door view of an ADR 3 `CommandContract`. */
export const contractFrontDoor = (contract: AnyCommandContract): FrontDoorCommand => ({
  action: contract.policy.action,
  roleFloor: contract.policy.roleFloor,
  exposedOn: (transport) => contract.exposure.includes(transport),
})

/** The front-door view of a `defineCommands` entry: version 1 and the `member`
 *  floor, because its format has no field for either. */
export const defFrontDoor = (def: CommandDef): FrontDoorCommand => ({
  action: def.action,
  roleFloor: 'member',
  exposedOn: (transport) => isExposedOn(def, transport),
})

/**
 * Step 2: may this principal use this command at all, over this transport?
 *
 * A system principal is unreachable from every transport (ADR 3 Amendment D21):
 * server-originated work calls its service directly, not through a front door.
 */
export function coarselyPermitted(
  command: FrontDoorCommand,
  principal: CommandPrincipal,
  transport: FrontDoorTransport,
): boolean {
  if (principal.kind === 'system') return false
  if (!command.exposedOn(transport)) return false
  const capability = principal.capability
  if (command.roleFloor === 'admin' && capability.role !== 'admin') return false
  // With no target, `authorize` answers the role question alone: may this role
  // perform this action at all.
  return authorize(capability, command.action) !== 'forbidden'
}

export type ParsedCommandInput =
  | { readonly ok: true; readonly input: unknown }
  | { readonly ok: false; readonly details: string[]; readonly error: z.ZodError }

/** Step 3: parse with the contract's schema. A failure names the input paths only. */
export function parseCommandInput(schema: z.ZodTypeAny, raw: unknown): ParsedCommandInput {
  const parsed = schema.safeParse(raw)
  if (parsed.success) return { ok: true, input: parsed.data }
  return {
    ok: false,
    details: [...new Set(parsed.error.issues.map((issue) => issue.path.join('.')))],
    error: parsed.error,
  }
}
