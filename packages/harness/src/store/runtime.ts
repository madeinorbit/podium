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

/** Read one harness's native record for runtime identity/context facts. One of
 * these per harness; WHICH one applies is the manifest's answer, not a switch
 * here — behaviour keyed on a harness belongs in that harness's declaration
 * (`HarnessTranscript.recordRuntime`), while these parsers stay in browser-safe
 * @podium/transcript (ADR 8 D4.3). */
export type TranscriptRuntimeReader = (record: unknown) => HarnessRuntimeObservation

/** Claude Code: model and effort ride the assistant record. */
export function claudeRuntime(record: unknown): HarnessRuntimeObservation {
  const model = claudeRecordModel(record)
  const effort = claudeRecordEffort(record)
  return {
    ...(model ? { model } : {}),
    ...(effort ? { effort } : {}),
  }
}

/** Codex: model/effort from `turn_context`, context use from `token_count`. */
export function codexRuntime(record: unknown): HarnessRuntimeObservation {
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

/** Grok: the model id, wherever this record carries it. */
export function grokRuntime(record: unknown): HarnessRuntimeObservation {
  if (!isRecord(record)) return {}
  const message = isRecord(record.message) ? record.message : undefined
  const model =
    stringField(record, 'model_id') ??
    stringField(record, 'model') ??
    (message ? (stringField(message, 'model_id') ?? stringField(message, 'model')) : undefined)
  return model ? { model } : {}
}
