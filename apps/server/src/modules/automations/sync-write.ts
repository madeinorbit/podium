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
 * The service then checks the current OWNER, answering a private automation
 * exactly like a missing one (`not-found` for an update, nothing removed for a
 * remove). A generic owned-target refusal would distinguish those cases before
 * the handler and expose another member's automation, including to an admin.
 *
 * OPERATOR-ONLY. The contracts expose these writes on tRPC alone, so the entry
 * point's coarse check refuses them on the relay, the CLI and MCP whatever the
 * envelope says (`trpc.ts` refuses at load to build a contract that grew an
 * agent transport).
 */

import type { SyncSubmitRefusal } from '@podium/protocol'
import { humanWithRoleFloor, type SyncFamily, type SyncFamilyState } from '../sync-write/family'
import { AUTOMATION_COMMANDS, type AutomationState } from './registry'
import { AutomationRefusal } from './service'

export const selectAutomationState = (state: SyncFamilyState): AutomationState => ({
  automations: state.modules.automations,
  principal: state.principal,
  writer: state.writer,
})

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
  target: async (contract, _input, ctx) => await humanWithRoleFloor(contract, ctx),
  refusalOf: automationRefusalOf,
}
