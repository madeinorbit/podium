import type { ModelChoice } from '../../model-probe.js'

/**
 * Grok's model-probe statement (POD-4737 D3): the probe argv plus the parser
 * for its output shape, beside the adapter that owns them. The orchestration
 * (exec, timeout, fan-out in `model-probe.ts`) reads these; nothing restates
 * the binary or the grammar anywhere else.
 */

/** `grok models` — a marker list under "Available models:". */
export const grokModelProbeArgv = ['grok', 'models'] as const

/** grok models → a marker list under "Available models:" (`* id (default)` / `- id`). */
export function parseGrokModels(out: string): ModelChoice[] {
  const models: ModelChoice[] = []
  let inList = false
  for (const raw of out.split('\n')) {
    if (/^available models:/i.test(raw.trim())) {
      inList = true
      continue
    }
    if (!inList) continue
    const m = raw.match(/^\s*[*-]\s+(\S+)/)
    if (m?.[1]) models.push({ value: m[1], label: m[1] })
  }
  return models
}
