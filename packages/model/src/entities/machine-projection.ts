import { z } from 'zod'
import { MachineIdField } from '../ids'
import { AgentKind } from './agent'

/** Replicated display facts, visible to every member like repo rows (POD-4974
 * decision 1). The principal-scoped live MachineWire keeps operational detail. */
export const MachineProjection = z.object({
  id: MachineIdField,
  name: z.string(),
  loggedOutHarnesses: z.array(AgentKind),
})
export type MachineProjection = z.infer<typeof MachineProjection>
