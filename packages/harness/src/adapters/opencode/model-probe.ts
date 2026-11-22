import type { ModelChoice } from '../../model-probe.js'

/**
 * OpenCode's model-probe statement (POD-4737 D3): the probe argv plus the
 * parser for its output shape, beside the adapter that owns them. The
 * orchestration (exec, timeout, fan-out in `model-probe.ts`) reads these;
 * nothing restates the binary or the grammar anywhere else.
 */

/** `opencode models` — one `provider/model` id per line. */
export const opencodeModelProbeArgv = ['opencode', 'models', '--verbose'] as const

/** opencode models → one `provider/model` id per line. */
export function parseOpencodeModels(out: string): ModelChoice[] {
  const models: ModelChoice[] = []
  const lines = out.split('\n')
  for (let index = 0; index < lines.length; index += 1) {
    const raw = lines[index] ?? ''
    const line = raw.trim()
    if (!/^[^\s/]+\/\S+$/.test(line)) continue
    const choice: ModelChoice = { value: line, label: line }
    // --verbose prints one pretty-printed model object after each id.
    // Only its named variants are effort choices; reasoning alone is not a ladder.
    if (lines[index + 1]?.trim() === '{') {
      const end = lines.indexOf('}', index + 2)
      if (end !== -1) {
        try {
          const metadata = JSON.parse(lines.slice(index + 1, end + 1).join('\n')) as {
            variants?: Record<string, { disabled?: boolean }>
          }
          choice.efforts = Object.entries(metadata.variants ?? {})
            .filter(([, variant]) => !variant.disabled)
            .map(([name]) => name)
          index = end
        } catch {
          // Keep the id visible when an older CLI's metadata is unreadable.
        }
      }
    }
    models.push(choice)
  }
  return models
}
