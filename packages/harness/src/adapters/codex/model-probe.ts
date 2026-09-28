import type { ModelChoice } from '../../model-probe.js'

/**
 * Codex's model-probe statement (POD-4737 D3): the probe argv plus the parser
 * for its output shape, beside the adapter that owns them. The orchestration
 * (exec, timeout, fan-out in `model-probe.ts`) reads these; nothing restates
 * the binary or the grammar anywhere else.
 */

/**
 * `codex debug models` (JSON; the only non-interactive path — `codex models`
 * forwards to the TUI).
 */
export const codexModelProbeArgv = ['codex', 'debug', 'models'] as const

/** codex debug models → `{ models: [{ slug, display_name, visibility, priority }] }`.
 *  Keep only user-selectable models (`visibility === 'list'` drops internal ones like
 *  codex-auto-review), ordered by the CLI's own priority. */
export function parseCodexModels(out: string): ModelChoice[] {
  try {
    const parsed = JSON.parse(out) as {
      models?: Array<{
        slug?: string
        display_name?: string
        visibility?: string
        priority?: number
        supported_reasoning_levels?: Array<{ effort?: unknown }>
      }>
    }
    return (parsed.models ?? [])
      .filter(
        (
          m,
        ): m is {
          slug: string
          display_name?: string
          priority?: number
          supported_reasoning_levels?: Array<{ effort?: unknown }>
        } => Boolean(m.slug && m.visibility === 'list'),
      )
      .sort(
        (a, b) => (a.priority ?? Number.MAX_SAFE_INTEGER) - (b.priority ?? Number.MAX_SAFE_INTEGER),
      )
      .map((m) => ({
        value: m.slug,
        label: m.display_name || m.slug,
        // Per-model effort from the CLI's own catalog (authoritative).
        efforts: (m.supported_reasoning_levels ?? [])
          .map((r) => r.effort)
          .filter((e): e is string => typeof e === 'string'),
      }))
  } catch {
    return []
  }
}
