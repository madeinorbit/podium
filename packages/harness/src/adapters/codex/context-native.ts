/** Codex 0.169.0 native telemetry (POD-7396). All native field rules and
 * arithmetic live in the adapter. No model-name capacity fallback is valid. */
import { type ContextCapacity, ContextLastRequest } from '@podium/model'

export const CODEX_CONTEXT_VERSION = '0.169.0'
export type CodexContextSource = 'app-server' | 'rollout'

export function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}
export function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= 256
    ? value
    : undefined
}
export function count(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined
}
export function nativeTime(value: unknown): string | undefined {
  const time =
    typeof value === 'number' ? value : typeof value === 'string' ? Date.parse(value) : NaN
  return Number.isFinite(time) && time >= 0 && time <= 8.64e15
    ? new Date(time).toISOString()
    : undefined
}
export function codexContextVersion(value: unknown): boolean {
  return value === CODEX_CONTEXT_VERSION
}

/** Field names differ by transport, but the native inclusive/subset semantics
 * are the same. Null and absence stay unknown; observed zero is preserved. */
export function decodeCodexUsage(raw: unknown, source: CodexContextSource) {
  const usage = object(raw)
  if (!usage) return undefined
  const names =
    source === 'app-server'
      ? [
          'totalTokens',
          'inputTokens',
          'cachedInputTokens',
          'cacheWriteInputTokens',
          'outputTokens',
          'reasoningOutputTokens',
        ]
      : [
          'total_tokens',
          'input_tokens',
          'cached_input_tokens',
          'cache_write_input_tokens',
          'output_tokens',
          'reasoning_output_tokens',
        ]
  const values = names.map((name) => count(usage[name]))
  if (names.some((name, index) => usage[name] != null && values[index] === undefined))
    return undefined
  const [total, input, cacheRead, cacheWrite, output, reasoning] = values
  if (total === undefined) return undefined
  return { total, input, cacheRead, cacheWrite, output, reasoning }
}
export type CodexUsage = NonNullable<ReturnType<typeof decodeCodexUsage>>

export function codexCapacity(
  raw: unknown,
  source: CodexContextSource,
): ContextCapacity | undefined {
  const value = count(raw)
  return value && value > 0
    ? {
        value,
        basis: 'native',
        accuracy: 'reported',
        source: `Codex ${source} effective context window`,
      }
    : undefined
}

export function zeroComponents(usage: CodexUsage): boolean {
  return [usage.input, usage.cacheRead, usage.cacheWrite, usage.output, usage.reasoning].every(
    (v) => v === 0,
  )
}

export function codexRequestAccounting(
  usage: CodexUsage,
  source: CodexContextSource,
): ContextLastRequest | undefined {
  // Only the zero cache-write branch has runtime evidence. An unverified
  // nonzero variant must not be presented as a proven disjoint input subset.
  if (usage.cacheWrite !== undefined && usage.cacheWrite !== 0) return undefined
  if (zeroComponents(usage)) return undefined
  if (
    usage.input !== undefined &&
    usage.output !== undefined &&
    usage.input + usage.output !== usage.total
  )
    return undefined
  const reported = (value: number) => ({
    value,
    accuracy: 'reported' as const,
    source: `Codex ${source} latest request usage`,
  })
  const fields = {
    ...(usage.input !== undefined ? { input: reported(usage.input) } : {}),
    ...(usage.output !== undefined ? { output: reported(usage.output) } : {}),
    ...(usage.cacheRead !== undefined ? { cacheRead: reported(usage.cacheRead) } : {}),
    ...(usage.cacheWrite !== undefined ? { cacheWrite: reported(usage.cacheWrite) } : {}),
    ...(usage.reasoning !== undefined ? { reasoning: reported(usage.reasoning) } : {}),
  }
  const result = ContextLastRequest.safeParse(fields)
  return result.success ? result.data : undefined
}
