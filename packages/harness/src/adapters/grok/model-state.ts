import { z } from 'zod'

/** ACP initialize and session responses report model-specific effort choices. */
export const GrokModelState = z
  .object({
    currentModelId: z.string(),
    availableModels: z.array(
      z
        .object({
          modelId: z.string(),
          name: z.string().optional(),
          _meta: z
            .object({
              supportsReasoningEffort: z.boolean().optional(),
              reasoningEffort: z.string().optional(),
              reasoningEfforts: z
                .array(
                  z.object({
                    id: z.string().optional(),
                    value: z.string().optional(),
                    default: z.boolean().optional(),
                  }),
                )
                .optional(),
            })
            .passthrough()
            .optional(),
        })
        .passthrough(),
    ),
  })
  .passthrough()
export type GrokModelState = z.infer<typeof GrokModelState>

export function grokModelEfforts(model: GrokModelState['availableModels'][number]): string[] {
  if (model._meta?.supportsReasoningEffort !== true) return []
  return model._meta.reasoningEfforts?.flatMap((option) => option.value ?? option.id ?? []) ?? []
}
