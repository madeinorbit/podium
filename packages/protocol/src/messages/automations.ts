import { z } from 'zod'

/** How a scheduled fire chooses the agent conversation [spec:SP-17db]. */
export const AutomationSessionMode = z.enum(['fresh', 'resume'])
export type AutomationSessionMode = z.infer<typeof AutomationSessionMode>

export const AutomationRunOutcome = z.enum(['spawned', 'missed', 'skipped_overlap', 'error'])
export type AutomationRunOutcome = z.infer<typeof AutomationRunOutcome>

/** Durable scheduled-automation definition [spec:SP-17db]. */
export const AutomationWire = z.object({
  id: z.string(),
  name: z.string(),
  enabled: z.boolean(),
  repoPath: z.string().nullable(),
  cron: z.string(),
  agentKind: z.string(),
  model: z.string(),
  effort: z.string(),
  prompt: z.string(),
  sessionMode: AutomationSessionMode,
  nextRunAt: z.string().nullable(),
  lastRunAt: z.string().nullable(),
  createdAt: z.string(),
})
export type AutomationWire = z.infer<typeof AutomationWire>

/** Durable record of one scheduled occurrence, including non-spawning outcomes. */
export const AutomationRunWire = z.object({
  id: z.string(),
  automationId: z.string(),
  firedAt: z.string(),
  sessionId: z.string().nullable(),
  outcome: AutomationRunOutcome,
  detail: z.string().nullable(),
})
export type AutomationRunWire = z.infer<typeof AutomationRunWire>

export const AutomationsChangedMessage = z.object({
  type: z.literal('automationsChanged'),
  automations: z.array(AutomationWire),
})

export const AutomationRunsChangedMessage = z.object({
  type: z.literal('automationRunsChanged'),
  automationRuns: z.array(AutomationRunWire),
})
