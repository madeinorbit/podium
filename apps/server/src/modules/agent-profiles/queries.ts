/**
 * THE AGENT-PROFILE READS — `list`, `show`, `export` (POD-6107). A table rather
 * than read contracts: a `visibility` class describes what a command WRITES.
 * Every member may read every profile (the row is deployment substrate), and an
 * agent may read them too — it picks profiles, it just cannot edit them.
 */

import { AgentProfileRef, type TransportTag } from '@podium/commands'
import { z } from 'zod'
import type { AgentProfileState } from './registry'

const SERVED_ON: readonly TransportTag[] = ['trpc']

export interface AgentProfileQuery<In extends z.ZodTypeAny, Out> {
  readonly input: In
  readonly exposure: readonly TransportTag[]
  readonly run: (state: AgentProfileState, input: z.infer<In>) => Out
}

const query = <In extends z.ZodTypeAny, Out>(
  input: In,
  run: (state: AgentProfileState, input: z.infer<In>) => Out,
): AgentProfileQuery<In, Out> => ({ input, exposure: SERVED_ON, run })

export const AGENT_PROFILE_QUERIES = {
  list: query(z.object({}).passthrough().optional(), async (state) => await state.profiles.list()),
  show: query(z.object({ ref: AgentProfileRef }), async (state, input) => await state.profiles.show(input.ref)),
  /** `.podium/agents/<name>.md` texts; the CLI writes the files. */
  export: query(
    z.object({ ref: AgentProfileRef.optional() }).optional(),
    async (state, input) => await state.profiles.export(input?.ref),
  ),
} as const

export type AgentProfileQueryName = keyof typeof AGENT_PROFILE_QUERIES
