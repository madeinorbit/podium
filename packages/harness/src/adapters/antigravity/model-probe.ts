import { stripVTControlCharacters } from 'node:util'
import type { ModelChoice } from '../../model-probe.js'

/** The installed CLI still rejects --output-format for this subcommand. */
export const antigravityModelProbeArgv = ['agy', 'models'] as const

export function parseAntigravityModels(output: string): ModelChoice[] {
  const models = new Map<string, ModelChoice>()
  for (const line of stripVTControlCharacters(output).split('\n')) {
    const label = line
      .trim()
      .replace(/^[*•-]\s+/u, '')
      .replace(/\s+\(default\)$/iu, '')
    if (!label || /^(available models|models|name|model|[-=]+)\s*:?$/iu.test(label)) continue
    // Native output is one display name per line. Reject auth chatter rather
    // than offering an OAuth URL or an error sentence as a model.
    if (!/^(?:Gemini|Claude|GPT|OpenAI)\s+\S/iu.test(label)) continue
    const effort = /\s+\((Low|Medium|High|XHigh|Max)\)$/iu.exec(label)?.[1]?.toLowerCase()
    models.set(label, { value: label, label, ...(effort ? { efforts: [effort] } : {}) })
  }
  return [...models.values()]
}
