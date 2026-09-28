import type { ModelChoice } from '../../model-probe.js'

/**
 * Cursor's model-probe statement (POD-4737 D3): the probe argv plus the
 * parser for its output shape, beside the adapter that owns them. The
 * orchestration (exec, timeout, fan-out in `model-probe.ts`) reads these;
 * nothing restates the binary or the grammar anywhere else.
 */

/** `cursor-agent models` — `id - Label` lines. */
export const cursorModelProbeArgv = ['cursor-agent', 'models'] as const

/** cursor-agent models → `id - Label` lines. Drops `auto` (the picker adds its own
 *  sentinel) and strips trailing "(current)"/"(default)" markers. */
export function parseCursorModels(out: string): ModelChoice[] {
  const models: ModelChoice[] = []
  for (const raw of out.split('\n')) {
    const m = raw.match(/^([A-Za-z0-9][\w.:/-]*)\s+-\s+(.+)$/)
    if (!m?.[1]) continue
    const value = m[1]
    if (value === 'auto') continue
    const label = (m[2] ?? '').replace(/\s*\((?:current|default)\)\s*$/i, '').trim()
    models.push({ value, label: label || value })
  }
  return models
}
