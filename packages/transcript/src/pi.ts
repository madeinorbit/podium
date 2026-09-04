import type { TranscriptItem } from '@podium/model'
import { toolInputPreview } from './claude'
import { contentToText, isRecord, stringField } from './json-util'
import type { HarnessRuntimeObservation } from './runtime'
import { safeToolEditJsonFromInput } from './tool-edit'

/**
 * Normalize one Pi session JSONL entry into Podium chat items.
 *
 * Pi's file is a TREE of entries (`id`/`parentId`), but Podium's chat view reads
 * it as the append order — the active leaf path in every session Podium itself
 * drives (no in-file forks). Entry shapes (pi 0.84.4, `session-format.md`):
 *
 *   {type:'session', …}                          header — not an item
 *   {type:'message', id, parentId, timestamp, message:{role, content, …}}
 *   {type:'model_change' | 'thinking_level_change' | 'session_info' | …}
 *
 * `message.role` ∈ user | assistant | toolResult | bashExecution | custom |
 * branchSummary | compactionSummary. Assistant content parts are `text`,
 * `thinking` (dropped — preview noise) and `toolCall` ({id, name, arguments}).
 */
export function piRecordToItems(record: unknown): TranscriptItem[] {
  if (!isRecord(record)) return []
  if (stringField(record, 'type') !== 'message') return []
  const message = isRecord(record.message) ? record.message : undefined
  if (!message) return []
  const entryId = stringField(record, 'id')
  const ts = stringField(record, 'timestamp') ?? epochIso(message.timestamp)
  const role = stringField(message, 'role')

  switch (role) {
    case 'user':
      return textItem(entryId ?? stableId('pi-user', ts ?? ''), 'user', message.content, ts)
    case 'assistant':
      return assistantItems(entryId, message, ts)
    case 'toolResult': {
      const item = toolResultItem(entryId, message, ts)
      return item ? [item] : []
    }
    case 'bashExecution': {
      const command = stringField(message, 'command')
      if (!command) return []
      const output = typeof message.output === 'string' ? message.output : ''
      const id = entryId ?? stableId('pi-bash', `${command}:${ts ?? ''}`)
      return [
        {
          id,
          role: 'tool',
          text: '',
          toolName: 'bash',
          toolInput: command,
          toolUseId: id,
          ...(ts ? { ts } : {}),
        },
        ...(output.trim()
          ? [
              {
                id: `${id}:result`,
                role: 'tool' as const,
                text: '',
                toolResult: truncate(output.trim(), 2000),
                toolUseId: id,
                ...(ts ? { ts } : {}),
              },
            ]
          : []),
      ]
    }
    case 'custom': {
      // Extension-private state; only entries the extension flagged for display
      // are conversation, and they render as system lines.
      if (message.display !== true) return []
      const text = contentToText(message.content).trim()
      return text
        ? [
            {
              id: entryId ?? stableId('pi-custom', text),
              role: 'system',
              text,
              ...(ts ? { ts } : {}),
            },
          ]
        : []
    }
    case 'compactionSummary':
    case 'branchSummary': {
      const summary = stringField(message, 'summary')
      return summary
        ? [
            {
              id: entryId ?? stableId('pi-summary', summary),
              role: 'system',
              text: summary,
              systemKind: 'recap',
              ...(ts ? { ts } : {}),
            },
          ]
        : []
    }
    default:
      return []
  }
}

/** Pi: the model rides `model_change` entries and every assistant message; the
 *  thinking level (Podium's effort) rides `thinking_level_change`. */
export function piRuntime(record: unknown): HarnessRuntimeObservation {
  if (!isRecord(record)) return {}
  const type = stringField(record, 'type')
  if (type === 'model_change') {
    const provider = stringField(record, 'provider')
    const modelId = stringField(record, 'modelId')
    if (!modelId) return {}
    return { model: provider ? `${provider}/${modelId}` : modelId }
  }
  if (type === 'thinking_level_change') {
    const level = stringField(record, 'thinkingLevel')
    return level ? { effort: level } : {}
  }
  if (type === 'message') {
    const message = isRecord(record.message) ? record.message : undefined
    if (!message || stringField(message, 'role') !== 'assistant') return {}
    const provider = stringField(message, 'provider')
    const model = stringField(message, 'model')
    if (!model) return {}
    return { model: provider ? `${provider}/${model}` : model }
  }
  return {}
}

