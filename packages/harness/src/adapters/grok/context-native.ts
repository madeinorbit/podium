/** Grok context grammar, scoped to RUN evidence in POD-6574. A schema in
 * ACP is not emission evidence: neither measured build emitted usage_update. */
import {
  ContextLastRequest,
  type ContextQuantity,
  type ContextSampleIdentity,
  type ContextSummary,
} from '@podium/model'

export function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}
export function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= 256
    ? value.trim()
    : undefined
}
export function count(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined
}
function percent(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined
}
export function grokContextVersion(version: unknown): boolean {
  // Positive RUNs, not a claim about every intermediate or future release.
  return version === '1.0.70' || version === '1.0.89'
}
export const quantity = (
  value: number,
  source: string,
  accuracy: ContextQuantity['accuracy'] = 'reported',
): ContextQuantity => ({ value, source, accuracy })
const statusSource = (raw: Record<string, unknown>) =>
  raw.sessionUpdate === 'session_status'
    ? 'grok session_status.context_window'
    : 'grok status-line.context_window'

export function initializeGrokContext(payload: unknown): unknown {
  const raw = object(payload)
  if (!raw) return payload
  const capabilities = object(raw.clientCapabilities)
  return {
    ...raw,
    clientCapabilities: {
      ...capabilities,
      _meta: { ...object(capabilities?._meta), 'x.ai/statusLine': true },
    },
  }
}

/** Every native spelling/variant stays here. The transport forwards opaque
 * frames before its cursor-required transcript normalization drops side feeds. */
export function grokContextUpdate(payload: unknown) {
  const frame = object(payload)
  if (
    !frame ||
    !['session/update', '_x.ai/session/update', '_x.ai/session_notification'].includes(
      String(frame.method),
    )
  )
    return undefined
  const params = object(frame.params)
  const update = object(params?.update)
  if (!params || !update) return undefined
  return { params, update, meta: object(params._meta) }
}

export function grokContextModel(update: Record<string, unknown>): string | undefined {
  if (update.sessionUpdate === 'model_changed') return text(update.model_id)
  if (update.sessionUpdate === 'config_option_update' && Array.isArray(update.configOptions)) {
    const model = update.configOptions.map(object).find((option) => option?.id === 'model')
    return text(model?.currentValue)
  }
  return text(object(update.model)?.id)
}

/** Native new/load configuration is a capacity witness, never a measurement
 * of occupied context. Selection can clear an old sample, not relabel it. */
export function grokSessionContextMetadata(raw: Record<string, unknown>, nativeSessionId: string) {
  const detail = object(object(raw._meta)?.['x.ai/sessionDetail'])
  if (
    (raw.sessionId !== undefined && raw.sessionId !== nativeSessionId) ||
    (detail?.sessionId !== undefined && detail.sessionId !== nativeSessionId) ||
    (raw.sessionId !== nativeSessionId && detail?.sessionId !== nativeSessionId)
  )
    return undefined
  const models = object(raw.models)
  const model = text(models?.currentModelId)
  if (!model) return undefined
  const entry = Array.isArray(models?.availableModels)
    ? models.availableModels.map(object).find((candidate) => candidate?.modelId === model)
    : undefined
  const capacity = count(object(entry?._meta)?.totalContextTokens)
  return {
    model: { modelId: model },
    ...(capacity !== undefined && capacity > 0
      ? {
          effectiveCapacity: {
            ...quantity(capacity, 'grok session new/load matching models._meta.totalContextTokens'),
            basis: 'configured' as const,
          },
        }
      : {}),
  }
}

