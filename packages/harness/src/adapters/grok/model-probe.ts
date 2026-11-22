import type { ModelChoice } from '../../model-probe.js'
import { GrokModelState, grokModelEfforts } from './model-state.js'

/**
 * Grok's model-probe statement (POD-4737 D3): the probe argv plus the parser
 * for its output shape, beside the adapter that owns them. The orchestration
 * (exec, timeout, fan-out in `model-probe.ts`) reads these; nothing restates
 * the binary or the grammar anywhere else.
 */

/** ACP initialize reports models and effort choices without opening a session. */
export const grokModelProbeArgv = ['grok', 'agent', '--no-leader', 'stdio'] as const
export const grokModelProbeInput = `${JSON.stringify({
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: 1,
    clientInfo: { name: 'Podium', version: '1' },
    clientCapabilities: {},
  },
})}\n`

/** Read ACP metadata, retaining support for older plain model reports. */
export function parseGrokModels(out: string): ModelChoice[] {
  for (const line of out.split('\n')) {
    try {
      const frame = JSON.parse(line) as { result?: { _meta?: { modelState?: unknown } } }
      const parsed = GrokModelState.safeParse(frame.result?._meta?.modelState)
      if (parsed.success)
        return parsed.data.availableModels.map((model) => ({
          value: model.modelId,
          label: model.name ?? model.modelId,
          efforts: grokModelEfforts(model),
        }))
    } catch {
      // Older plain-text model reports remain readable.
    }
  }
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
