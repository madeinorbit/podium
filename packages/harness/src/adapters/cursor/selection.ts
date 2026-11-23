import type { HarnessHeadless } from '../../manifest.js'
import { probeAgentModels } from '../../model-probe.js'
import { cursorEffortVariant, cursorModelEffort } from './model-variants.js'

type SelectionInput = Parameters<NonNullable<HarnessHeadless['resolveSelection']>>[0]

export async function resolveCursorSelection(
  input: SelectionInput,
  probe = probeAgentModels,
): Promise<{ model?: string; effort?: string }> {
  if (
    !input.effort ||
    input.effort === 'auto' ||
    cursorModelEffort(input.model ?? '') === input.effort
  ) {
    return { model: input.model, effort: input.effort }
  }
  const models = await probe('cursor', {
    contexts: { cursor: { installation: input.installation, env: input.env } },
  })
  const model = cursorEffortVariant(models, input.model ?? 'auto', input.effort)
  if (!model) throw new Error('Cursor did not report a model variant for this effort')
  return { model, effort: input.effort }
}
