/**
 * THE AUTOMATION WRITES ON THE SYNC WRITE ENTRY POINT (POD-6418, ADR 12 D2).
 *
 * The family's table, on the sync family builder. Every automation write does
 * database work only: the schedule is validated and re-armed, and the run rows
 * cascade on remove, all in the entry point's one unit of work. What an
 * automation does on a machine happens later, when the scheduler fires it, as a
 * server-originated write (ADR 12 D2), never inside a request.
 *
 * THE TARGET CHECK. The live role floor first (a disabled account is refused).
 * Then, for a write to an existing automation, its OWNER, read now: a member
 * reaches only their own. An automation that does not exist is no target, as in
 * the issue family: the handler answers it (`not-found` for an update, nothing
 * removed for a remove). The service keeps its own owner check behind this one,
 * so an admin, whose scope is every record, still cannot change another
 * person's schedule.
 *
 * OPERATOR-ONLY. The contracts expose these writes on tRPC alone, so the entry
 * point's coarse check refuses them on the relay, the CLI and MCP whatever the
 * envelope says (`trpc.ts` refuses at load to build a contract that grew an
 * agent transport).
 */

import type { AnyCommandContract } from '@podium/commands'
import { asAutomationId } from '@podium/model'
import type { SyncSubmitRefusal } from '@podium/protocol'
import {
  humanWithRoleFloor,
  type SyncFamily,
  type SyncFamilyState,
  type SyncFamilyTargetContext,
} from '../sync-write/family'
import { isNoTarget, NO_TARGET, type SyncWriteTarget } from '../sync-write/registry'
import { AUTOMATION_COMMANDS, type AutomationState } from './registry'
import { AutomationRefusal } from './service'

export const selectAutomationState = (state: SyncFamilyState): AutomationState => ({
  automations: state.modules.automations,
  principal: state.principal,
})

/** The automation an input names, when it names one (every write but `create`). */
const automationIdOf = (input: unknown): string | undefined => {
  const id = (input as { id?: unknown } | null | undefined)?.id
  return typeof id === 'string' ? id : undefined
}

async function automationTarget(
  contract: AnyCommandContract,
  input: unknown,
  ctx: SyncFamilyTargetContext,
): Promise<SyncWriteTarget> {
  const floor = await humanWithRoleFloor(contract, ctx)
  if (floor === undefined || !isNoTarget(floor)) return floor
  const id = automationIdOf(input)
  if (id === undefined) return NO_TARGET
  const owner = await ctx.modules.automations.ownerOf(asAutomationId(id))
  return owner === undefined ? NO_TARGET : { kind: 'owned', id, owner }
}

/** The service's refusals, with their words; anything else propagates. */
export function automationRefusalOf(error: unknown): SyncSubmitRefusal | undefined {
  if (!(error instanceof AutomationRefusal)) return undefined
  return {
    kind: error.kind === 'not-found' ? 'target-not-found' : 'invalid',
    message: error.message,
  }
}

export const AUTOMATION_SYNC_FAMILY: SyncFamily<AutomationState, typeof AUTOMATION_COMMANDS> = {
  family: 'automations',
  service: selectAutomationState,
  commands: AUTOMATION_COMMANDS,
  target: automationTarget,
  refusalOf: automationRefusalOf,
}
