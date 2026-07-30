import { AutomationRunWire, AutomationWire } from '@podium/model'
import { z } from 'zod'

// The automation and automation-run entities live in @podium/model (POD-300) —
// they ride metadataDelta, so sync.ts's MetadataEntityKind names them as
// replicated entities. What stays here is the carrier FRAMES.

export const AutomationsChangedMessage = z.object({
  type: z.literal('automationsChanged'),
  automations: z.array(AutomationWire),
})

export const AutomationRunsChangedMessage = z.object({
  type: z.literal('automationRunsChanged'),
  automationRuns: z.array(AutomationRunWire),
})
