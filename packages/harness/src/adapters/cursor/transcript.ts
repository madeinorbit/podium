import type { TranscriptItem } from '@podium/model'
import { toolInputPreview } from '../claude-code/transcript.js'
import { SYNTHESIZED_ITEM_ID_PREFIX } from '../../transcript-types.js'
import { safeToolEditJsonFromInput } from '../shared/tool-edit.js'
import { cursorSessionPaths } from '../../cursor/paths.js'
import {
  fileTranscript,
  supported,
  transcriptFileExists,
  type TranscriptSourceInput,
} from '../../manifest.js'

/** Normalize one Cursor agent-transcripts JSONL record into Podium chat items. */
export function cursorRecordToItems(record: unknown): TranscriptItem[] {
  if (!isRecord(record)) return []

  const turnType = stringField(record, 'type')
  if (turnType === 'turn_ended') return []

  const role = stringField(record, 'role')
  if (!role) return []

  const message = recordField(record, 'message')
  const content = message?.content
  switch (role) {
    case 'user':
      return messageItems(record, 'user', content)
    case 'assistant':
      return messageItems(record, 'assistant', content)
    case 'system':
      return []
    default:
      return []
  }
}

function messageItems(
  record: Record<string, unknown>,
  role: 'user' | 'assistant',
  content: unknown,
): TranscriptItem[] {
  const parts = contentParts(content)
  const text = role === 'user' ? userVisibleText(parts.text) : parts.text
  const tags = parts.tags ?? []
  const items: TranscriptItem[] = []
  if (text || tags.length > 0) {
    items.push({
      id: stringField(record, 'id') ?? stringField(record, 'uuid') ?? SYNTHESIZED_ITEM_ID_PREFIX,
      role,
      text,
      ...(tags.length > 0 ? { tags } : {}),
    })
  }
  items.push(...parts.extraItems)
  const recordId = stringField(record, 'id') ?? stringField(record, 'uuid')
  return items.map((item, sub) =>
    recordId && item.id.startsWith(SYNTHESIZED_ITEM_ID_PREFIX)
      ? { ...item, id: `${recordId}:${sub}` }
      : item,
  )
}

function contentParts(content: unknown): {
  text: string
  tags: TranscriptItem['tags']
  extraItems: TranscriptItem[]
} {
  const textParts: string[] = []
  const tags: NonNullable<TranscriptItem['tags']> = []
  const extraItems: TranscriptItem[] = []

  const visit = (part: unknown): void => {
    if (typeof part === 'string') {
      textParts.push(part)
      return
    }
    if (!isRecord(part)) return
    const kind = stringField(part, 'type')
    if (kind === 'text' || kind === 'markdown') {
      const text = stringField(part, 'text') ?? stringField(part, 'content')
      if (text) textParts.push(text)
      return
    }
    if (kind === 'tool_use' || kind === 'tool_call') {
      const item = toolCallItem(part)
      if (item) extraItems.push(item)
      return
    }
    if (kind === 'tool_result' || kind === 'tool_call_result') {
      const item = toolResultItem(part)
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

function toolCallItem(record: Record<string, unknown>): TranscriptItem | undefined {
  const toolName = stringField(record, 'name') ?? stringField(record, 'tool_name')
  if (!toolName) return undefined
  const toolUseId =
    stringField(record, 'id') ??
    stringField(record, 'tool_use_id') ??
    stringField(record, 'tool_call_id')
  const input = record.input ?? record.arguments ?? record.args
  const toolInputJson = safeToolEditJsonFromInput(toolName, input)
  return {
    id: toolUseId ?? SYNTHESIZED_ITEM_ID_PREFIX,
    role: 'tool',
    text: '',
    toolName,
    toolInput: toolInputPreview(input),
    ...(toolInputJson ? { toolInputJson } : {}),
    ...(toolUseId ? { toolUseId } : {}),
  }
}

function toolResultItem(record: Record<string, unknown>): TranscriptItem | undefined {
  const resultText = contentText(record.result ?? record.output ?? record.content)
  if (!resultText) return undefined
  const toolUseId =
    stringField(record, 'tool_use_id') ??
    stringField(record, 'tool_call_id') ??
    stringField(record, 'call_id')
  return {
    id: toolUseId ? `${toolUseId}:out` : SYNTHESIZED_ITEM_ID_PREFIX,
    role: 'tool',
    text: '',
    toolResult: truncate(resultText, 2000),
    ...(toolUseId ? { toolUseId } : {}),
  }
}

function userVisibleText(text: string): string {
  const userQuery = taggedContent(text, 'user_query')
  if (userQuery !== undefined) return userQuery.trim()
  if (isInjectedCursorContext(text)) return ''
  return text
}

function taggedContent(text: string, tag: string): string | undefined {
  const match = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, 'i').exec(text)
  return match?.[1]
}

function isInjectedCursorContext(text: string): boolean {
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

function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max)}...` : s
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

// ---------------------------------------------------------------------------
// Transcript section: file-store grammar + layout (POD-4471), the ONE
// authoritative transcript definition for this harness (spec §4).
// ---------------------------------------------------------------------------


export async function cursorChainPaths(input: TranscriptSourceInput): Promise<string[]> {
  if (!input.resumeValue) return []
  const path = cursorSessionPaths({
    cwd: input.cwd,
    chatId: input.resumeValue,
    ...(input.homeDir !== undefined ? { homeDir: input.homeDir } : {}),
  }).transcriptPath
  return (await transcriptFileExists(path)) ? [path] : []
}

export const cursorTranscript = supported(fileTranscript(cursorChainPaths, cursorRecordToItems))