function assistantItems(
  entryId: string | undefined,
  message: Record<string, unknown>,
  ts: string | undefined,
): TranscriptItem[] {
  const parts = Array.isArray(message.content) ? message.content : [message.content]
  const texts: string[] = []
  const tools: TranscriptItem[] = []
  for (const part of parts) {
    if (typeof part === 'string') {
      texts.push(part)
      continue
    }
    if (!isRecord(part)) continue
    const kind = stringField(part, 'type')
    if (kind === 'text') {
      const text = stringField(part, 'text')
      if (text) texts.push(text)
    } else if (kind === 'toolCall') {
      const toolName = stringField(part, 'name')
      if (!toolName) continue
      const toolUseId = stringField(part, 'id')
      const input = part.arguments
      const toolInputJson = safeToolEditJsonFromInput(toolName, input)
      tools.push({
        id: toolUseId ?? stableId('pi-tool', `${toolName}:${ts ?? ''}`),
        role: 'tool',
        text: '',
        toolName,
        toolInput: toolInputPreview(input),
        ...(toolInputJson ? { toolInputJson } : {}),
        ...(toolUseId ? { toolUseId } : {}),
        ...(ts ? { ts } : {}),
      })
    }
    // 'thinking' parts are collapsed reasoning — dropped from the chat view.
  }
  const text = texts.join('\n').trim()
  const stopReason = stringField(message, 'stopReason')
  const errorMessage = stringField(message, 'errorMessage')
  const items: TranscriptItem[] = []
  if (text || (stopReason === 'error' && errorMessage)) {
    items.push({
      id: entryId ?? stableId('pi-assistant', `${text}:${ts ?? ''}`),
      role: 'assistant',
      text: text || `Error: ${errorMessage}`,
      // 'stop' ends the turn; 'toolUse' is intermediate narration. 'length' and
      // 'error' end it too, but not with a user-facing answer.
      ...(stopReason === 'stop' && text ? { answer: true } : {}),
      ...(ts ? { ts } : {}),
    })
  }
  items.push(...tools)
  return items
}

function toolResultItem(
  entryId: string | undefined,
  message: Record<string, unknown>,
  ts: string | undefined,
): TranscriptItem | undefined {
  const toolUseId = stringField(message, 'toolCallId')
  const resultText = contentToText(message.content).trim()
  const isError = message.isError === true
  if (!resultText && !isError) return undefined
  return {
    id: entryId ?? stableId('pi-tool-result', `${toolUseId ?? ''}:${resultText}`),
    role: 'tool',
    text: '',
    toolResult: truncate(resultText || '(tool error)', 2000),
    ...(toolUseId ? { toolUseId } : {}),
    ...(ts ? { ts } : {}),
  }
}

function textItem(
  id: string,
  role: 'user' | 'assistant',
  content: unknown,
  ts: string | undefined,
): TranscriptItem[] {
  const text = contentToText(content).trim()
  const tags = imageTags(content)
  if (!text && tags.length === 0) return []
  return [{ id, role, text, ...(tags.length > 0 ? { tags } : {}), ...(ts ? { ts } : {}) }]
}

function imageTags(content: unknown): NonNullable<TranscriptItem['tags']> {
  if (!Array.isArray(content)) return []
  return content
    .filter((part) => isRecord(part) && stringField(part, 'type') === 'image')
    .map(() => ({ kind: 'image' as const }))
}

function epochIso(value: unknown): string | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return undefined
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString()
}

function stableId(prefix: string, seed: string): string {
  let hash = 2166136261
  for (let i = 0; i < seed.length; i += 1) {
    hash ^= seed.charCodeAt(i)
    hash = Math.imul(hash, 16777619)
  }
  return `${prefix}-${(hash >>> 0).toString(36)}`
}

function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max)}...` : s
}
