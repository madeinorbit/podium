import type { ModelChoice } from '../../model-probe.js'

/**
 * Pi's model-probe statement (POD-4737 D3): the probe argv plus the parser
 * for its output shape, beside the adapter that owns them. The orchestration
 * (exec, timeout, fan-out in `model-probe.ts`) reads these; nothing restates
 * the binary or the grammar anywhere else.
 */

/** `pi --list-models` — a whitespace table. */
export const piModelProbeArgv = ['pi', '--list-models'] as const

const PI_THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const

/** pi --list-models → a whitespace table `provider model context max-out thinking images`
 *  (verified against pi 0.84.4). The id Podium passes back is `provider/model`, the
 *  form `--model` accepts. A model whose thinking column is `yes` takes every
 *  thinking level; `no` means the effort picker has nothing to offer. */
export function parsePiModels(out: string): ModelChoice[] {
  const models: ModelChoice[] = []
  let inTable = false
  for (const raw of out.split('\n')) {
    const cells = raw.trim().split(/\s+/)
    if (cells.length < 2) continue
    const [provider, model] = cells
    if (!provider || !model) continue
    // Rows count only under the table header; prose ("No models found") never does.
    if (provider === 'provider' && model === 'model') {
      inTable = true
      continue
    }
    if (!inTable) continue
    const thinking = cells[4]
    models.push({
      value: `${provider}/${model}`,
      label: `${provider}/${model}`,
      efforts: thinking === 'yes' ? [...PI_THINKING_LEVELS] : [],
    })
  }
  return models
}
