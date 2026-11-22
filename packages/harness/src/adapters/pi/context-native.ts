/** Pi 1.5.0 extension API, measured by POD-7397. No promise for other builds. */
import { ContextLastRequest, type ContextModelIdentity, type ContextQuantity } from '@podium/model'

export const PI_CONTEXT_SCHEMA = 'podium.pi-context.v1'
export const piContextVersion = (value: unknown): value is '1.5.0' => value === '1.5.0'
export const object = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
export const text = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim().length > 0 && value.length <= 256 ? value : undefined
export const count = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined
export const quantity = (
  value: number,
  source: string,
  accuracy: ContextQuantity['accuracy'] = 'reported',
): ContextQuantity => ({ value, source, accuracy })

export function piContextModel(value: unknown): ContextModelIdentity | undefined {
  const raw = object(value)
  const modelId = text(raw?.model ?? raw?.id)
  const providerId = text(raw?.provider)
  return modelId && providerId ? { modelId, providerId } : undefined
}

export function samePiModel(
  a: ContextModelIdentity | undefined,
  b: ContextModelIdentity | undefined,
) {
  return (
    a !== undefined && b !== undefined && a.modelId === b.modelId && a.providerId === b.providerId
  )
}

/** Pi input is uncached; cache read/write are disjoint additional input.
 * reasoning is already inside output. totalTokens and session totals never
 * establish occupancy, nor does an absent counter become zero. */
export function piRequestAccounting(message: unknown): ContextLastRequest | undefined {
  const raw = object(message)
  const usage = object(raw?.usage)
  if (!raw || !usage) return undefined
  const names = ['input', 'output', 'cacheRead', 'cacheWrite', 'reasoning'] as const
  if (names.some((name) => usage[name] !== undefined && count(usage[name]) === undefined))
    return undefined
  const input = count(usage.input)
  const cacheRead = count(usage.cacheRead)
  const cacheWrite = count(usage.cacheWrite)
  // All input components must be known to claim inclusive input.
  const inclusive =
    input !== undefined && cacheRead !== undefined && cacheWrite !== undefined
      ? input + cacheRead + cacheWrite
      : undefined
  const output = count(usage.output)
  const reasoning = count(usage.reasoning)
  const result = ContextLastRequest.safeParse({
    requestId: text(raw.responseId),
    model: piContextModel(raw),
    ...(inclusive !== undefined
      ? { input: quantity(inclusive, 'pi assistant usage input + cacheRead + cacheWrite') }
      : {}),
    ...(output !== undefined ? { output: quantity(output, 'pi assistant usage.output') } : {}),
    ...(cacheRead !== undefined
      ? { cacheRead: quantity(cacheRead, 'pi assistant usage.cacheRead') }
      : {}),
    ...(cacheWrite !== undefined
      ? { cacheWrite: quantity(cacheWrite, 'pi assistant usage.cacheWrite') }
      : {}),
    ...(reasoning !== undefined
      ? { reasoning: quantity(reasoning, 'pi assistant usage.reasoning') }
      : {}),
  })
  return result.success ? result.data : undefined
}

export function piAssistant(value: unknown): Record<string, unknown> | undefined {
  const raw = object(value)
  return raw?.role === 'assistant' && ['stop', 'length', 'toolUse'].includes(String(raw.stopReason))
    ? raw
    : undefined
}
