import type { TranscriptItem, TranscriptTag } from '@podium/protocol'
import { toolInputPreview } from './claude'

/** Normalize one Grok chat_history.jsonl record into Podium chat transcript items. */
export function grokRecordToItems(record: unknown): TranscriptItem[] {
  if (!isRecord(record)) return []
  const kind = normalizeName(stringField(record, 'type') ?? stringField(record, 'role'))
  if (!kind || kind === 'reasoning') return []

  const ts =
    stringField(record, 'timestamp') ??
    stringField(record, 'created_at') ??
    stringField(record, 'createdAt')
  const message = recordField(record, 'message')
  const content = record.content ?? message?.content

  switch (kind) {
    case 'user':
    case 'user_message':
      return messageItems(record, 'user', content, ts)
    case 'assistant':
    case 'assistant_message':
      return messageItems(record, 'assistant', content, ts)
    case 'system':
    case 'system_message':
      // Grok stores its full injected system prompt in chat_history.jsonl. That
      // is useful for export/debugging, but chat mode should mirror the user-visible conversation.
      return []
    case 'tool':
    case 'tool_use':
    case 'tool_call': {
      const call = toolCallItem(record, ts, kind)
      if (call) return [call]
      const result = toolResultItem(record, ts)
      return result ? [result] : []
    }
    case 'tool_result':
    case 'tool_call_result': {
      const result = toolResultItem(record, ts)
      return result ? [result] : []
    }
    default:
      return []
  }
}

function messageItems(
  record: Record<string, unknown>,
  role: 'user' | 'assistant',
  content: unknown,
  ts: string | undefined,
): TranscriptItem[] {
  const parts = contentParts(content, ts)
  const text = role === 'user' ? userVisibleText(parts.text) : parts.text
  const items: TranscriptItem[] = []
  if (text || parts.tags.length > 0) {
    items.push({
      id: baseId(record, `grok-${role}`, `${role}:${ts ?? ''}:${text}`),
      role,
      ...(ts ? { ts } : {}),
      text,
      ...(parts.tags.length > 0 ? { tags: parts.tags } : {}),
    })
  }
  items.push(...parts.extraItems)
  return items
}

function systemItems(
  record: Record<string, unknown>,
  content: unknown,
  ts: string | undefined,
): TranscriptItem[] {
  const text = contentText(content)
  if (!text) return []
  return [
    {
      id: baseId(record, 'grok-system', `system:${ts ?? ''}:${text}`),
      role: 'system',
      ...(ts ? { ts } : {}),
      text,
    },
  ]
}

function contentParts(
  content: unknown,
  ts: string | undefined,
): { text: string; tags: TranscriptTag[]; extraItems: TranscriptItem[] } {
  const textParts: string[] = []
  const tags: TranscriptTag[] = []
  const extraItems: TranscriptItem[] = []

  const visit = (part: unknown): void => {
    if (typeof part === 'string') {
      textParts.push(part)
      return
    }
    if (!isRecord(part)) return
    const kind = normalizeName(stringField(part, 'type'))
    if (kind === 'text' || kind === 'markdown') {
      const text = stringField(part, 'text') ?? stringField(part, 'content')
      if (text) textParts.push(text)
      return
    }
    if (kind === 'image') {
      tags.push({ kind: 'image' })
      return
    }
    if (kind === 'document' || kind === 'file') {
      tags.push({ kind: 'file', ...tagLabel(part) })
      return
    }
    if (kind === 'tool_use' || kind === 'tool_call') {
      const item = toolCallItem(part, ts, kind)
      if (item) extraItems.push(item)
      return
    }
    if (kind === 'tool_result' || kind === 'tool_call_result') {
      const item = toolResultItem(part, ts)
      if (item) extraItems.push(item)
      return
    }
    const text = stringField(part, 'text')
    if (text) textParts.push(text)
  }

  if (Array.isArray(content)) {
    for (const part of content) visit(part)
  } else {
    visit(content)
  }

  return { text: textParts.join('\n').trim(), tags, extraItems }
}

