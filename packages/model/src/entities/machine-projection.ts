import { z } from 'zod'
import { MachineIdField, UserIdField } from '../ids'
import { AgentKind } from './agent'

/** Replicated display facts, visible to every member like repo rows (POD-4974
 * decision 1). The principal-scoped live MachineWire keeps operational detail. */
export const MachineProjection = z.object({
  id: MachineIdField,
  name: z.string(),
  loggedOutHarnesses: z.array(AgentKind),
  /**
   * The member holding custody, `null` when nobody does (POD-6291). It decides
   * who receives the worktree paths of the tasks homed here (design §4.2), so a
   * custody change is a change of this row: the feed re-sends those tasks to
   * the people whose view moved. Optional for rows written before it existed.
   */
  custodian: UserIdField.nullable().optional(),
})
export type MachineProjection = z.infer<typeof MachineProjection>
