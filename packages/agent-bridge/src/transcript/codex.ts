import type { TranscriptItem } from '@podium/protocol'
import { contentToText, isRecord, stringField } from '../discovery/jsonl.js'
import { toolInputPreview } from './claude.js'

/**
 * Normalize one Codex rollout JSONL record (envelope `{ timestamp, type, payload }`)
 * into Podium chat items.
 *
 * User text: taken from `event_msg.user_message` — the canonical, typed prompt.
 * `response_item` role=user records are ALWAYS duplicates of the paired event_msg
 * (Codex injects them into the model context) or system preamble; either way, skip.
 * `response_item` role=developer is always a permissions/AGENTS preamble; skip.
 * `response_item` role=assistant → assistant message.
 *
 * `function_call` / `custom_tool_call` → tool call (keyed by call_id || id).
 * `function_call_output` / `custom_tool_call_output` → tool result.  Even empty-
 * output records are emitted so callers always see a result paired with each call.
 *
 * `reasoning` (encrypted or plain) → skip explicitly.
 * All other event_msg subtypes (task_started, token_count, agent_message …) → skip.
 */
export function codexRecordToItems(record: unknown): TranscriptItem[] {
  if (!isRecord(record)) return []
  const payload = isRecord(record.payload) ? record.payload : undefined
  if (!payload) return []
  const type = stringField(record, 'type')
  const ptype = stringField(payload, 'type')
  const ts = stringField(record, 'timestamp') ?? stringField(payload, 'timestamp')

  if (type === 'event_msg') {
    if (ptype !== 'user_message') return []
    const text = userMessageText(payload)
    return text
      ? [
          {
            id: stableId('codex-user', `${ts ?? ''}:${text}`),
            role: 'user',
            ...(ts ? { ts } : {}),
            text,
          },
        ]
      : []
  }

  if (type !== 'response_item') return []

  switch (ptype) {
    case 'message': {
      const role = stringField(payload, 'role')
      // developer = permissions/AGENTS preamble; user = event_msg duplicate or env preamble.
      // Both are always covered by a canonical event_msg or are internal-only, so skip.
      if (role !== 'assistant') return []
      const text = contentToText(payload.content).trim()
      return text
        ? [
            {
              id: stableId('codex-assistant', `${ts ?? ''}:${text}`),
              role: 'assistant',
              ...(ts ? { ts } : {}),
              text,
            },
          ]
        : []
    }
    case 'function_call':
    case 'custom_tool_call':
      return [toolCallItem(payload, ts)]
    case 'function_call_output':
    case 'custom_tool_call_output':
      // Always emit the result even when output is empty — callers expect a result
      // for every call and should not silently lose tool turns.
      return [toolResultItem(payload, ts)]
    case 'reasoning':
      // Encrypted or plain reasoning blobs — internal to the model, not chat content.
      return []
    default:
      return []
  }
}

function userMessageText(payload: Record<string, unknown>): string {
  return (stringField(payload, 'message') ?? contentToText(payload.text_elements)).trim()
}

function toolCallItem(payload: Record<string, unknown>, ts: string | undefined): TranscriptItem {
  const toolName = stringField(payload, 'name') ?? 'tool'
  const callId = stringField(payload, 'call_id') ?? stringField(payload, 'id')
  return {
    id: callId ?? stableId('codex-tool', `${toolName}:${ts ?? ''}`),
    role: 'tool',
    ...(ts ? { ts } : {}),
    text: '',
    toolName,
    toolInput: toolInputPreview(parseArgs(payload.arguments ?? payload.input)),
    ...(callId ? { toolUseId: callId } : {}),
  }
}

function toolResultItem(
  payload: Record<string, unknown>,
  ts: string | undefined,
): TranscriptItem {
  const out = payload.output
  const text = (typeof out === 'string' ? out : contentToText(out)).trim()
  const callId = stringField(payload, 'call_id') ?? stringField(payload, 'id')
  return {
    id: callId ? `${callId}:out` : stableId('codex-tool-result', `${ts ?? ''}:${text}`),
    role: 'tool',
    ...(ts ? { ts } : {}),
    text: '',
    // Always set toolResult, even when empty — callers rely on the item being present.
    toolResult: truncate(text, 2000),
    ...(callId ? { toolUseId: callId } : {}),
  }
}

function parseArgs(value: unknown): unknown {
  if (typeof value !== 'string') return value
  try {
    return JSON.parse(value)
  } catch {
    return value
  }
}

function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max)}...` : s
}

function stableId(prefix: string, seed: string): string {
  let hash = 2166136261
  for (let i = 0; i < seed.length; i += 1) {
    hash ^= seed.charCodeAt(i)
    hash = Math.imul(hash, 16777619)
  }
  return `${prefix}-${(hash >>> 0).toString(36)}`
}