function toolCallItem(
  record: Record<string, unknown>,
  ts: string | undefined,
  fallbackKind: string,
): TranscriptItem | undefined {
  const toolName =
    stringField(record, 'name') ??
    stringField(record, 'tool_name') ??
    stringField(record, 'toolName')
  if (!toolName) return undefined
  const toolUseId =
    stringField(record, 'id') ??
    stringField(record, 'tool_use_id') ??
    stringField(record, 'tool_call_id') ??
    stringField(record, 'call_id')
  return {
    id: toolUseId ?? stableId('grok-tool', `${fallbackKind}:${toolName}:${safeJson(record.input)}`),
    role: 'tool',
    ...(ts ? { ts } : {}),
    text: '',
    toolName,
    toolInput: toolInputPreview(record.input ?? record.arguments ?? record.args),
    ...(toolUseId ? { toolUseId } : {}),
  }
}

function toolResultItem(
  record: Record<string, unknown>,
  ts: string | undefined,
): TranscriptItem | undefined {
  const resultText = contentText(record.result ?? record.output ?? record.content)
  if (!resultText) return undefined
  const toolUseId =
    stringField(record, 'tool_use_id') ??
    stringField(record, 'tool_call_id') ??
    stringField(record, 'call_id')
  return {
    id: baseId(record, 'grok-tool-result', `result:${toolUseId ?? ''}:${resultText}`),
    role: 'tool',
    ...(ts ? { ts } : {}),
    text: '',
    toolResult: truncate(resultText, 2000),
    ...(toolUseId ? { toolUseId } : {}),
  }
}

function userVisibleText(text: string): string {
  const userQuery = taggedContent(text, 'user_query')
  if (userQuery !== undefined) return userQuery.trim()
  if (isInjectedGrokContext(text)) return ''
  return text
}

function taggedContent(text: string, tag: string): string | undefined {
  const match = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, 'i').exec(text)
  return match?.[1]
}

function isInjectedGrokContext(text: string): boolean {
  return /<(user_info|rules|agent_skills|mcp_file_system|system_reminder)(>|\s)/i.test(text)
}

function contentText(content: unknown): string {
  if (typeof content === 'string') return content.trim()
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === 'string') return part
        if (isRecord(part)) {
          if (typeof part.text === 'string') return part.text
          if (typeof part.content === 'string') return part.content
        }
        return ''
      })
      .filter(Boolean)
      .join('\n')
      .trim()
  }
  if (isRecord(content)) {
    return (stringField(content, 'text') ?? stringField(content, 'content') ?? '').trim()
  }
  return ''
}

function tagLabel(record: Record<string, unknown>): { label: string } | Record<string, never> {
  const source = recordField(record, 'source')
  const label =
    stringField(record, 'title') ??
    stringField(record, 'name') ??
    stringField(record, 'path') ??
    stringField(source, 'title') ??
    stringField(source, 'name') ??
    stringField(source, 'path')
  return label ? { label } : {}
}

function baseId(record: Record<string, unknown>, prefix: string, seed: string): string {
  return stringField(record, 'id') ?? stringField(record, 'uuid') ?? stableId(prefix, seed)
}

function stableId(prefix: string, seed: string): string {
  let hash = 2166136261
  for (let i = 0; i < seed.length; i += 1) {
    hash ^= seed.charCodeAt(i)
    hash = Math.imul(hash, 16777619)
  }
  return `${prefix}-${(hash >>> 0).toString(36)}`
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value) ?? ''
  } catch {
    return ''
  }
}

function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max)}...` : s
}

function normalizeName(value: string | undefined): string | undefined {
  return value
    ?.replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/-/g, '_')
    .toLowerCase()
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function recordField(value: unknown, key: string): Record<string, unknown> | undefined {
  if (!isRecord(value)) return undefined
  const field = value[key]
  return isRecord(field) ? field : undefined
}

function stringField(value: unknown, key: string): string | undefined {
  if (!isRecord(value)) return undefined
  const field = value[key]
  return typeof field === 'string' && field.length > 0 ? field : undefined
}
