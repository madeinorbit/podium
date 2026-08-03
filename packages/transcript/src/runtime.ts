import { claudeRecordEffort, claudeRecordModel } from './claude'
import { isRecord, stringField } from './json-util'

/** Runtime facts observed in a harness-native transcript record. Every field is
 * optional because harnesses expose different subsets. In particular, context
 * usage is emitted only when the transcript carries both used tokens and the
 * exact context-window size; Podium does not guess model capacities. */
export interface HarnessRuntimeObservation {
  model?: string
  effort?: string
  contextUsagePercent?: number
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function codexRuntime(record: unknown): HarnessRuntimeObservation {
  if (!isRecord(record)) return {}
  const payload = isRecord(record.payload) ? record.payload : undefined
  if (!payload) return {}

  if (record.type === 'turn_context') {
    const model = stringField(payload, 'model')
    const effort = stringField(payload, 'effort') ?? stringField(payload, 'reasoning_effort')
    return {
      ...(model ? { model } : {}),
      ...(effort ? { effort } : {}),
    }
  }

  if (record.type !== 'event_msg' || payload.type !== 'token_count') return {}
  const info = isRecord(payload.info) ? payload.info : undefined
  const usage = info && isRecord(info.total_token_usage) ? info.total_token_usage : undefined
  const used = usage ? finiteNumber(usage.total_tokens) : undefined
  const window = info ? finiteNumber(info.model_context_window) : undefined
  if (used === undefined || window === undefined || window <= 0) return {}
  const percent = Math.min(100, Math.max(0, (used / window) * 100))
  return { contextUsagePercent: Math.round(percent * 10) / 10 }
}

function grokRuntime(record: unknown): HarnessRuntimeObservation {
  if (!isRecord(record)) return {}
  const message = isRecord(record.message) ? record.message : undefined
  const model =
    stringField(record, 'model_id') ??
    stringField(record, 'model') ??
    (message ? (stringField(message, 'model_id') ?? stringField(message, 'model')) : undefined)
  return model ? { model } : {}
}

/** Extract actual runtime identity/context facts for one harness record. */
export function recordRuntimeForKind(
  agentKind: string,
  record: unknown,
): HarnessRuntimeObservation {
  switch (agentKind) {
    case 'claude-code': {
      const model = claudeRecordModel(record)
      const effort = claudeRecordEffort(record)
      return {
        ...(model ? { model } : {}),
        ...(effort ? { effort } : {}),
      }
    }
    case 'codex':
      return codexRuntime(record)
    case 'grok':
      return grokRuntime(record)
    default:
      return {}
  }
}
