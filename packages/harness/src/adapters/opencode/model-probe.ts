import type { ModelChoice } from '../../model-probe.js'

/**
 * OpenCode's model-probe statement (POD-4737 D3): the probe argv plus the
 * parser for its output shape, beside the adapter that owns them. The
 * orchestration (exec, timeout, fan-out in `model-probe.ts`) reads these;
 * nothing restates the binary or the grammar anywhere else.
 */

/** `opencode models` — one `provider/model` id per line. */
export const opencodeModelProbeArgv = ['opencode', 'models'] as const

/** opencode models → one `provider/model` id per line. */
export function parseOpencodeModels(out: string): ModelChoice[] {
  const models: ModelChoice[] = []
  for (const raw of out.split('\n')) {
    const line = raw.trim()
    if (/^[^\s/]+\/\S+$/.test(line)) models.push({ value: line, label: line })
  }
  return models
}