export function normalizeGrokStatus(
  raw: Record<string, unknown>,
  sample: ContextSampleIdentity,
): Extract<ContextSummary, { status: 'available' }> | undefined {
  const window = object(raw.context_window)
  if (!window) return undefined
  const used = count(window.context_tokens)
  const capacity = count(window.context_window_size)
  const limit = capacity && capacity > 0 ? capacity : undefined
  const reportedPercent = percent(window.used_percentage)
  if (used === undefined && reportedPercent === undefined) return undefined
  const source = statusSource(raw)
  return {
    version: 1,
    status: 'available',
    sample,
    ...grokStatusMetadata(raw),
    occupancy: {
      basis: 'native-estimate',
      ...(used !== undefined
        ? { usedTokens: quantity(used, `${source}.context_tokens`, 'estimated') }
        : {}),
      ...(reportedPercent !== undefined
        ? { percent: quantity(reportedPercent, `${source}.used_percentage`) }
        : used !== undefined && limit !== undefined
          ? {
              percent: quantity(
                (used / limit) * 100,
                'grok adapter used / matching status window',
                'estimated',
              ),
            }
          : {}),
      ...(used !== undefined && limit !== undefined
        ? {
            remainingTokens: quantity(
              Math.max(0, limit - used),
              'grok adapter matching window minus used',
              'estimated',
            ),
          }
        : {}),
    },
  }
}

export function grokStatusMetadata(raw: Record<string, unknown>) {
  const window = object(raw.context_window)
  const capacity = count(window?.context_window_size)
  const model = grokContextModel(raw)
  const threshold = percent(window?.auto_compact_threshold_percent)
  const source = statusSource(raw)
  return {
    ...(model ? { model: { modelId: model } } : {}),
    ...(capacity !== undefined && capacity > 0
      ? {
          effectiveCapacity: {
            ...quantity(capacity, `${source}.context_window_size`),
            basis: 'native' as const,
          },
        }
      : {}),
    ...(threshold !== undefined
      ? {
          compaction: {
            source: `${source}.auto_compact_threshold_percent`,
            thresholdPercent: quantity(threshold, `${source}.auto_compact_threshold_percent`),
          },
        }
      : {}),
  }
}

/** These are foreground turn aggregates. Only a proven one-call, one-turn
 * envelope can be labelled lastRequest; neither total nor subsets feed occupancy. */
export function grokRequestAccounting(
  raw: unknown,
  requestId: string,
  modelId: string,
): ContextLastRequest | undefined {
  const usage = object(raw)
  const models = object(usage?.modelUsage)
  if (
    !usage ||
    usage.modelCalls !== 1 ||
    usage.numTurns !== 1 ||
    !models ||
    Object.keys(models).length !== 1 ||
    !object(models[modelId]) ||
    object(models[modelId])?.modelCalls !== 1
  )
    return undefined
  const source = 'grok single-call prompt usage (inclusive input/output)'
  const value: Record<string, unknown> = { requestId, model: { modelId } }
  for (const [field, native] of [
    ['input', 'inputTokens'],
    ['output', 'outputTokens'],
    ['cacheRead', 'cachedReadTokens'],
    ['cacheWrite', 'cacheCreationTokens'],
    ['reasoning', 'reasoningTokens'],
  ] as const) {
    const number = count(usage[native])
    if (number !== undefined) value[field] = quantity(number, source)
  }
  const parsed = ContextLastRequest.safeParse(value)
  return parsed.success ? parsed.data : undefined
}

/** Disk context is pre-inference in both measured builds. Retain only the
 * independently sourced count as an explicitly stale fallback, never as live
 * occupancy, and never borrow capacity/model from a newer summary.json. */
export function normalizeGrokSignals(
  raw: Record<string, unknown>,
  sample: ContextSampleIdentity,
): Extract<ContextSummary, { status: 'stale' }> | undefined {
  const used = count(raw.contextTokensUsed)
  if (used === undefined) return undefined
  return {
    version: 1,
    status: 'stale',
    sample,
    occupancy: {
      basis: 'native-estimate',
      usedTokens: quantity(
        used,
        'grok signals.json.contextTokensUsed (pre-inference snapshot)',
        'estimated',
      ),
    },
    reason: {
      code: 'lagging-native-snapshot',
      message: 'Grok persisted signals do not measure the latest completed response',
    },
  }
}
